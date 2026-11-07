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

const EXTENSIONS: Record<string, string> = { "application/pdf": ".pdf", "text/html": ".html" };

const safeFileName = (name: string) =>
    name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);

const PDF_MAGIC = [0x25, 0x50];

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
    const baseType = contentType.split(";")[0].trim().toLowerCase();
    const ext =
        EXTENSIONS[baseType] ?? (bytes[0] === PDF_MAGIC[0] && bytes[1] === PDF_MAGIC[1] ? ".pdf" : ".bin");
    const dir = exportsDir();
    await mkdir(dir, { recursive: true });
    for (let n = 1; n <= 100; n++) {
        const candidate = join(dir, `${safeFileName(certificado.nombre)}${n === 1 ? "" : `-${n}`}${ext}`);
        try {
            await writeFile(candidate, bytes, { flag: "wx" });
            return { nombre: certificado.nombre, archivo: candidate };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
    }
    throw new HttpError(`No se pudo guardar "${certificado.nombre}": ya existen 100 archivos con ese nombre.`);
}
