import { randomBytes } from "node:crypto";

/** Un archivo que el servidor le ofrece al usuario para bajar. */
export interface DownloadFile {
    /** Con extensión: es el nombre con el que lo guarda el navegador o `curl -OJ`. */
    name: string;
    mimeType: string;
    bytes: Uint8Array;
}

interface Download extends DownloadFile {
    owner: string;
    expiresAt: number;
}

/** Cuánto dura un link de bajada, en milisegundos. */
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
/** Tope de un archivo ofrecido, en bytes: queda en memoria hasta que el link vence. */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Links abiertos por usuario: con más, se cierra el más viejo. */
const MAX_OPEN_PER_OWNER = 5;

/**
 * Links para que el usuario baje un archivo que armó el servidor, en modo HTTP, donde el disco del
 * servidor no es el suyo. Los abre el navegador del usuario o el agente con `curl` si tiene terminal en
 * su compu. No son de un solo uso: si el agente lo intenta desde un lugar donde el archivo no le llega
 * al usuario (un sandbox remoto), el link le sigue sirviendo hasta que vence. Viven en memoria: si el
 * servidor se reinicia, se pierden y hay que pedir otro.
 */
export class DownloadOutbox {
    private readonly downloads = new Map<string, Download>();

    constructor(private readonly baseUrl: string) {}

    offer(owner: string, file: DownloadFile) {
        if (file.bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("El archivo es demasiado grande para un link de bajada.");
        this.sweep();
        // El Map conserva el orden de inserción: el primero que aparece es el más viejo.
        const own = [...this.downloads].filter(([, d]) => d.owner === owner);
        for (const [oldId] of own.slice(0, Math.max(0, own.length - MAX_OPEN_PER_OWNER + 1))) this.downloads.delete(oldId);
        const id = randomBytes(24).toString("base64url");
        const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
        this.downloads.set(id, { ...file, owner, expiresAt });
        return { url: `${this.baseUrl}/bajar/${id}`, expiresAt: new Date(expiresAt).toISOString() };
    }

    /** El archivo del link, o undefined si no existe o venció. */
    get(id: string): DownloadFile | undefined {
        this.sweep();
        return this.downloads.get(id);
    }

    private sweep() {
        const now = Date.now();
        for (const [id, download] of this.downloads) if (download.expiresAt < now) this.downloads.delete(id);
    }
}

/**
 * `Content-Disposition` con el nombre en ASCII para los clientes viejos y en UTF-8 (RFC 6266) para el
 * resto: los nombres de los certificados traen tildes. Siempre `attachment`, así un HTML del portal se
 * baja y no se renderiza con el origen del servidor.
 */
export function attachmentHeader(name: string): string {
    const ascii = name.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "archivo";
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
