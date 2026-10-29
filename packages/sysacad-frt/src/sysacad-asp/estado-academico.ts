import { HttpError } from "utn-mcp/autogestion";
import type { EstadoMateria } from "utn-mcp/autogestion";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

/**
 * Estado académico del alumno en su autogestión: la tabla cuyo encabezado nombra materia y estado.
 * El mapeo de columnas sigue los encabezados reales de la página; lo que no matchea queda en `extra`.
 */
export function parseEstadoAcademico(html: string): EstadoMateria[] {
    const table = tableWithHeaders(html, ["materia", "estado"]);
    if (!table) {
        throw new HttpError(
            "La página de estado académico de Sysacad no trajo la tabla esperada (materia/estado): " +
                "puede haber cambiado el layout. El parser está en src/autogestion/client/sysacad-asp/estado-academico.ts.",
        );
    }
    const col = (k: string) => columnIndex(table, k);
    const [materia, estado, plan, anio, nota, fecha] = [
        col("materia"),
        col("estado"),
        col("plan"),
        col("año"),
        col("nota"),
        col("fecha"),
    ];
    const known = new Set([materia, estado, plan, anio, nota, fecha].filter((i) => i >= 0));
    return table.rows.map((cells) => {
        const entry: EstadoMateria = { materia: cells[materia] ?? "" };
        if (estado >= 0) entry.estado = cells[estado] || undefined;
        if (plan >= 0) entry.plan = cells[plan] || undefined;
        if (anio >= 0) entry.anio = cells[anio] || undefined;
        if (nota >= 0) entry.nota = cells[nota] || undefined;
        if (fecha >= 0) entry.fecha = cells[fecha] || undefined;
        const extra = cells.filter((_, i) => !known.has(i) && cells[i]);
        if (extra.length > 0) entry.extra = extra;
        return entry;
    });
}
