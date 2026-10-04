import { htmlToSnippet, htmlToText } from "../shared/html.js";
import { cursoAddr, discusionAddr, moduloAddr, padre, parseAddress, RAIZ, type Address } from "./address.js";
import {
    getCourseSections,
    getDiscussionPosts,
    getForumDiscussions,
    getUserCourses,
    POR_PAGINA,
} from "./client/client.js";
import type { AulaSession } from "./client/session.js";
import type { CourseModule, CourseSection } from "./types.js";

const isoDate = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/**
 * Entra a una dirección del aula y devuelve su contenido, el padre y las direcciones de lo que hay
 * adentro. Es el único lugar que decide qué ve el modelo y cuánto texto le cuesta.
 */
export async function open(session: AulaSession, direccion: string, pagina = 0) {
    const address = parseAddress(direccion);
    const base = { direccion: formatear(address), padre: padre(address) };

    switch (address.nivel) {
        case "raiz":
            return { ...base, cursos: await verCursos(session) };

        case "curso":
            return { ...base, secciones: await verCurso(session, address.courseId) };

        case "modulo":
            return { ...base, ...(await verModulo(session, address, pagina)) };

        case "discusion":
            return { ...base, ...(await verDiscusion(session, address.discussionId)) };
    }
}

function formatear(address: Address): string {
    switch (address.nivel) {
        case "raiz":
            return RAIZ;
        case "curso":
            return cursoAddr(address.courseId);
        case "modulo":
            return moduloAddr(address.courseId, address.cmid);
        case "discusion":
            return discusionAddr(address.courseId, address.cmid, address.discussionId);
    }
}

async function verCursos(session: AulaSession) {
    const courses = await getUserCourses(session);
    return courses.map((c) => ({
        direccion: cursoAddr(c.id),
        id: c.id,
        nombre: c.fullname,
        nombreCorto: c.shortname,
        visible: c.visible === 1,
        progreso: c.progress ?? null,
        ultimoAcceso: isoDate(c.lastaccess),
    }));
}

/** El mapa del curso: secciones y módulos, con las descripciones recortadas. */
async function verCurso(session: AulaSession, courseId: number) {
    const sections = await getCourseSections(session, courseId);
    return sections
        .filter((s) => s.uservisible !== false)
        .map((s) => ({
            nombre: s.name,
            numero: s.section,
            resumen: htmlToText(s.summary) || undefined,
            modulos: s.modules.filter((m) => m.uservisible).map((m) => toModule(m, courseId, true)),
        }))
        .filter((s) => s.resumen || s.modulos.length > 0);
}

async function verModulo(session: AulaSession, address: Extract<Address, { nivel: "modulo" }>, pagina: number) {
    const { seccion, module } = await buscarModulo(session, address.courseId, address.cmid);
    const modulo = toModule(module, address.courseId);
    if (module.modname !== "forum") return { seccion, modulo };

    // Un foro es un índice: asuntos y un fragmento de cada uno. El mensaje completo sale al abrir la discusión.
    const { discussions } = await getForumDiscussions(session, module.instance, pagina);
    return {
        seccion,
        modulo,
        discusiones: discussions.map((d) => ({
            direccion: discusionAddr(address.courseId, address.cmid, d.discussion),
            asunto: d.subject,
            autor: d.userfullname,
            fecha: isoDate(d.created),
            ultimaActividad: isoDate(d.timemodified),
            respuestas: d.numreplies,
            fijada: d.pinned || undefined,
            adjuntos: d.attachment || undefined,
            resumen: htmlToSnippet(d.message),
        })),
        pagina,
        hayMasDiscusiones: discussions.length === POR_PAGINA || undefined,
    };
}

async function verDiscusion(session: AulaSession, discussionId: number) {
    const { posts } = await getDiscussionPosts(session, discussionId);
    const visibles = posts.filter((p) => !p.isdeleted);
    return {
        asunto: visibles[0]?.subject,
        publicaciones: visibles.map((p) => ({
            autor: p.author.fullname,
            fecha: isoDate(p.timecreated),
            respuestaA: p.parentid ?? undefined,
            id: p.id,
            mensaje: htmlToText(p.message),
            adjuntos: p.attachments.length ? p.attachments.map(toFile) : undefined,
        })),
    };
}

/** Ubica un módulo por su cmid y se queda con la sección que lo contiene. */
async function buscarModulo(
    session: AulaSession,
    courseId: number,
    cmid: number,
): Promise<{ seccion: string; module: CourseModule }> {
    const sections: CourseSection[] = await getCourseSections(session, courseId, cmid);
    for (const section of sections) {
        const module = section.modules.find((m) => m.id === cmid);
        if (!module) continue;
        if (!module.uservisible) throw new Error(`No tenés acceso al módulo ${cmid}.`);
        return { seccion: section.name, module };
    }
    throw new Error(`No existe el módulo ${cmid} en el curso ${courseId}.`);
}

/** `resumido` recorta la descripción: en el mapa del curso alcanza para decidir si entrar. */
function toModule(m: CourseModule, courseId: number, resumido = false) {
    const contents = m.contents ?? [];
    const archivos = contents.filter((c) => c.type === "file");
    const enlaces = contents.filter((c) => c.type === "url");
    return {
        direccion: moduloAddr(courseId, m.id),
        id: m.id,
        nombre: m.name,
        tipo: m.modname,
        url: m.url,
        descripcion: (resumido ? htmlToSnippet(m.description) : htmlToText(m.description)) || undefined,
        restriccion: htmlToText(m.availabilityinfo) || undefined,
        fechas: m.dates?.length
            ? m.dates.map((d) => ({ etiqueta: d.label, fecha: isoDate(d.timestamp) }))
            : undefined,
        archivos: archivos.length ? archivos.map(toFile) : undefined,
        enlaces: enlaces.length ? enlaces.map((l) => l.fileurl) : undefined,
    };
}

function toFile(f: { filename: string; filepath?: string | null; filesize: number; mimetype?: string; fileurl: string; timemodified?: number | null }) {
    return {
        nombre: f.filename,
        ruta: f.filepath || undefined,
        tamanio: f.filesize,
        mimetype: f.mimetype,
        modificado: isoDate(f.timemodified),
        url: f.fileurl,
    };
}
