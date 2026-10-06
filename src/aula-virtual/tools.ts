import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { getSiteInfo } from "./client/client.js";
import type { AulaSession } from "./client/session.js";
import { RAIZ } from "./format/address.js";
import { leerArchivo } from "./format/files.js";
import { open } from "./format/navigate.js";

// JSON compacto: indentar estas respuestas cuesta ~25% más de contexto y no se lee mejor.
const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
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
        {
            description:
                "Lista los cursos (materias) en los que está inscripto el usuario. Es el punto de entrada: " +
                "cada curso viene con su `direccion`, que se le pasa a aula_open para entrar.",
        },
        async () => {
            try {
                return json(await open(session, RAIZ));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_open",
        {
            description:
                "Entra a una dirección del aula virtual y devuelve lo que hay ahí: un curso con sus secciones " +
                "y módulos, un módulo con sus archivos y fechas, un foro con el índice de sus discusiones, o " +
                "una discusión con sus mensajes completos.\n\n" +
                "No hace falta armar la dirección: cada respuesta trae las direcciones de lo que hay adentro " +
                "(`direccion`) y la de un nivel más arriba (`padre`), así que se navega pasando de vuelta una " +
                "de esas. Para empezar, usar aula_list_courses o la dirección \"/\".\n\n" +
                "Buscar algo que puede estar en cualquier parte (una fecha de parcial, un aviso) se hace " +
                "entrando al curso y abriendo lo que corresponda: el índice de un foro muestra los asuntos sin " +
                "volcar los mensajes enteros, y archivos como un cronograma se leen con aula_read_file.\n\n" +
                "Los archivos vienen con una `url`, que sirve para leerlos con aula_read_file y también para " +
                "dársela al usuario si quiere bajarlo: se abre con su sesión del aula.",
            inputSchema: z.object({
                direccion: z
                    .string()
                    .describe(
                        'Dirección a abrir, sacada de una respuesta anterior. Ej: "/", "/curso/691", ' +
                            '"/curso/691/mod/34806", "/curso/691/mod/34806/disc/421348".',
                    ),
                pagina: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe(
                        "Solo para foros: página del índice de discusiones, de 50 en 50. La respuesta avisa " +
                            "con `hayMasDiscusiones` cuando hay otra.",
                    ),
            }),
        },
        async ({ direccion, pagina }) => {
            try {
                return json(await open(session, direccion, pagina));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_read_file",
        {
            description:
                "Lee un archivo del aula virtual: PDF, Word (docx), PowerPoint (pptx), Excel (xlsx), imágenes y " +
                "texto. Los PDF escaneados se devuelven como imagen de cada página.\n\n" +
                "Devuelve el archivo por partes (páginas, diapositivas o fragmentos), tantas como entren en una " +
                "respuesta. Si quedan más, `siguiente` dice desde cuál pedir; también se puede saltar directo " +
                "a una parte con `desde`.\n\n" +
                "Formatos que no sabe leer (.doc, .ppt viejos, .zip, .rar, videos): devuelve un error con la URL " +
                "para que el usuario lo baje.",
            inputSchema: z.object({
                url: z.string().describe("La `url` del archivo tal como la devuelve aula_open."),
                desde: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Número de página, diapositiva o fragmento desde el cual leer. Por defecto, 1."),
            }),
        },
        async ({ url, desde }) => {
            try {
                const { partes, ...lectura } = await leerArchivo(session, url, desde);
                const etiqueta = (n: number, titulo?: string) =>
                    `--- ${lectura.unidad} ${n} de ${lectura.total}${titulo ? ` (${titulo})` : ""} ---`;
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify(lectura) },
                        ...partes.flatMap((p) =>
                            "texto" in p
                                ? [{ type: "text" as const, text: `${etiqueta(p.numero, p.titulo)}\n${p.texto}` }]
                                : [
                                      { type: "text" as const, text: etiqueta(p.numero, p.titulo) },
                                      {
                                          type: "image" as const,
                                          data: Buffer.from(p.imagen).toString("base64"),
                                          mimeType: p.mimeType,
                                      },
                                  ],
                        ),
                    ],
                };
            } catch (e) {
                return failure(e);
            }
        },
    );
}
