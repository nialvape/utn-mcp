import { htmlToText } from "../html.js";
import { abrirOffice, formatoOffice } from "./office.js";
import { abrirPdf } from "./pdf.js";

/**
 * Lectura de archivos para el modelo: un documento se parte en unidades (páginas, diapositivas,
 * fragmentos) que se piden de a una, así quien lee decide cuánto entra en una respuesta.
 */

export type Parte =
    | { titulo?: string; texto: string }
    | { titulo?: string; imagen: Uint8Array; mimeType: string };

export interface Documento {
    formato: string;
    /** Cómo se llama cada parte: "página", "diapositiva", "fragmento"... */
    unidad: string;
    total: number;
    /** Numerada desde 1. */
    parte(n: number): Promise<Parte>;
    cerrar(): Promise<void>;
}

export class FormatoNoSoportado extends Error {
    constructor(readonly formato: string) {
        super(`No sé leer archivos ${formato}.`);
        this.name = "FormatoNoSoportado";
    }
}

/** Tamaño de cada fragmento cuando un texto largo viene de una sola pieza (un docx, un html). */
export const FRAGMENTO = 15_000;

const IMAGENES: [number[], string][] = [
    [[0x89, 0x50, 0x4e, 0x47], "image/png"],
    [[0xff, 0xd8, 0xff], "image/jpeg"],
    [[0x47, 0x49, 0x46, 0x38], "image/gif"],
];

const empieza = (bytes: Uint8Array, firma: number[]) => firma.every((b, i) => bytes[i] === b);

/** Reconoce el formato por los primeros bytes; el nombre solo se usa para los de texto plano. */
export async function abrirDocumento(bytes: Uint8Array, nombre: string): Promise<Documento> {
    if (empieza(bytes, [0x25, 0x50, 0x44, 0x46])) return abrirPdf(bytes);

    for (const [firma, mimeType] of IMAGENES) {
        if (empieza(bytes, firma)) return deTexto("imagen", "imagen", [{ imagen: bytes, mimeType }]);
    }

    if (empieza(bytes, [0x50, 0x4b, 0x03, 0x04])) {
        const formato = formatoOffice(bytes);
        if (!formato) throw new FormatoNoSoportado("comprimidos (.zip)");
        return abrirOffice(bytes, formato);
    }

    if (empieza(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
        throw new FormatoNoSoportado("de Office viejo (.doc, .xls, .ppt, .pps)");
    }

    const extension = nombre.toLowerCase().match(/\.(\w+)$/)?.[1] ?? "";
    if (["txt", "csv", "md", "html", "htm"].includes(extension)) {
        const texto = new TextDecoder().decode(bytes);
        const plano = extension.startsWith("htm") ? htmlToText(texto) : texto;
        return deTexto(extension, "fragmento", fragmentar(plano).map((t) => ({ texto: t })));
    }

    throw new FormatoNoSoportado(extension ? `.${extension}` : "de este tipo");
}

/** Un documento que ya está entero en memoria. */
export function deTexto(formato: string, unidad: string, partes: Parte[]): Documento {
    return {
        formato,
        unidad,
        total: partes.length,
        parte: async (n) => partes[n - 1],
        cerrar: async () => {},
    };
}

/** Corta un texto largo en pedazos de hasta `max` caracteres, prefiriendo cortar en un salto de línea. */
export function fragmentar(texto: string, max = FRAGMENTO): string[] {
    const fragmentos: string[] = [];
    let resto = texto.trim();
    while (resto.length > max) {
        const corte = resto.lastIndexOf("\n", max);
        const fin = corte > max / 2 ? corte : max;
        fragmentos.push(resto.slice(0, fin).trim());
        resto = resto.slice(fin).trim();
    }
    if (resto || fragmentos.length === 0) fragmentos.push(resto);
    return fragmentos;
}
