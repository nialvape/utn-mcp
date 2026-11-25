import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse } from "node:path";
import type { DownloadOutbox } from "../../shared/downloads.js";
import { exportsDir } from "../../shared/paths.js";
import { formatSize } from "../../shared/uploads.js";
import { fetchFile } from "../client/moodle-api.js";
import type { AulaSession } from "../client/session.js";
import { LoginRequiredError } from "../client/sso-login.js";
import { downloadUrl, MAX_BYTES, userFacingUrl } from "./files.js";

/** Archivos por llamada: alcanza para todos los adjuntos de una consigna sin colgar la compu. */
export const MAX_FILES_PER_CALL = 30;

interface Downloaded {
    /** La que pasó el modelo, para nombrarla en `omitidos`. */
    url: string;
    /** Para que el usuario lo abra con la sesión de su navegador si no entra en un link. */
    browserUrl: string;
    name: string;
    bytes: Uint8Array;
    mimeType: string;
    sha256: string;
}

/** Lo que no se pudo bajar; las claves llegan al modelo. */
export interface Skipped {
    url: string;
    motivo: string;
}

/** El nombre sale del último tramo de la URL: sin separadores de ruta ni puntos al principio, nunca vacío. */
function fileNameFrom(url: URL): string {
    let raw = url.pathname.split("/").pop() ?? "";
    try {
        raw = decodeURIComponent(raw);
    } catch {
        // Un `%` suelto en el nombre: queda tal cual.
    }
    return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^\.+/, "").trim() || "archivo";
}

/**
 * Baja cada URL tal cual está en el aula (los bytes exactos, con su sha256). Lo que falla por archivo
 * (URL ajena al aula, archivo borrado, demasiado grande) queda en `omitidos` con el motivo, para no
 * perder el resto; una sesión vencida sí corta todo, porque ahí no baja ninguno.
 */
async function downloadAll(
    session: AulaSession,
    urls: string[],
    maxBytes: number,
): Promise<{ downloaded: Downloaded[]; skipped: Skipped[] }> {
    const { baseUrl } = await session.getRegional();
    const downloaded: Downloaded[] = [];
    const skipped: Skipped[] = [];
    for (const url of new Set(urls)) {
        try {
            const target = downloadUrl(baseUrl, url);
            const { bytes, contentType } = await fetchFile(session, target, maxBytes);
            downloaded.push({
                url,
                browserUrl: userFacingUrl(target.href),
                name: fileNameFrom(target),
                bytes,
                mimeType: contentType?.split(";")[0].trim() || "application/octet-stream",
                sha256: createHash("sha256").update(bytes).digest("hex"),
            });
        } catch (e) {
            if (e instanceof LoginRequiredError) throw e;
            skipped.push({ url, motivo: (e as Error).message });
        }
    }
    return { downloaded, skipped };
}

function checkCount(urls: string[], max: number) {
    if (urls.length === 0) throw new Error("Pasá al menos una `url` de archivo, tal como la devuelve aula_open.");
    if (urls.length > max) {
        throw new Error(`Son ${urls.length} archivos y el máximo por llamada es ${max}: pedilos en tandas.`);
    }
}

/** Escribe sin pisar: si el nombre ya existe en la carpeta, prueba con -2, -3... (bandera "wx", atómica). */
async function writeNew(dir: string, name: string, bytes: Uint8Array): Promise<string> {
    const { name: base, ext } = parse(name);
    for (let n = 1; n <= 100; n++) {
        const candidate = join(dir, n === 1 ? name : `${base}-${n}${ext}`);
        try {
            await writeFile(candidate, bytes, { flag: "wx" });
            return candidate;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
    }
    throw new Error(`No se pudo guardar "${name}": ya existen 100 archivos con ese nombre en ${dir}.`);
}

/** Modo local: el servidor corre en la compu del usuario, así que los archivos quedan en su disco. */
export async function downloadToDisk(session: AulaSession, urls: string[], carpeta?: string) {
    checkCount(urls, MAX_FILES_PER_CALL);
    if (carpeta !== undefined && !isAbsolute(carpeta)) {
        throw new Error(`Pasá la ruta absoluta de la carpeta; "${carpeta}" es relativa.`);
    }
    const dir = carpeta ?? exportsDir();
    const { downloaded, skipped } = await downloadAll(session, urls, MAX_BYTES);
    if (downloaded.length) await mkdir(dir, { recursive: true });
    const files = [];
    for (const f of downloaded) {
        files.push({
            nombre: f.name,
            ruta: await writeNew(dir, f.name, f.bytes),
            tamanio: f.bytes.length,
            sha256: f.sha256,
        });
    }
    return { carpeta: dir, archivos: files, omitidos: skipped.length ? skipped : undefined };
}

/**
 * Modo HTTP: el disco del servidor no es el del usuario, así que cada archivo queda detrás de un link
 * de bajada. Los bytes no pasan por la respuesta: no tienen por qué entrar al contexto del modelo.
 */
export async function offerDownloads(session: AulaSession, urls: string[], outbox: DownloadOutbox, owner: string) {
    // Cada archivo ocupa un link y el outbox cierra los más viejos del usuario: con más, se pisarían entre sí.
    const { maxBytes, maxOpenPerOwner } = outbox.limits;
    checkCount(urls, maxOpenPerOwner);
    // Se baja con el tope del aula y no con el del link: así el que no entra se reporta con su tamaño y una salida.
    const { downloaded, skipped } = await downloadAll(session, urls, MAX_BYTES);
    const files = [];
    let lastExpiry: string | undefined;
    for (const f of downloaded) {
        if (f.bytes.length > maxBytes) {
            skipped.push({
                url: f.url,
                motivo:
                    `Pesa ${formatSize(f.bytes.length)} y un link de bajada admite hasta ${formatSize(maxBytes)}. ` +
                    `El usuario lo puede bajar desde ${f.browserUrl}, con su sesión del aula abierta en el navegador.`,
            });
            continue;
        }
        const { url, expiresAt } = outbox.offer(owner, { name: f.name, mimeType: f.mimeType, bytes: f.bytes });
        lastExpiry = expiresAt;
        files.push({
            nombre: f.name,
            mimeType: f.mimeType,
            tamanio: f.bytes.length,
            sha256: f.sha256,
            url,
            conTerminal: `curl -fsS -o "${f.name.replace(/"/g, "")}" "${url}"`,
        });
    }
    return { archivos: files, vence: lastExpiry, omitidos: skipped.length ? skipped : undefined };
}
