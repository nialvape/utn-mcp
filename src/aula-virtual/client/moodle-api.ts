import { HttpError, postForm, retryAfterMs } from "../../shared/http.js";
import type { AulaSession } from "./session.js";

const WS_PATH = "/webservice/rest/server.php";
const UPLOAD_PATH = "/webservice/upload.php";
const TOKEN_ERRORS = new Set(["invalidtoken", "expiredtoken"]);

export class MoodleError extends Error {
    constructor(message: string, readonly errorcode?: string) {
        super(message);
        this.name = "MoodleError";
    }
}

interface MoodleException {
    exception: string;
    errorcode?: string;
    message?: string;
}

const isException = (data: unknown): data is MoodleException =>
    typeof data === "object" && data !== null && "exception" in data;

/** Llama a una función del web service de Moodle; renueva el token una vez si venció. */
export async function callWs<T>(
    session: AulaSession,
    wsfunction: string,
    params: Record<string, string | number> = {},
): Promise<T> {
    const { baseUrl } = await session.getRegional();
    let token = await session.getToken();

    for (let attempt = 0; ; attempt++) {
        const data = await postForm<T | MoodleException>(baseUrl + WS_PATH, {
            ...params,
            wstoken: token,
            wsfunction,
            moodlewsrestformat: "json",
        });
        if (!isException(data)) return data;

        if (attempt === 0 && data.errorcode && TOKEN_ERRORS.has(data.errorcode)) {
            token = await session.refreshToken();
            continue;
        }
        throw new MoodleError(data.message ?? data.exception, data.errorcode);
    }
}

/**
 * Baja un archivo de `webservice/pluginfile.php` con el token; lo renueva una vez si venció.
 * Los errores llegan como JSON (`{ error, errorcode }`) en lugar del archivo.
 * Los redirects se siguen a mano y SOLO al propio aula y a rutas de archivos (pluginfile):
 * un pluginfile legítimo no redirige afuera, así que cualquier otro destino se rechaza.
 */
export async function fetchFile(
    session: AulaSession,
    url: URL,
    maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    let token = await session.getToken();
    const { baseUrl } = await session.getRegional();
    const aulaOrigin = new URL(baseUrl).origin;
    let current = url;
    let redirects = 0;
    // Aparte de los redirects: uno antes del token vencido no tiene que gastar la renovación.
    let refreshed = false;

    for (;;) {
        const withToken = new URL(current);
        withToken.searchParams.set("token", token);

        let res: Response;
        try {
            res = await fetch(withToken, { signal: AbortSignal.timeout(60_000), redirect: "manual" });
        } catch (e) {
            throw new HttpError(`No se pudo bajar el archivo: ${(e as Error).message}`, undefined, { cause: e });
        }

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            const next = location ? new URL(location, current) : null;
            redirects++;
            if (
                redirects > 3 ||
                !next ||
                next.username ||
                next.password ||
                next.origin !== aulaOrigin ||
                !next.pathname.includes("pluginfile.php")
            ) {
                throw new MoodleError(
                    `El aula redirigió la descarga a una dirección no permitida (${location ?? "sin destino"})`,
                );
            }
            current = next;
            continue;
        }

        const contentType = res.headers.get("content-type");
        if (contentType?.startsWith("application/json")) {
            const data = (await res.json()) as { error?: string; errorcode?: string };
            if (!refreshed && data.errorcode && TOKEN_ERRORS.has(data.errorcode)) {
                refreshed = true;
                token = await session.refreshToken();
                continue;
            }
            if (!res.ok) {
                throw new HttpError(`HTTP ${res.status} al bajar el archivo`, res.status, {
                    retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
                });
            }
            throw new MoodleError(data.error ?? `HTTP ${res.status}`, data.errorcode);
        }
        if (!res.ok || !res.body) {
            throw new HttpError(`HTTP ${res.status} al bajar el archivo`, res.status, {
                retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
            });
        }

        return { bytes: await readWithLimit(res, maxBytes), contentType };
    }
}

/**
 * Sube archivos al área de borrador del usuario por `webservice/upload.php` y devuelve su `itemid`,
 * que es lo que piden las funciones que guardan archivos. Todos quedan en el mismo borrador.
 */
export async function uploadDraftFiles(
    session: AulaSession,
    files: { name: string; bytes: Uint8Array }[],
): Promise<number> {
    const { baseUrl } = await session.getRegional();
    let token = await session.getToken();

    for (let attempt = 0; ; attempt++) {
        const form = new FormData();
        form.set("token", token);
        form.set("filearea", "draft");
        form.set("itemid", "0");
        files.forEach((f, i) => form.set(`file_${i + 1}`, new Blob([new Uint8Array(f.bytes)]), f.name));

        let res: Response;
        try {
            res = await fetch(baseUrl + UPLOAD_PATH, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
        } catch (e) {
            throw new MoodleError(`No se pudo subir el archivo: ${(e as Error).message}`);
        }
        if (!res.ok) throw new MoodleError(`HTTP ${res.status} al subir el archivo`);

        // Si sale bien, un registro por archivo; si no, `{ error, errorcode }`.
        const data = (await res.json()) as { itemid: number }[] | { error?: string; errorcode?: string };
        if (Array.isArray(data) && data[0]) return data[0].itemid;

        const err = Array.isArray(data) ? {} : data;
        if (attempt === 0 && err.errorcode && TOKEN_ERRORS.has(err.errorcode)) {
            token = await session.refreshToken();
            continue;
        }
        throw new MoodleError(err.error ?? "Moodle no aceptó el archivo.", err.errorcode);
    }
}

/** Lee el cuerpo cortando apenas pasa el límite, sin esperar a bajarlo entero. */
async function readWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
    const tooBig = `El archivo pesa más de ${Math.round(maxBytes / 1024 / 1024)} MB; es demasiado para leerlo.`;
    if (Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        throw new MoodleError(tooBig);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) throw new MoodleError(tooBig);
        chunks.push(chunk);
    }

    const bytes = new Uint8Array(total);
    let i = 0;
    for (const p of chunks) {
        bytes.set(p, i);
        i += p.length;
    }
    return bytes;
}
