import { HttpError } from "./http.js";
import { logger } from "./logger.js";

/**
 * Política de reintentos para lecturas idempotentes ante fallas transitorias. Es optativa por
 * operación: la aplica quien llama, no es global. No usarla en operaciones con efectos (login,
 * inscripciones): reintentarlas puede repetir el efecto.
 */
export interface RetryPolicy {
    /** Nombre para los logs ("sysacad estadoAcademico"): sin URLs ni datos de la consulta. */
    operation?: string;
    /** Intentos totales, contando el primero. Por defecto 3. */
    attempts?: number;
    /** Espera base del backoff exponencial, en milisegundos. Por defecto 1000. */
    baseDelayMs?: number;
    /** Techo de cada espera, en milisegundos. Por defecto 8000. */
    maxDelayMs?: number;
    /**
     * Presupuesto total de la operación con sus reintentos, en milisegundos. Por defecto 60000.
     * Si la operación tiene su propio timeout largo (30 s por request en autogestión), los
     * intentos mismos pueden consumirlo antes que las esperas.
     */
    totalTimeoutMs?: number;
    /** Clasifica si el error amerita reintentar; por defecto `isTransientError`. */
    isTransient?: (error: unknown) => boolean;
    /** Cancelación externa: corta la espera y devuelve el último error de la operación. */
    signal?: AbortSignal;
    /** Aviso de cada reintento; por defecto loguea sin mensajes de error (pueden traer URLs de sesión). */
    onRetry?: (event: RetryEvent) => void;
}

/** Un reintento aplicado, sin el error completo: su mensaje puede llevar URLs con ids de sesión. */
export interface RetryEvent {
    operation: string;
    /** Número del intento que falló (1 es el primero). */
    attempt: number;
    delayMs: number;
    errorName: string;
    status?: number;
}

/**
 * Transitorio es lo que puede salir bien reintentando tal cual: un 5xx, un 408 o 429, o una falla
 * de red/timeout (HttpError con `cause`, sin status). Un 4xx común, un error lógico o uno de
 * credenciales no se arreglan esperando, así que no se reintentan.
 */
export function isTransientError(error: unknown): boolean {
    if (!(error instanceof HttpError)) return false;
    if (error.status === undefined) return error.cause !== undefined;
    return error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Corre `operation` y, si falla de forma transitoria, la reintenta con backoff exponencial y full
 * jitter (`random(0, base * 2^(n-1))`, con techo). Respeta el `Retry-After` que el servidor haya
 * mandado en el error, el presupuesto total y la cancelación. Agotados los intentos (o ante un
 * error no transitorio) relanza el último error, sin envolverlo.
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
    const deadline = Date.now() + totalTimeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === attempts || !isTransient(error)) throw error;
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
                // Cancelado durante la espera: importa el error de la operación, no el del timer.
                break;
            }
        }
    }
    throw lastError;
}

/** Decorador de método con la misma política: `@retry({ operation: "..." })` sobre lecturas idempotentes. */
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

/** Full jitter sobre el exponencial topeado: desincroniza reintentos de varios clientes. */
function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const exponential = baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * Math.min(exponential, maxDelayMs));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
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
