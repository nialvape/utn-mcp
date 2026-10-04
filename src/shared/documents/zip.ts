import { inflateRawSync } from "node:zlib";

/**
 * Lector mínimo de zip, lo justo para docx/pptx/xlsx: lee el índice (directorio central) del final
 * del archivo y descomprime las entradas pedidas. Sin zip64 ni cifrado, que Office no usa.
 */

export interface EntradaZip {
    nombre: string;
    metodo: number;
    comprimido: number;
    tamanio: number;
    /** Dónde empieza el encabezado local de la entrada. */
    offset: number;
}

const FIN_DIRECTORIO = 0x06054b50;
const DIRECTORIO = 0x02014b50;
const ENCABEZADO_LOCAL = 0x04034b50;
const SIN_COMPRESION = 0;
const DEFLATE = 8;

class ZipInvalido extends Error {
    constructor(detalle: string) {
        super(`El archivo no es un zip válido: ${detalle}.`);
        this.name = "ZipInvalido";
    }
}

export function listarZip(bytes: Uint8Array): EntradaZip[] {
    const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // El fin del directorio está al final, seguido de un comentario opcional de hasta 64 KB.
    let fin = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
        if (vista.getUint32(i, true) === FIN_DIRECTORIO) {
            fin = i;
            break;
        }
    }
    if (fin < 0) throw new ZipInvalido("no tiene índice");

    const cantidad = vista.getUint16(fin + 10, true);
    let p = vista.getUint32(fin + 16, true);
    if (cantidad === 0xffff || p === 0xffffffff) throw new ZipInvalido("usa zip64");

    const entradas: EntradaZip[] = [];
    const nombres = new TextDecoder();
    for (let i = 0; i < cantidad; i++) {
        if (p + 46 > bytes.length || vista.getUint32(p, true) !== DIRECTORIO) throw new ZipInvalido("índice corrupto");
        const largoNombre = vista.getUint16(p + 28, true);
        entradas.push({
            nombre: nombres.decode(bytes.subarray(p + 46, p + 46 + largoNombre)),
            metodo: vista.getUint16(p + 10, true),
            comprimido: vista.getUint32(p + 20, true),
            tamanio: vista.getUint32(p + 24, true),
            offset: vista.getUint32(p + 42, true),
        });
        p += 46 + largoNombre + vista.getUint16(p + 30, true) + vista.getUint16(p + 32, true);
    }
    return entradas;
}

/**
 * Descomprime una entrada. `max` corta aunque el índice mienta sobre el tamaño: un zip chico que se
 * infla a gigas es un ataque conocido.
 */
export function leerEntrada(bytes: Uint8Array, entrada: EntradaZip, max: number): Uint8Array {
    if (entrada.tamanio > max) throw new ZipInvalido(`"${entrada.nombre}" descomprimido pesa demasiado`);

    const vista = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const p = entrada.offset;
    if (vista.getUint32(p, true) !== ENCABEZADO_LOCAL) throw new ZipInvalido(`falta el encabezado de "${entrada.nombre}"`);
    const inicio = p + 30 + vista.getUint16(p + 26, true) + vista.getUint16(p + 28, true);
    const datos = bytes.subarray(inicio, inicio + entrada.comprimido);

    switch (entrada.metodo) {
        case SIN_COMPRESION:
            return datos;
        case DEFLATE:
            try {
                return inflateRawSync(datos, { maxOutputLength: max });
            } catch (e) {
                throw new ZipInvalido(`no se pudo descomprimir "${entrada.nombre}" (${(e as Error).message})`);
            }
        default:
            throw new ZipInvalido(`"${entrada.nombre}" usa una compresión no soportada (${entrada.metodo})`);
    }
}
