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

/** Los límites de los links de bajada. Se leen en cada uso: cambiarlos en runtime vale para los links que se ofrecen después. */
export interface DownloadLimits {
    /** Cuánto dura un link, en milisegundos. */
    ttlMs: number;
    /** Tope de un archivo ofrecido, en bytes: queda en memoria hasta que el link vence. */
    maxBytes: number;
    /** Links abiertos por usuario: con más, se cierra el más viejo. */
    maxOpenPerOwner: number;
}

/** Un número positivo de la variable de entorno; con basura vuelve al default, así no desactiva un tope. */
function positiveFromEnv(name: string, fallback: number): number {
    const n = Number(process.env[name] ?? fallback);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Los defaults: UTN_MCP_DOWNLOAD_TTL_MIN (10), UTN_MCP_DOWNLOAD_MAX_MB (10) y UTN_MCP_DOWNLOAD_MAX_OPEN (5). */
export function downloadLimitsFromEnv(): DownloadLimits {
    return {
        ttlMs: positiveFromEnv("UTN_MCP_DOWNLOAD_TTL_MIN", 10) * 60 * 1000,
        maxBytes: positiveFromEnv("UTN_MCP_DOWNLOAD_MAX_MB", 10) * 1024 * 1024,
        maxOpenPerOwner: Math.floor(positiveFromEnv("UTN_MCP_DOWNLOAD_MAX_OPEN", 5)) || 1,
    };
}

/** El vencimiento en palabras, para las descripciones de las tools ("10 minutos"). */
export function ttlText(limits: DownloadLimits): string {
    const min = Math.max(1, Math.round(limits.ttlMs / 60_000));
    return min === 1 ? "1 minuto" : `${min} minutos`;
}

/**
 * Links para que el usuario baje un archivo que armó el servidor, en modo HTTP, donde el disco del
 * servidor no es el suyo. Los abre el navegador del usuario o el agente con `curl` si tiene terminal en
 * su compu. No son de un solo uso: si el agente lo intenta desde un lugar donde el archivo no le llega
 * al usuario (un sandbox remoto), el link le sigue sirviendo hasta que vence. Viven en memoria: si el
 * servidor se reinicia, se pierden y hay que pedir otro.
 */
export class DownloadOutbox {
    private readonly downloads = new Map<string, Download>();

    private current: DownloadLimits;

    constructor(
        private readonly baseUrl: string,
        limits: DownloadLimits = downloadLimitsFromEnv(),
    ) {
        this.current = { ...limits };
    }

    get limits(): Readonly<DownloadLimits> {
        return this.current;
    }

    /** Cambia los límites en caliente (por ejemplo, según la demanda); los links ya ofrecidos conservan su vencimiento. */
    setLimits(patch: Partial<DownloadLimits>) {
        for (const [key, value] of Object.entries(patch)) {
            if (!Number.isFinite(value) || (value as number) <= 0) throw new Error(`Límite inválido para ${key}: ${value}`);
        }
        this.current = { ...this.current, ...patch };
    }

    offer(owner: string, file: DownloadFile) {
        const { ttlMs, maxBytes, maxOpenPerOwner } = this.current;
        if (file.bytes.length > maxBytes) throw new Error("El archivo es demasiado grande para un link de bajada.");
        this.sweep();
        // El Map conserva el orden de inserción: el primero que aparece es el más viejo.
        const own = [...this.downloads].filter(([, d]) => d.owner === owner);
        for (const [oldId] of own.slice(0, Math.max(0, own.length - maxOpenPerOwner + 1))) this.downloads.delete(oldId);
        const id = randomBytes(24).toString("base64url");
        const expiresAt = Date.now() + ttlMs;
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
