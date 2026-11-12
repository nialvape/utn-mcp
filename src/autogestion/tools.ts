import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { FileSource } from "../shared/uploads.js";
import type { AutogestionSession } from "./client/session.js";
import { certificadoEmbebido, descargarCertificado, getCertificados } from "./format/certificados.js";
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

/** Igual para todas: el login es distinto en local (CLI) y en HTTP (link), así que lo explica el error. */
const LOGIN_NOTE =
    " Si todavía no entró a su autogestión, el error dice cómo hacerlo; seguilo. Las credenciales son las del " +
    "sistema de autogestión, que no siempre son las del aula virtual.";

export function registerAutogestionTools(server: McpServer, session: AutogestionSession, files: FileSource) {
    server.registerTool(
        "autogestion_estado_academico",
        {
            description:
                "Estado académico del usuario según la autogestión de su regional: cada materia OBLIGATORIA " +
                "del plan con su estado (regular, aprobada, libre), plan, nota y fecha. No es el catálogo " +
                "completo de la carrera: puede incluir electivas aprobadas y no listar materias sin " +
                "movimientos cargados. Las que se están cursando se marcan como Cursando cuando el " +
                "sistema permite saberlas." + LOGIN_NOTE,
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
                "del estado académico." + LOGIN_NOTE,
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
                "muestra." + LOGIN_NOTE,
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
        "autogestion_certificados",
        {
            description:
                "Certificados y constancias que la autogestión de la regional del usuario ofrece descargar " +
                "(en Sysacad: el certificado de alumno regular y la actividad académica, con validación por " +
                "código QR cuando la regional los habilita). Devuelve cada uno con su `nombre` y una " +
                "`referencia` para pedir la descarga con autogestion_descargar_certificado. Es solo lectura: " +
                "no solicita ni inicia trámites; si el portal no ofrece un certificado online, acá no " +
                "aparece." + LOGIN_NOTE,
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            try {
                return json(await getCertificados(session));
            } catch (e) {
                return failure(e);
            }
        },
    );

    // En local el servidor corre en la compu del usuario y el archivo queda en su disco; en HTTP puede
    // estar en otra máquina, así que el certificado viaja adentro de la respuesta como recurso embebido.
    const descargaDescripcion = files.local
        ? "Descarga un certificado o constancia de la autogestión y lo guarda en la compu del usuario. " +
          "La `referencia` sale de autogestion_certificados; la respuesta trae `archivo` con la ruta del " +
          "archivo guardado (PDF cuando el sistema lo genera así). Es solo lectura: baja un documento que " +
          "el portal ya permite descargar, no inicia trámites."
        : "Descarga un certificado o constancia de la autogestión. La `referencia` sale de " +
          "autogestion_certificados. En modo HTTP el archivo NO se guarda en la compu del usuario: viaja " +
          "adentro de esta respuesta como recurso embebido (blob base64 + `mimeType`), junto a los datos " +
          "en texto. Si tu cliente no puede guardar recursos embebidos, decile al usuario que use el modo " +
          "local (STDIO), donde el servidor corre en su compu y el certificado sí queda en su disco. Es " +
          "solo lectura: baja un documento que el portal ya permite descargar, no inicia trámites.";

    server.registerTool(
        "autogestion_descargar_certificado",
        {
            description: descargaDescripcion + LOGIN_NOTE,
            inputSchema: z.object({
                referencia: z
                    .string()
                    .describe('La `referencia` del certificado, tal como la devuelve autogestion_certificados. Ejemplo: "certalreg.asp".'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ referencia }) => {
            try {
                if (files.local) return json(await descargarCertificado(session, referencia));
                const { nombre, mimeType, bytes } = await certificadoEmbebido(session, referencia);
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify({ nombre, mimeType }) },
                        {
                            type: "resource" as const,
                            resource: {
                                uri: `autogestion://certificados/${referencia}`,
                                mimeType,
                                blob: Buffer.from(bytes).toString("base64"),
                            },
                        },
                    ],
                };
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
                "correlatividades: usala en lugar de suponer datos de un plan fijo." + LOGIN_NOTE,
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
