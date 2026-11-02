import type { ConnectorKit, NotasParcialesMateria } from "utn-mcp/autogestion";
import { columnIndex, tableWithHeaders } from "./parse-table.js";

export function normalizarMateria(nombre: string): string {
    return nombre
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

export function parseNotasParciales(kit: ConnectorKit, html: string): NotasParcialesMateria[] {
    const table = tableWithHeaders(kit, html, ["materia", "horarios"]);
    if (!table) {
        throw new kit.HttpError(
            "La página de notas de parciales de Sysacad no trajo la tabla esperada (materia/horarios): " +
                "puede haber cambiado el layout. El parser está en packages/sysacad-asp/src/pages/notas-parciales.ts.",
        );
    }
    const col = (k: string) => columnIndex(table, k);
    const [materia, anio, comision, aula, horarios, notas, inasistencias, obs] = [
        col("materia"),
        col("año"),
        col("comisión"),
        col("aula"),
        col("horarios"),
        col("notas"),
        col("inasistencias"),
        col("obs"),
    ];
    return table.rows.map((cells) => {
        const carga = horarios >= 0 ? (cells[horarios] ?? "").trim() : "";
        const entry: NotasParcialesMateria = {
            materia: cells[materia] ?? "",
            cursando: carga.length > 0,
        };
        if (anio >= 0) entry.anio = cells[anio] || undefined;
        if (comision >= 0) entry.comision = cells[comision] || undefined;
        if (aula >= 0) entry.aula = cells[aula] || undefined;
        if (carga) entry.horarios = carga;
        if (notas >= 0) entry.notas = cells[notas] || undefined;
        if (inasistencias >= 0) entry.inasistencias = cells[inasistencias] || undefined;
        if (obs >= 0) entry.obs = cells[obs] || undefined;
        return entry;
    });
}
