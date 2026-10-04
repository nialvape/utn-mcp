import { deflateSync } from "node:zlib";

/** PNG en escala de grises, 8 bits. Alcanza para páginas escaneadas y evita una dependencia de imágenes. */
export function pngGris(ancho: number, alto: number, pixeles: Uint8Array): Uint8Array {
    // Cada fila va precedida por el byte de filtro (0 = sin filtro).
    const filas = new Uint8Array(alto * (ancho + 1));
    for (let y = 0; y < alto; y++) filas.set(pixeles.subarray(y * ancho, (y + 1) * ancho), y * (ancho + 1) + 1);

    const ihdr = new Uint8Array(13);
    const vista = new DataView(ihdr.buffer);
    vista.setUint32(0, ancho);
    vista.setUint32(4, alto);
    ihdr[8] = 8; // bits por canal
    ihdr[9] = 0; // escala de grises

    return concat([
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(filas, { level: 6 })),
        chunk("IEND", new Uint8Array()),
    ]);
}

function chunk(tipo: string, datos: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + datos.length);
    const vista = new DataView(out.buffer);
    vista.setUint32(0, datos.length);
    for (let i = 0; i < 4; i++) out[4 + i] = tipo.charCodeAt(i);
    out.set(datos, 8);
    vista.setUint32(8 + datos.length, crc32(out.subarray(4, 8 + datos.length)));
    return out;
}

const TABLA_CRC = Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});

function crc32(bytes: Uint8Array): number {
    let c = -1;
    for (const b of bytes) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}

function concat(partes: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of partes) {
        out.set(p, i);
        i += p.length;
    }
    return out;
}
