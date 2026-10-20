import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { FileSource } from "../shared/uploads.js";
import { getSiteInfo } from "./client/client.js";
import type { AulaSession } from "./client/session.js";
import {
    addCalendarEvent,
    answerChoice,
    deleteForumPost,
    editForumPost,
    postToForum,
    sendMessage,
} from "./format/actions.js";
import { ROOT } from "./format/address.js";
import { readAulaFile } from "./format/files.js";
import { open } from "./format/navigate.js";
import { createUploadLink, submitAssignment } from "./format/submission.js";

// JSON compacto: indentar estas respuestas cuesta ~25% más de contexto y no se lee mejor.
const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

const failure = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
});

/** Para que el cliente distinga las tools que leen de las que cambian algo en el aula. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

export function registerAulaVirtualTools(server: McpServer, session: AulaSession, files: FileSource) {
    server.registerTool(
        "aula_get_site_info",
        {
            description:
                "Datos del usuario logueado y del sitio Moodle de su aula virtual. `regional` es la regional de la UTN " +
                "de esa aula (por ejemplo, \"Tucumán (FRT)\"): usala para hablarle de su facultad.",
            annotations: READ_ONLY,
        },
        async () => {
            try {
                const [{ sitename, fullname, username, userid, release }, regional] = await Promise.all([
                    getSiteInfo(session),
                    session.getRegional(),
                ]);
                return json({ regional: regional.name, sitename, fullname, username, userid, release });
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
            annotations: READ_ONLY,
        },
        async () => {
            try {
                return json(await open(session, ROOT));
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
                "Según el tipo de módulo trae además: en una tarea (assign), `entrega` con el estado, el " +
                "vencimiento, lo que se subió y la devolución con la nota; en una elección (choice) o " +
                "selección de grupos (choicegroup), `eleccion` con las opciones y sus ids; en un foro, " +
                "`puedeAbrirHilo`; en una discusión, el `id`, el `autorId` y las `acciones` permitidas de " +
                "cada publicación. Es lo que piden las tools que escriben en el aula.\n\n" +
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
            annotations: READ_ONLY,
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
            annotations: READ_ONLY,
        },
        async ({ url, desde }) => {
            try {
                const { parts, ...fileRead } = await readAulaFile(session, url, desde);
                const label = (n: number, title?: string) =>
                    `--- ${fileRead.unidad} ${n} de ${fileRead.total}${title ? ` (${title})` : ""} ---`;
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify(fileRead) },
                        ...parts.flatMap((p) =>
                            "text" in p
                                ? [{ type: "text" as const, text: `${label(p.number, p.title)}\n${p.text}` }]
                                : [
                                      { type: "text" as const, text: label(p.number, p.title) },
                                      {
                                          type: "image" as const,
                                          data: Buffer.from(p.image).toString("base64"),
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

    // --- Escritura: lo que sigue cambia algo en el aula, y casi todo queda a la vista de otras personas. ---

    const CONFIRM_FIRST =
        "\n\nAntes de llamarla, mostrale al usuario exactamente lo que se va a hacer y esperá que confirme.";

    server.registerTool(
        "aula_forum_post",
        {
            description:
                "Publica en un foro del aula virtual. Con la `direccion` de un foro abre un hilo nuevo (hace " +
                "falta `asunto`); con la de una discusión responde en ella, a la publicación `respuestaA` o, " +
                "si no se indica, a la primera.\n\n" +
                "Lo que se publica lo ven docentes y compañeros, y a muchos les llega por mail. Antes de abrir " +
                "un hilo, mirá `puedeAbrirHilo` del foro; antes de responder, que la publicación tenga " +
                '"responder" en `acciones`.' +
                CONFIRM_FIRST,
            inputSchema: z.object({
                direccion: z
                    .string()
                    .describe(
                        'Dirección de un foro o de una discusión. Ej: "/curso/691/mod/34831" o ' +
                            '"/curso/691/mod/34831/disc/416676".',
                    ),
                mensaje: z
                    .string()
                    .min(1)
                    .describe(
                        "Texto del mensaje, en texto plano. Una línea en blanco separa párrafos. " +
                            'Ej: "Hola, ¿el parcial incluye la unidad 4?"',
                    ),
                asunto: z
                    .string()
                    .optional()
                    .describe(
                        'Obligatorio para abrir un hilo. En una respuesta, por defecto "Re: <asunto>". ' +
                            'Ej: "Consulta sobre el parcial".',
                    ),
                respuestaA: z
                    .number()
                    .int()
                    .optional()
                    .describe("Solo al responder: `id` de la publicación a la que se responde, de aula_open. Ej: 768118."),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ direccion, mensaje, asunto, respuestaA }) => {
            try {
                return json(await postToForum(session, direccion, mensaje, asunto, respuestaA));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_forum_edit_post",
        {
            description:
                "Edita una publicación propia de un foro y reemplaza el mensaje completo. Solo se puede si la " +
                'publicación tiene "editar" en `acciones`: Moodle deja editar por un rato después de publicar.' +
                CONFIRM_FIRST,
            inputSchema: z.object({
                direccion: z
                    .string()
                    .describe('Dirección de la discusión donde está la publicación. Ej: "/curso/691/mod/34831/disc/416676".'),
                id: z.number().int().describe("`id` de la publicación, de aula_open. Ej: 768118."),
                mensaje: z
                    .string()
                    .min(1)
                    .describe('El mensaje nuevo completo, en texto plano; reemplaza al anterior. Ej: "Ya lo resolví, gracias."'),
                asunto: z
                    .string()
                    .optional()
                    .describe('Asunto nuevo. Si no se pasa, queda el que tenía. Ej: "Consulta sobre el parcial (resuelta)".'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ direccion, id, mensaje, asunto }) => {
            try {
                return json(await editForumPost(session, direccion, id, mensaje, asunto));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_forum_delete_post",
        {
            description:
                "Borra una publicación propia de un foro. No se puede deshacer. Solo se puede si tiene " +
                '"borrar" en `acciones`. Si es la primera publicación de la discusión, se borra la discusión ' +
                "entera." +
                CONFIRM_FIRST,
            inputSchema: z.object({
                direccion: z
                    .string()
                    .describe('Dirección de la discusión donde está la publicación. Ej: "/curso/691/mod/34831/disc/416676".'),
                id: z.number().int().describe("`id` de la publicación, de aula_open. Ej: 768118."),
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        async ({ direccion, id }) => {
            try {
                return json(await deleteForumPost(session, direccion, id));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_choice_answer",
        {
            description:
                'Responde una elección (choice: encuestas rápidas como "¿venís al parcial?") o una selección ' +
                "de grupos (choicegroup: anotarse en un grupo o comisión). Deja elegidas exactamente las " +
                "`opciones` pasadas y reemplaza la respuesta anterior; con una lista vacía la borra.\n\n" +
                "Las opciones salen de `eleccion` al abrir el módulo con aula_open. Muchas no dejan cambiar " +
                "la respuesta una vez dada (`puedeCambiar: false`), y las opciones `deshabilitada` están " +
                "completas. Devuelve cómo quedó la elección." +
                CONFIRM_FIRST,
            inputSchema: z.object({
                direccion: z.string().describe('Dirección del módulo. Ej: "/curso/29487/mod/1729113".'),
                opciones: z
                    .array(z.number().int())
                    .describe("`id` de las opciones a elegir. Ej: [31076]. Varias solo si la actividad lo permite."),
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async ({ direccion, opciones }) => {
            try {
                return json(await answerChoice(session, direccion, opciones));
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_send_message",
        {
            description:
                "Manda un mensaje privado por la mensajería del aula virtual a otro usuario, docente o " +
                "compañero. El `usuarioId` sale del `autorId` de un foro o una discusión abiertos con " +
                "aula_open: no lo inventes ni lo deduzcas del nombre. La respuesta trae el nombre del " +
                "destinatario." +
                CONFIRM_FIRST +
                " Incluí a quién va dirigido.",
            inputSchema: z.object({
                usuarioId: z.number().int().describe("Id del destinatario, del `autorId` de aula_open. Ej: 1066."),
                mensaje: z
                    .string()
                    .min(1)
                    .describe('Texto del mensaje, en texto plano. Ej: "Profe, ¿puedo rendir el recuperatorio el viernes?"'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async ({ usuarioId, mensaje }) => {
            try {
                return json(await sendMessage(session, usuarioId, mensaje));
            } catch (e) {
                return failure(e);
            }
        },
    );

    // En STDIO el servidor lee el archivo del disco del usuario; en HTTP no puede, porque puede estar en
    // otra máquina: los archivos llegan por un link de subida, que usa el agente o el usuario.
    const newFiles = files.local
        ? "Los archivos nuevos se pasan en `archivos` con su ruta absoluta en la compu del usuario."
        : "Los archivos nuevos no van en la llamada: primero pedí un link con aula_assign_upload_link, " +
          "subilos ahí y después pasá su id en `subida`.";

    if (!files.local) {
        const { inbox, owner } = files;
        server.registerTool(
            "aula_assign_upload_link",
            {
                description:
                    "Genera un link de un solo uso para subir los archivos de una entrega, que después se " +
                    "entregan con aula_assign_submit pasando el `subida` que devuelve. Vence en 30 minutos.\n\n" +
                    "Cómo subirlos:\n" +
                    "- Si podés ejecutar comandos y tenés el archivo (por ejemplo, uno que el usuario adjuntó o " +
                    "que está en su compu), subilo vos con el comando de `conTerminal`, cambiando la ruta. Va un " +
                    '`-F "archivos=@..."` por archivo, todos en el mismo comando. Responde JSON con lo recibido.\n' +
                    "- Si no, pasale el `url` al usuario: se abre en el navegador, también en el celu, y elige " +
                    "los archivos ahí. Esperá a que te diga que los subió.\n\n" +
                    "Subir al link no entrega nada. Cada link acepta una sola subida: si hay que cambiar los " +
                    "archivos, pedí otro link. " +
                    "`acepta` trae los límites de la tarea.",
                inputSchema: z.object({
                    direccion: z
                        .string()
                        .describe('Dirección de la tarea, de aula_open. Ej: "/curso/29487/mod/1729138".'),
                }),
                annotations: { readOnlyHint: true, openWorldHint: false },
            },
            async ({ direccion }) => {
                try {
                    return json(await createUploadLink(session, direccion, inbox, owner));
                } catch (e) {
                    return failure(e);
                }
            },
        );
    }

    const submitSchema = z.object({
        direccion: z.string().describe('Dirección de la tarea, de aula_open. Ej: "/curso/29487/mod/1729138".'),
        archivos: z
            .array(z.string())
            .optional()
            .describe(
                files.local
                    ? "Lista final de archivos. Cada uno es la ruta absoluta de un archivo en la compu del " +
                          "usuario o la `url` de uno que ya está en la entrega. Lista vacía: quita todos. " +
                          'Ej: ["C:\\Users\\ana\\Documents\\TP3.pdf"].'
                    : "Lista final de los archivos que ya están en la entrega, por su `url` de aula_open; los " +
                          "de `subida` se suman. Lista vacía: quita los que estaban. " +
                          'Ej: ["https://<aula>/pluginfile.php/123/assignsubmission_file/submission_files/456/TP3.pdf"], ' +
                          "con el dominio del aula tal como viene en la `url`.",
            ),
        texto: z
            .string()
            .optional()
            .describe(
                "Texto en línea completo, en texto plano; reemplaza al anterior. Una línea en blanco " +
                    'separa párrafos. Ej: "Link al repositorio: https://github.com/ana/tp3"',
            ),
        enviar: z
            .boolean()
            .optional()
            .describe(
                "Solo en tareas con borradores: confirmar el envío para que cuente como entregada. Por " +
                    "defecto, true. Ej: false para dejarla como borrador.",
            ),
        aceptoDeclaracion: z
            .boolean()
            .optional()
            .describe(
                "true si el usuario aceptó la `declaracion` de la tarea. Solo hace falta si la tarea la pide. Ej: true.",
            ),
    });
    const httpSubmitSchema = submitSchema.extend({
        subida: z
            .string()
            .optional()
            .describe(
                "`subida` de aula_assign_upload_link, ya usado: sus archivos se suman a la entrega. " +
                    'Ej: "q3Vx9kP2mW7tR1yZ8nB4cD6fG0hJ5lA".',
            ),
    });

    server.registerTool(
        "aula_assign_submit",
        {
            description:
                "Entrega una tarea (assign) del aula virtual: sube archivos, escribe el texto en línea o las " +
                "dos cosas, según lo que acepte la tarea. Antes, abrila con aula_open: `entrega` dice qué " +
                "acepta (`acepta`, con tipos, cantidad y tamaño), si `puedeEditar` y lo que ya está subido.\n\n" +
                newFiles +
                " `archivos` es la lista final y reemplaza lo anterior: para sumar uno sin perder los otros, " +
                "incluí la `url` de cada archivo que ya está en la entrega. Si no pasás `archivos`, quedan " +
                "los que estaban; lo mismo con `texto`.\n\n" +
                "Si la tarea no usa borradores, guardar ya es entregar. Si los usa (`requiereConfirmarEnvio`), " +
                "la tool además confirma el envío, salvo con `enviar: false`; una vez enviada, en general no se " +
                "puede cambiar. Con `declaracion`, el usuario tiene que aceptarla (`aceptoDeclaracion`). " +
                "Devuelve cómo quedó la entrega." +
                CONFIRM_FIRST +
                " Incluí la tarea, los nombres de los archivos y si se confirma el envío.",
            // `subida` existe solo en HTTP; el cast es para que el handler la vea en los dos modos.
            inputSchema: (files.local ? submitSchema : httpSubmitSchema) as typeof httpSubmitSchema,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async ({ direccion, archivos, subida, texto, enviar, aceptoDeclaracion }) => {
            try {
                return json(
                    await submitAssignment(
                        session,
                        direccion,
                        {
                            files: archivos,
                            upload: subida,
                            text: texto,
                            send: enviar ?? true,
                            acceptStatement: aceptoDeclaracion ?? false,
                        },
                        files,
                    ),
                );
            } catch (e) {
                return failure(e);
            }
        },
    );

    server.registerTool(
        "aula_calendar_add_event",
        {
            description:
                "Agrega un evento personal al calendario del aula virtual, que solo ve el usuario: por ejemplo " +
                "un recordatorio de un parcial o una entrega. El aula avisa según la configuración de " +
                "notificaciones del usuario. La fecha va con zona horaria; en Argentina es -03:00.",
            inputSchema: z.object({
                nombre: z.string().min(1).describe('Título del evento. Ej: "Parcial de Física II".'),
                inicio: z
                    .string()
                    .describe('Fecha y hora en ISO 8601 con zona horaria. Ej: "2026-10-14T18:00:00-03:00".'),
                duracionMinutos: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("Duración en minutos. Por defecto, sin duración. Ej: 120."),
                descripcion: z.string().optional().describe('Detalle, en texto plano. Ej: "Aula 312, unidades 1 a 4".'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async ({ nombre, inicio, duracionMinutos, descripcion }) => {
            try {
                return json(
                    await addCalendarEvent(session, {
                        name: nombre,
                        start: inicio,
                        durationMinutes: duracionMinutos,
                        description: descripcion,
                    }),
                );
            } catch (e) {
                return failure(e);
            }
        },
    );
}
