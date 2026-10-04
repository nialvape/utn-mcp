import { abrirDocumento, FormatoNoSoportado, type Parte } from "../shared/documents/index.js";
import { AULA_BASE_URL } from "./client/constants.js";
import { fetchFile } from "./client/moodle-api.js";
import type { AulaSession } from "./client/session.js";

const ORIGEN = new URL(AULA_BASE_URL).origin;
const RUTA_WS = "/webservice/pluginfile.php/";
const RUTA_WEB = "/pluginfile.php/";

/** Cuánto se devuelve por llamada, en caracteres de texto. */
const PRESUPUESTO = 30_000;
/** Lo que cuesta una página como imagen (~1.600 tokens), medido en caracteres de texto. */
const COSTO_IMAGEN = 6_000;
/** El más grande que hay hoy en los cursos pesa 12 MB. */
const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Moodle devuelve las URLs del web service, que piden token. Al usuario le sirve la misma ruta sin
 * `/webservice`, que se abre con la sesión de su navegador. Es la única que mostramos: el token no
 * sale nunca del servidor.
 */
export function urlParaUsuario(fileurl: string): string {
    return fileurl.replace(`${ORIGEN}${RUTA_WS}`, `${ORIGEN}${RUTA_WEB}`);
}

/**
 * Acepta cualquiera de las dos formas y devuelve la del web service. Solo archivos del aula: con
 * cualquier otra URL estaríamos mandando el token del usuario a donde diga el modelo.
 */
function urlDeDescarga(url: string): URL {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        throw new Error(`URL inválida: "${url}". Usá la \`url\` de un archivo tal como la devuelve aula_open.`);
    }
    const ruta = u.pathname.startsWith(RUTA_WS) ? u.pathname : u.pathname.startsWith(RUTA_WEB) ? RUTA_WS + u.pathname.slice(RUTA_WEB.length) : null;
    if (u.origin !== ORIGEN || !ruta) {
        throw new Error(`Solo se pueden leer archivos del aula virtual (${ORIGEN}${RUTA_WEB}...).`);
    }
    u.pathname = ruta;
    u.searchParams.delete("token");
    u.searchParams.delete("wstoken");
    return u;
}

export interface Lectura {
    archivo: string;
    formato: string;
    unidad: string;
    total: number;
    desde: number;
    hasta: number;
    /** El `desde` para pedir lo que sigue; no está si ya se leyó todo. */
    siguiente?: number;
    urlParaUsuario: string;
    partes: (Parte & { numero: number })[];
}

/** Baja un archivo del aula y devuelve desde la parte `desde` tantas como entren en el presupuesto. */
export async function leerArchivo(session: AulaSession, url: string, desde = 1): Promise<Lectura> {
    const descarga = urlDeDescarga(url);
    const archivo = decodeURIComponent(descarga.pathname.split("/").pop() ?? "");
    const paraUsuario = urlParaUsuario(descarga.href);

    const { bytes } = await fetchFile(session, descarga, MAX_BYTES);

    let documento;
    try {
        documento = await abrirDocumento(bytes, archivo);
    } catch (e) {
        if (e instanceof FormatoNoSoportado) {
            throw new Error(`${e.message} El usuario lo puede bajar desde ${paraUsuario}`);
        }
        throw e;
    }

    try {
        if (desde > documento.total) {
            throw new Error(`"${archivo}" termina en ${documento.unidad} ${documento.total}; se pidió desde ${desde}.`);
        }

        const partes: Lectura["partes"] = [];
        let gastado = 0;
        let n = desde;
        for (; n <= documento.total; n++) {
            const parte = await documento.parte(n);
            const costo = "texto" in parte ? parte.texto.length : COSTO_IMAGEN;
            // Siempre al menos una parte, aunque sola se pase del presupuesto.
            if (partes.length > 0 && gastado + costo > PRESUPUESTO) break;
            partes.push({ ...parte, numero: n });
            gastado += costo;
        }

        return {
            archivo,
            formato: documento.formato,
            unidad: documento.unidad,
            total: documento.total,
            desde,
            hasta: n - 1,
            siguiente: n <= documento.total ? n : undefined,
            urlParaUsuario: paraUsuario,
            partes,
        };
    } finally {
        await documento.cerrar();
    }
}
