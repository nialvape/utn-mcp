import type { McpServer } from "@modelcontextprotocol/server";
import type { AutogestionSession } from "./client/session.js";
import { getCorrelatividades } from "./format/correlatividades.js";
import { getEstadoAcademico } from "./format/estado-academico.js";
import { getExamenes } from "./format/examenes.js";
import { getCursandoAhora } from "./format/notas-parciales.js";

// JSON compacto: indentar estas respuestas cuesta ~25% más de contexto y no se lee mejor.
const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const failure = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
});

export function registerAutogestionTools(server: McpServer, session: AutogestionSession) {
    server.registerTool(
        "autogestion_estado_academico",
        {
            description:
                "Estado académico del usuario según la autogestión de su regional: cada materia OBLIGATORIA " +
                "del plan con su estado (regular, aprobada, libre), plan, nota y fecha. No es el catálogo " +
                "completo de la carrera: puede incluir electivas aprobadas y no listar materias sin " +
                "movimientos cargados. Las que se están cursando se marcan como Cursando cuando el " +
                "sistema permite saberlas. Requiere " +
                "`utn-mcp login autogestion` una vez; las credenciales son las del sistema de autogestión, " +
                "que no siempre son las del aula virtual.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getEstadoAcademico(session));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "autogestion_cursando_ahora",
        {
            description:
                "Materias que el usuario está cursando ahora según la autogestión de su regional, con su " +
                "comisión, aula y horarios cuando el sistema los publica. Incluye electivas, a diferencia " +
                "del estado académico. Requiere `utn-mcp login autogestion` una vez.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getCursandoAhora(session));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "autogestion_examenes",
        {
            description:
                "Historial de exámenes finales del usuario según la autogestión de su regional: fecha, " +
                "materia, nota o estado del examen cuando todavía no hay nota, plan y código. Puede cubrir " +
                "también materias rendidas en planes anteriores y electivas que el estado académico no " +
                "muestra. Requiere `utn-mcp login autogestion` una vez.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getExamenes(session));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "autogestion_correlatividades",
        {
            description:
                "Correlatividades de la carrera del usuario según la autogestión de su regional, separadas " +
                "para cursar y para rendir cuando el sistema las distingue: para cada materia, qué exige " +
                "tener regular o aprobada. Es la fuente dinámica de " +
                "correlatividades: usala en lugar de suponer datos de un plan fijo. Requiere " +
                "`utn-mcp login autogestion` una vez.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getCorrelatividades(session));
            } catch (e) {
                return failure(e);
            }
        },
    );
}
