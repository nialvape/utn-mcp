import { HttpError } from "./http.js";
import { logger } from "./logger.js";

/** Cómo reintentar una operación; todo es opcional y tiene default en `withRetry`. */
export interface RetryPolicy {
    /** Nombre para los logs (por ejemplo "sysacad examenes"). */
    operation?: string;
    /** Intentos totales, contando el primero. */
    attempts?: number;
    /** Espera base del backoff, en ms; se duplica en cada intento. */
    baseDelayMs?: number;
    /** Tope de la espera entre intentos, en ms. */
    maxDelayMs?: number;
    /** Presupuesto total en ms: si la próxima espera lo pasa, se corta con el último error. */
    totalTimeoutMs?: number;
    isTransient?: (error: unknown) => boolean;
    signal?: AbortSignal;
    onRetry?: (event: RetryEvent) => void;
}

/** Lo que se informa antes de cada espera. Sin el mensaje del error: puede traer URLs con ids de sesión. */
export interface RetryEvent {
    operation: string;
    attempt: number;
    delayMs: number;
    errorName: string;
    status?: number;
}

/** Se cortó la espera entre intentos con el `AbortSignal` antes de que hubiera un error que devolver. */
export class RetryCancelledError extends Error {
    constructor(operation: string) {
        super(`Se canceló ${operation} antes de terminar.`);
        this.name = "RetryCancelledError";
    }
}

/** Transitorio: 408, 429, 5xx o falla de red/timeout (`HttpError` sin status y con `cause`). */
export function isTransientError(error: unknown): boolean {
    if (!(error instanceof HttpError)) return false;
    if (error.status === undefined) return error.cause !== undefined;
    return error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Corre `operation` y la reintenta ante errores transitorios, con backoff exponencial y full jitter.
 * Solo para operaciones idempotentes: relanza el último error tal cual, sin envolverlo.
 */
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
    const maxAttempts = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
    const deadline = Date.now() + totalTimeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
            if (lastError !== undefined) break;
            throw new RetryCancelledError(name);
        }
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === maxAttempts || !isTransient(error)) throw error;
            let delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
            const retryAfter = error instanceof HttpError ? error.retryAfterMs : undefined;
            if (retryAfter !== undefined) delayMs = Math.max(delayMs, retryAfter);
            if (Date.now() + delayMs >= deadline) throw error;
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

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponential = baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * Math.min(exponential, maxDelayMs));
}

/** Espera `ms`; si el signal aborta, rechaza y `withRetry` corta con el último error. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
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
