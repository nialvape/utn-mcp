import { inflateRawSync } from "node:zlib";

/**
 * Lector mínimo de zip, lo justo para docx/pptx/xlsx: lee el índice (directorio central) del final
 * del archivo y descomprime las entradas pedidas. Sin zip64 ni cifrado, que Office no usa.
 */

export interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    size: number;
    /** Dónde empieza el encabezado local de la entrada. */
    offset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATE = 8;

class InvalidZip extends Error {
    constructor(detail: string) {
        super(`El archivo no es un zip válido: ${detail}.`);
        this.name = "InvalidZip";
    }
}

export function listZip(bytes: Uint8Array): ZipEntry[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // El fin del directorio está al final, seguido de un comentario opcional de hasta 64 KB.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
        if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
            end = i;
            break;
        }
    }
    if (end < 0) throw new InvalidZip("no tiene índice");

    const count = view.getUint16(end + 10, true);
    let p = view.getUint32(end + 16, true);
    if (count === 0xffff || p === 0xffffffff) throw new InvalidZip("usa zip64");

    const entries: ZipEntry[] = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL_DIRECTORY_ENTRY) {
            throw new InvalidZip("índice corrupto");
        }
        const nameLength = view.getUint16(p + 28, true);
        entries.push({
            name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
            method: view.getUint16(p + 10, true),
            compressedSize: view.getUint32(p + 20, true),
            size: view.getUint32(p + 24, true),
            offset: view.getUint32(p + 42, true),
        });
        p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    return entries;
}

/**
 * Descomprime una entrada. `max` corta aunque el índice mienta sobre el tamaño: un zip chico que se
 * infla a gigas es un ataque conocido.
 */
export function readEntry(bytes: Uint8Array, entry: ZipEntry, max: number): Uint8Array {
    if (entry.size > max) throw new InvalidZip(`"${entry.name}" descomprimido pesa demasiado`);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const p = entry.offset;
    if (view.getUint32(p, true) !== LOCAL_HEADER) throw new InvalidZip(`falta el encabezado de "${entry.name}"`);
    const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
    const data = bytes.subarray(start, start + entry.compressedSize);

    switch (entry.method) {
        case STORED:
            return data;
        case DEFLATE:
            try {
                return inflateRawSync(data, { maxOutputLength: max });
            } catch (e) {
                throw new InvalidZip(`no se pudo descomprimir "${entry.name}" (${(e as Error).message})`);
            }
        default:
            throw new InvalidZip(`"${entry.name}" usa una compresión no soportada (${entry.method})`);
    }
}
