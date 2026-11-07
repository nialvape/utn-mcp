import { HttpError } from "./http.js";
import { logger } from "./logger.js";

export interface RetryPolicy {
    operation?: string;
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    totalTimeoutMs?: number;
    isTransient?: (error: unknown) => boolean;
    signal?: AbortSignal;
    onRetry?: (event: RetryEvent) => void;
}

export interface RetryEvent {
    operation: string;
    attempt: number;
    delayMs: number;
    errorName: string;
    status?: number;
}

export function isTransientError(error: unknown): boolean {
    if (!(error instanceof HttpError)) return false;
    if (error.status === undefined) return error.cause !== undefined;
    return error.status === 408 || error.status === 429 || error.status >= 500;
}

export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy = {}): Promise<T> {
    const {
        operation: name = "operación",
        attempts = 3,
        baseDelayMs = 1000,
        maxDelayMs = 8000,
        totalTimeoutMs = 60_000,
        isTransient = isTransientError,
        signal,
        onRetry = logRetry,
    } = policy;
    const maxAttempts = Math.max(1, Math.floor(attempts) || 1);
    const deadline = Date.now() + totalTimeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
            if (lastError !== undefined) break;
            throw new Error("cancelado");
        }
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === maxAttempts || !isTransient(error)) throw error;
            let delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
            const retryAfter = error instanceof HttpError ? error.retryAfterMs : undefined;
            if (retryAfter !== undefined) delayMs = Math.max(delayMs, retryAfter);
            if (Date.now() + delayMs > deadline) throw error;
            onRetry({
                operation: name,
                attempt,
                delayMs,
                errorName: (error as Error).name,
                status: error instanceof HttpError ? error.status : undefined,
            });
            try {
                await sleep(delayMs, signal);
            } catch {
                break;
            }
        }
    }
    throw lastError;
}

export function retry(policy: RetryPolicy = {}) {
    return function <Args extends unknown[], Result>(
        method: (...args: Args) => Promise<Result>,
        context: ClassMethodDecoratorContext,
    ): (...args: Args) => Promise<Result> {
        const operation = policy.operation ?? String(context.name);
        return async function (this: unknown, ...args: Args): Promise<Result> {
            return withRetry(() => method.apply(this, args), { ...policy, operation });
        };
    };
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponential = baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * Math.min(exponential, maxDelayMs));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("cancelado"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("cancelado"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

const logRetry = (event: RetryEvent): void =>
    logger.warn(
        `Reintento ${event.attempt} de ${event.operation} en ${event.delayMs} ms ` +
            `por ${event.errorName}${event.status ? ` HTTP ${event.status}` : ""}.`,
    );
