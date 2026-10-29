import { HttpError } from "utn-mcp/autogestion";
import type { CorrelatividadMateria } from "utn-mcp/autogestion";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

/** La tabla de correlatividades de una página: encabezado con materia y correlatividad. */
export function parseCorrelatividadesPagina(html: string, pagina: string): CorrelatividadMateria[] {
    const table = tableWithHeaders(html, ["materia", "correlatividad"]);
    if (!table) {
        throw new HttpError(
            `La página de correlatividades para ${pagina} de Sysacad no trajo la tabla esperada ` +
                "(materia/correlatividad): puede haber cambiado el layout. " +
                "El parser está en src/autogestion/client/sysacad-asp/correlatividades.ts.",
        );
    }
    const materia = columnIndex(table, "materia");
    const correlativas = columnIndex(table, "correlatividad");
    const plan = columnIndex(table, "plan");
    const anio = columnIndex(table, "año");
    const known = new Set([materia, correlativas, plan, anio].filter((i) => i >= 0));
    return table.rows.map((cells) => {
        const entry: CorrelatividadMateria = {
            materia: cells[materia] ?? "",
            correlativas: cells[correlativas] ?? "",
        };
        if (plan >= 0) entry.plan = cells[plan] || undefined;
        if (anio >= 0) entry.anio = cells[anio] || undefined;
        const extra = cells.filter((_, i) => !known.has(i) && cells[i]);
        if (extra.length > 0) entry.extra = extra;
        return entry;
    });
}
