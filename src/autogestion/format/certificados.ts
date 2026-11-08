import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../../shared/http.js";
import { exportsDir } from "../../shared/paths.js";
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

const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);

export async function descargarCertificado(
    session: AutogestionSession,
    referencia: string,
): Promise<{ nombre: string; archivo: string }> {
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
    const isPdf = type === "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
    const ext = isPdf ? ".pdf" : type === "text/html" ? ".html" : ".bin";
    const dir = exportsDir();
    await mkdir(dir, { recursive: true });
    const archivo = join(dir, `${safeFileName(certificado.nombre)}-${randomUUID()}${ext}`);
    await writeFile(archivo, bytes, { flag: "wx" });
    return { nombre: certificado.nombre, archivo };
}
