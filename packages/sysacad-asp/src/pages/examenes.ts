import type { ConnectorKit, ExamenMateria } from "utn-mcp/autogestion";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

export function parseExamenes(kit: ConnectorKit, html: string): ExamenMateria[] {
    const table = tableWithHeaders(kit, html, ["materia", "nota", "fecha"]);
    if (!table) {
        throw new kit.HttpError(
            "La página de exámenes de Sysacad no trajo la tabla esperada (fecha/materia/nota): " +
                "puede haber cambiado el layout. El parser está en packages/sysacad-asp/src/pages/examenes.ts.",
        );
    }
    const col = (k: string) => columnIndex(table, k);
    const [fecha, materia, nota, especialidad, plan, codigo] = [
        col("fecha"),
        col("materia"),
        col("nota"),
        col("especialidad"),
        col("plan"),
        col("código"),
    ];
    return table.rows.map((cells) => {
        const entry: ExamenMateria = { materia: cells[materia] ?? "" };
        if (fecha >= 0) entry.fecha = cells[fecha] || undefined;
        if (nota >= 0) entry.nota = cells[nota] || undefined;
        if (especialidad >= 0) entry.especialidad = cells[especialidad] || undefined;
        if (plan >= 0) entry.plan = cells[plan] || undefined;
        if (codigo >= 0) entry.codigo = cells[codigo] || undefined;
        return entry;
    });
}
