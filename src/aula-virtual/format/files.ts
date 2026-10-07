import { openDocument, UnsupportedFormat, type Part } from "../../shared/documents/index.js";
import { AULA_BASE_URL } from "../client/constants.js";
import { fetchFile } from "../client/moodle-api.js";
import type { AulaSession } from "../client/session.js";

const ORIGIN = new URL(AULA_BASE_URL).origin;
const WS_PATH = "/webservice/pluginfile.php/";
const WEB_PATH = "/pluginfile.php/";

/** Cuánto se devuelve por llamada, en caracteres de texto. */
const BUDGET_CHARS = 30_000;
/** Lo que cuesta una página como imagen (~1.600 tokens), medido en caracteres de texto. */
const IMAGE_COST_CHARS = 6_000;
/** El más grande que hay hoy en los cursos pesa 12 MB. */
const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Moodle devuelve las URLs del web service, que piden token. Al usuario le sirve la misma ruta sin
 * `/webservice`, que se abre con la sesión de su navegador. Es la única que mostramos: el token no
 * sale nunca del servidor.
 */
export function userFacingUrl(fileurl: string): string {
    return fileurl.replace(`${ORIGIN}${WS_PATH}`, `${ORIGIN}${WEB_PATH}`);
}

/**
 * Acepta cualquiera de las dos formas y devuelve la del web service. Solo archivos del aula: con
 * cualquier otra URL estaríamos mandando el token del usuario a donde diga el modelo.
 */
function downloadUrl(url: string): URL {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        throw new Error(`URL inválida: "${url}". Usá la \`url\` de un archivo tal como la devuelve aula_open.`);
    }
    const path = u.pathname.startsWith(WS_PATH) ? u.pathname : u.pathname.startsWith(WEB_PATH) ? WS_PATH + u.pathname.slice(WEB_PATH.length) : null;
    if (u.origin !== ORIGIN || !path) {
        throw new Error(`Solo se pueden leer archivos del aula virtual (${ORIGIN}${WEB_PATH}...).`);
    }
    u.pathname = path;
    u.searchParams.delete("token");
    u.searchParams.delete("wstoken");
    return u;
}

/** Lo que ve el modelo de una lectura (las claves van en castellano) más las partes leídas. */
export interface FileRead {
    archivo: string;
    formato: string;
    unidad: string;
    total: number;
    desde: number;
    hasta: number;
    /** El `desde` para pedir lo que sigue; no está si ya se leyó todo. */
    siguiente?: number;
    urlParaUsuario: string;
    parts: (Part & { number: number })[];
}

/** Baja un archivo del aula y devuelve desde la parte `from` tantas como entren en el presupuesto. */
export async function readAulaFile(session: AulaSession, url: string, from = 1): Promise<FileRead> {
    const download = downloadUrl(url);
    const fileName = decodeURIComponent(download.pathname.split("/").pop() ?? "");
    const forUser = userFacingUrl(download.href);

    const { bytes } = await fetchFile(session, download, MAX_BYTES);

    let doc;
    try {
        doc = await openDocument(bytes, fileName);
    } catch (e) {
        if (e instanceof UnsupportedFormat) {
            throw new Error(`${e.message} El usuario lo puede bajar desde ${forUser}`);
        }
        throw e;
    }

    try {
        if (from > doc.total) {
            throw new Error(`"${fileName}" termina en ${doc.unit} ${doc.total}; se pidió desde ${from}.`);
        }

        const parts: FileRead["parts"] = [];
        let spent = 0;
        let n = from;
        for (; n <= doc.total; n++) {
            const part = await doc.part(n);
            const cost = "text" in part ? part.text.length : IMAGE_COST_CHARS;
            // Siempre al menos una parte, aunque sola se pase del presupuesto.
            if (parts.length > 0 && spent + cost > BUDGET_CHARS) break;
            parts.push({ ...part, number: n });
            spent += cost;
        }

        return {
            archivo: fileName,
            formato: doc.format,
            unidad: doc.unit,
            total: doc.total,
            desde: from,
            hasta: n - 1,
            siguiente: n <= doc.total ? n : undefined,
            urlParaUsuario: forUser,
            parts,
        };
    } finally {
        await doc.close();
    }
}
