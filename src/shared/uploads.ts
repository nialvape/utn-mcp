import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import type { DownloadOutbox } from "./downloads.js";

export interface UploadedFile {
    name: string;
    bytes: Uint8Array;
}

/** Lo que acepta una subida; lo pone la plataforma que la abre. */
export interface UploadLimits {
    maxFiles?: number;
    /** Por archivo. */
    maxBytes: number;
    /** En minúscula y con punto (".pdf"); sin lista, cualquiera. */
    extensions?: string[];
}

/**
 * Cómo van y vienen los archivos entre el servidor y el usuario: en STDIO, por el disco, que es el suyo;
 * en HTTP, el servidor puede estar en otra máquina, así que llegan por un link de subida (`inbox`) y se
 * entregan por uno de bajada (`outbox`). `owner` es el usuario de la request: una subida solo la puede
 * usar quien la abrió.
 */
export type FileSource =
    | { local: true }
    | { local: false; inbox: UploadInbox; outbox: DownloadOutbox; owner: string };

interface Upload {
    owner: string;
    title: string;
    limits: UploadLimits;
    /** null mientras no se subió nada. */
    files: UploadedFile[] | null;
    expiresAt: number;
}

/** Cuánto dura un link de subida, en milisegundos. */
const UPLOAD_TTL_MS = 30 * 60 * 1000;
/** Tope de una subida entera, en bytes: los archivos quedan en memoria hasta que se entregan. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Links abiertos por usuario: con más, se cierra el más viejo. */
const MAX_OPEN_PER_OWNER = 5;

/**
 * Links de un solo uso para recibir archivos por HTTP: los sube el agente con `curl` si tiene
 * terminal, o el usuario desde el navegador. Los archivos quedan en memoria hasta que una tool los
 * toma o el link vence; si el servidor se reinicia, se pierden y hay que pedir otro link.
 */
export class UploadInbox {
    private readonly uploads = new Map<string, Upload>();

    constructor(private readonly baseUrl: string) {}

    open(owner: string, title: string, limits: UploadLimits) {
        this.sweep();
        // El Map conserva el orden de inserción: el primero que aparece es el más viejo.
        const own = [...this.uploads].filter(([, u]) => u.owner === owner);
        for (const [oldId] of own.slice(0, Math.max(0, own.length - MAX_OPEN_PER_OWNER + 1))) this.uploads.delete(oldId);
        const id = randomBytes(24).toString("base64url");
        const expiresAt = Date.now() + UPLOAD_TTL_MS;
        this.uploads.set(id, { owner, title, limits, files: null, expiresAt });
        return { id, url: `${this.baseUrl}/subir/${id}`, expiresAt: new Date(expiresAt).toISOString() };
    }

    /** La subida para mostrar su formulario, o undefined si no existe o venció. */
    get(id: string): Pick<Upload, "title" | "limits" | "files"> | undefined {
        this.sweep();
        return this.uploads.get(id);
    }

    /** Guarda los archivos de una subida; cada link acepta una sola. */
    receive(id: string, files: UploadedFile[]): void {
        const upload = this.uploads.get(id);
        if (!upload || upload.expiresAt < Date.now()) throw new Error("El link de subida venció o no existe.");
        if (upload.files) throw new Error("Este link ya se usó. Pedile al agente uno nuevo.");
        if (!files.length) throw new Error('No llegó ningún archivo: van en el campo "archivos".');
        checkFiles(files, upload.limits);
        upload.files = files;
    }

    /** Los archivos que se subieron, para entregarlos. No los borra: si la entrega falla, se reintenta. */
    take(id: string, owner: string): UploadedFile[] {
        const upload = this.uploads.get(id);
        if (!upload || upload.owner !== owner || upload.expiresAt < Date.now()) {
            throw new Error("La subida venció o no existe: pedí otro link.");
        }
        if (!upload.files) {
            throw new Error("Todavía no se subió nada a ese link: esperá a que se use y volvé a intentar.");
        }
        return upload.files;
    }

    close(id: string): void {
        this.uploads.delete(id);
    }

    private sweep() {
        const now = Date.now();
        for (const [id, upload] of this.uploads) if (upload.expiresAt < now) this.uploads.delete(id);
    }
}

/** Cantidad, tamaño, tipo y nombres repetidos, que Moodle no acepta. */
export function checkFiles(files: UploadedFile[], limits: UploadLimits): void {
    if (limits.maxFiles && files.length > limits.maxFiles) {
        throw new Error(`Se aceptan hasta ${limits.maxFiles} archivo(s) y llegaron ${files.length}.`);
    }
    const seen = new Set<string>();
    for (const f of files) {
        if (f.bytes.length > limits.maxBytes) {
            throw new Error(`"${f.name}" pesa ${formatSize(f.bytes.length)}; el máximo es ${formatSize(limits.maxBytes)} por archivo.`);
        }
        if (limits.extensions?.length && !limits.extensions.includes(extname(f.name).toLowerCase())) {
            throw new Error(`"${f.name}" no es de un tipo aceptado (${limits.extensions.join(", ")}).`);
        }
        if (seen.has(f.name)) throw new Error(`Hay dos archivos que se llaman "${f.name}"; renombrá uno.`);
        seen.add(f.name);
    }
}

/** Tamaño para personas: en KB por debajo del mega, para que un archivo chico no diga "0.0 MB". */
export const formatSize = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
