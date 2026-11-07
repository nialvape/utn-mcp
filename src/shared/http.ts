export class HttpError extends Error {
    readonly retryAfterMs?: number;

    constructor(message: string, readonly status?: number, options?: { cause?: unknown; retryAfterMs?: number }) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "HttpError";
        if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    }
}

export function retryAfterMs(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return undefined;
}

/** POST application/x-www-form-urlencoded y parseo JSON, con timeout. */
export async function postForm<T>(
    url: string,
    params: Record<string, string | number>,
    timeoutMs = 30_000,
): Promise<T> {
    const body = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
    );

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        throw new HttpError(`No se pudo conectar con ${new URL(url).host}: ${(e as Error).message}`, undefined, {
            cause: e,
        });
    }

    if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} en ${new URL(url).pathname}`, res.status, {
            retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
        });
    }

    try {
        return (await res.json()) as T;
    } catch (e) {
        throw new HttpError(`Respuesta no JSON en ${new URL(url).pathname}`, res.status, { cause: e });
    }
}
