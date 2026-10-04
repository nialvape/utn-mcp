import { postForm } from "../../shared/http.js";
import { AULA_BASE_URL } from "./constants.js";
import type { AulaSession } from "./session.js";

const WS_URL = `${AULA_BASE_URL}/webservice/rest/server.php`;
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
    let token = await session.getToken();

    for (let attempt = 0; ; attempt++) {
        const data = await postForm<T | MoodleException>(WS_URL, {
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
        const conToken = new URL(url);
        conToken.searchParams.set("token", token);

        let res: Response;
        try {
            res = await fetch(conToken, { signal: AbortSignal.timeout(60_000) });
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

        return { bytes: await leerConLimite(res, maxBytes), contentType };
    }
}

/** Lee el cuerpo cortando apenas pasa el límite, sin esperar a bajarlo entero. */
async function leerConLimite(res: Response, maxBytes: number): Promise<Uint8Array> {
    const limite = `El archivo pesa más de ${Math.round(maxBytes / 1024 / 1024)} MB; es demasiado para leerlo.`;
    if (Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        throw new MoodleError(limite);
    }

    const partes: Uint8Array[] = [];
    let total = 0;
    for await (const parte of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += parte.length;
        if (total > maxBytes) throw new MoodleError(limite);
        partes.push(parte);
    }

    const bytes = new Uint8Array(total);
    let i = 0;
    for (const p of partes) {
        bytes.set(p, i);
        i += p.length;
    }
    return bytes;
}
