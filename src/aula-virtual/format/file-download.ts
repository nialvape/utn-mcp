import { createHash } from "node:crypto";
import type { AulaSession } from "../client/session.js";
import { fetchFile } from "../client/moodle-api.js";
import { downloadUrl, MAX_BYTES } from "./files.js";

export interface AulaFileDownload {
    bytes: Uint8Array;
    sha256: string;
    size: number;
}

/**
 * Descarga byte-idéntica de un archivo del aula, con su huella sha256: la base de cualquier
 * publicación verificable (un PR, un backup). `url` es la `url`/`fileurl` tal como la
 * devuelve aula_open.
 */
export async function downloadAulaFile(
    session: AulaSession,
    baseUrl: string,
    url: string,
    maxBytes = MAX_BYTES,
): Promise<AulaFileDownload> {
    const { bytes } = await fetchFile(session, downloadUrl(baseUrl, url), maxBytes);
    return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
    };
}
