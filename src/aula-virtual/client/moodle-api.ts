import { postForm } from "../../shared/http.js";
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
 */
export async function fetchFile(
    session: AulaSession,
    url: URL,
    maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    let token = await session.getToken();

    for (let attempt = 0; ; attempt++) {
        const withToken = new URL(url);
        withToken.searchParams.set("token", token);

        let res: Response;
        try {
            res = await fetch(withToken, { signal: AbortSignal.timeout(60_000) });
        } catch (e) {
            throw new MoodleError(`No se pudo bajar el archivo: ${(e as Error).message}`);
        }

        const contentType = res.headers.get("content-type");
        if (contentType?.startsWith("application/json")) {
            const data = (await res.json()) as { error?: string; errorcode?: string };
            if (attempt === 0 && data.errorcode && TOKEN_ERRORS.has(data.errorcode)) {
                token = await session.refreshToken();
                continue;
            }
            throw new MoodleError(data.error ?? `HTTP ${res.status}`, data.errorcode);
        }
        if (!res.ok || !res.body) throw new MoodleError(`HTTP ${res.status} al bajar el archivo`);

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
