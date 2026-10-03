export class HttpError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "HttpError";
    }
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
        throw new HttpError(`No se pudo conectar con ${new URL(url).host}: ${(e as Error).message}`);
    }

    if (!res.ok) throw new HttpError(`HTTP ${res.status} en ${new URL(url).pathname}`, res.status);

    try {
        return (await res.json()) as T;
    } catch {
        throw new HttpError(`Respuesta no JSON en ${new URL(url).pathname}`, res.status);
    }
}
