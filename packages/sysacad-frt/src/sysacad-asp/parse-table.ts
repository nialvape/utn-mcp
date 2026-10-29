import { htmlToText } from "utn-mcp/autogestion";

/**
 * Parser tolerante de las tablas de SysacadWEB: HTML 4.01 a puro <table>/<td>, sin clases
 * estables. Se usa la fila de encabezados para ubicar columnas por nombre, y si no hay
 * encabezado reconocible se devuelven las filas crudas para que el modelo las lea.
 * Verificado con cuenta real (oct 2026): la primera fila es un título de una celda
 * ("Estado académico de <alumno> al <fecha>") y la segunda trae las columnas de verdad;
 * el parser no inventa columnas que no vio.
 */
export interface ParsedTable {
    /** Nombres de columna tal como los anuncia la tabla (vacío si no hubo encabezado claro). */
    headers: string[];
    /** Filas de datos, cada celda como texto plano en el orden de las columnas. */
    rows: string[][];
}

/** Todas las tablas de la página, como filas de celdas de texto. */
export function parseTables(html: string): ParsedTable[] {
    const tables: ParsedTable[] = [];
    for (const tableMatch of html.matchAll(/<table[\s>][\s\S]*?<\/table>/gi)) {
        const rows: string[][] = [];
        for (const rowMatch of tableMatch[0].matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
            const cells = [...rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
                htmlToText(c[1]),
            );
            if (cells.length > 0) rows.push(cells);
        }
        // Si la primera fila es un título (menos celdas que la que sigue), el encabezado es la segunda.
        if (rows.length > 1 && rows[0].length < rows[1].length) {
            tables.push({ headers: rows[1], rows: rows.slice(2) });
        } else if (rows.length > 0) {
            tables.push({ headers: rows[0], rows: rows.slice(1) });
        }
    }
    return tables;
}

/** La tabla cuyos encabezados contienen todas las palabras clave (ej. "materia" y "estado"). */
export function tableWithHeaders(html: string, keywords: string[]): ParsedTable | null {
    const wanted = keywords.map((k) => k.toLowerCase());
    for (const table of parseTables(html)) {
        const headers = table.headers.join(" ").toLowerCase();
        if (wanted.every((w) => headers.includes(w))) return table;
    }
    return null;
}

/** Índice de la primera columna cuyo encabezado contiene la palabra, o -1. */
export function columnIndex(table: ParsedTable, keyword: string): number {
    return table.headers.findIndex((h) => h.toLowerCase().includes(keyword.toLowerCase()));
}
