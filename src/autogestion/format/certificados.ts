import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../../shared/http.js";
import { MAX_DOWNLOAD_BYTES, type DownloadOutbox } from "../../shared/downloads.js";
import { exportsDir } from "../../shared/paths.js";
import { formatSize } from "../../shared/uploads.js";
import type { AutogestionSession } from "../client/session.js";
import type { CertificadoAutogestion } from "../client/types.js";

export async function getCertificados(session: AutogestionSession): Promise<CertificadoAutogestion[]> {
    const connector = await session.getConnector();
    if (!connector.certificados) {
        throw new HttpError(
            "El sistema de autogestión de tu regional todavía no tiene conector para certificados y constancias.",
        );
    }
    return connector.certificados();
}

/** El nombre viene del HTML del portal: sin separadores de ruta, sin puntos en los bordes y nunca vacío. */
const safeFileName = (name: string) =>
    name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "certificado";

/** El certificado bajado y clasificado: lo que comparten el guardado en disco y el link de bajada en HTTP. */
interface CertificadoBajado {
    nombre: string;
    bytes: Uint8Array;
    /** Ya normalizado, sin parámetros como `; charset=...`. */
    mimeType: string;
    /** Con punto y en minúscula (".pdf"), para armar el nombre del archivo. */
    extension: string;
}

/**
 * Baja el certificado y valida lo que comparten los dos modos: conector, referencia y tipo de contenido.
 * No lo entrega: el disco lo toca `descargarCertificado` y el link de bajada, `ofrecerCertificado`.
 */
async function bajarCertificado(session: AutogestionSession, referencia: string): Promise<CertificadoBajado> {
    const connector = await session.getConnector();
    if (!connector.certificados || !connector.descargarCertificado) {
        throw new HttpError(
            "El sistema de autogestión de tu regional todavía no tiene conector para descargar certificados.",
        );
    }
    const disponibles = await connector.certificados();
    const certificado = disponibles.find((c) => c.referencia === referencia);
    if (!certificado) {
        const opciones = disponibles.map((c) => c.nombre).join(", ") || "ninguno";
        throw new HttpError(
            `Ese certificado no está entre los que ofrece la autogestión (${opciones}). Pedí la lista de nuevo con autogestion_certificados.`,
        );
    }
    const { contentType, bytes } = await connector.descargarCertificado(referencia);
    const type = contentType.split(";")[0].trim().toLowerCase();
    // Hay regionales que mandan el PDF como octet-stream: la firma del archivo lo delata.
    const isPdf = type === "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
    if (isPdf) return { nombre: certificado.nombre, bytes, mimeType: "application/pdf", extension: ".pdf" };
    if (type === "text/html") return { nombre: certificado.nombre, bytes, mimeType: "text/html", extension: ".html" };
    return { nombre: certificado.nombre, bytes, mimeType: type || "application/octet-stream", extension: ".bin" };
}

/** Descarga el certificado y lo deja en el disco del usuario: el modo local, donde el servidor es su compu. */
export async function descargarCertificado(
    session: AutogestionSession,
    referencia: string,
): Promise<{ nombre: string; archivo: string }> {
    const { nombre, bytes, extension } = await bajarCertificado(session, referencia);
    const dir = exportsDir();
    await mkdir(dir, { recursive: true });
    const archivo = join(dir, `${safeFileName(nombre)}-${randomUUID()}${extension}`);
    await writeFile(archivo, bytes, { flag: "wx" });
    return { nombre, archivo };
}

/**
 * Baja el certificado y lo deja detrás de un link de bajada (modo HTTP). No lo escribe en el disco del
 * servidor ni lo mete en la respuesta: los clientes de Claude descartan o rechazan los PDF embebidos, y
 * el archivo no tiene por qué pasar por el contexto del modelo.
 */
export async function ofrecerCertificado(
    session: AutogestionSession,
    referencia: string,
    outbox: DownloadOutbox,
    owner: string,
): Promise<{
    nombre: string;
    archivo: string;
    mimeType: string;
    tamanio: number;
    url: string;
    vence: string;
    conTerminal: string;
}> {
    const { nombre, bytes, mimeType, extension } = await bajarCertificado(session, referencia);
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
        throw new HttpError(
            `El certificado pesa ${formatSize(bytes.length)} y supera el máximo de ${formatSize(MAX_DOWNLOAD_BYTES)} ` +
                "de un link de bajada. Bajalo con el modo local (STDIO), que lo guarda en tu compu.",
        );
    }
    const archivo = `${safeFileName(nombre)}${extension}`;
    const { url, expiresAt } = outbox.offer(owner, { name: archivo, mimeType, bytes });
    const conTerminal = `curl -fsS -o "${archivo}" "${url}"`;
    return { nombre, archivo, mimeType, tamanio: bytes.length, url, vence: expiresAt, conTerminal };
}
