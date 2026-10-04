import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { getCourseContents, getSiteInfo, listCourses } from "./client/client.js";
import type { AulaSession } from "./client/session.js";

const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const failure = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
});

export function registerAulaVirtualTools(server: McpServer, session: AulaSession) {
    server.registerTool(
        "aula_get_site_info",
        { description: "Datos del usuario logueado en el aula virtual de la UTN FRBA y del sitio Moodle." },
        async () => {
            try {
                const { sitename, fullname, username, userid, release } = await getSiteInfo(session);
                return json({ sitename, fullname, username, userid, release });
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_list_courses",
        { description: "Lista los cursos (materias) en los que está inscripto el usuario en el aula virtual." },
        async () => {
            try {
                return json(await listCourses(session));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_get_course_contents",
        {
            description:
                "Contenido de un curso del aula virtual: secciones (unidades/semanas) con sus actividades " +
                "(archivos, links, foros, tareas, etc.), fechas y archivos adjuntos. " +
                "El id del curso sale de aula_list_courses.",
            inputSchema: z.object({
                courseId: z.number().int().positive().describe("id del curso, de aula_list_courses"),
            }),
        },
        async ({ courseId }) => {
            try {
                return json(await getCourseContents(session, courseId));
            } catch (e) {
                return failure(e);
            }
        },
    );
}
