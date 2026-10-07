import { htmlToSnippet, htmlToText } from "../../shared/html.js";
import {
    courseAddr,
    discussionAddr,
    formatAddress,
    moduleAddr,
    parentOf,
    parseAddress,
    type Address,
} from "./address.js";
import {
    canAddDiscussion,
    getCourseSections,
    getDiscussionPosts,
    getForumDiscussions,
    getUserCourses,
    PAGE_SIZE,
} from "../client/client.js";
import type { AulaSession } from "../client/session.js";
import type { CourseModule, CourseSection } from "../client/types.js";
import { viewChoice, viewChoicegroup, viewSubmission } from "./activities.js";
import { isoDate, toFile } from "./fields.js";

type ModuleAddress = Extract<Address, { level: "module" }>;

/**
 * Entra a una dirección del aula y devuelve su contenido, el padre y las direcciones de lo que hay
 * adentro. Es el único lugar que decide qué ve el modelo y cuánto texto le cuesta.
 */
export async function open(session: AulaSession, rawAddress: string, page = 0) {
    const address = parseAddress(rawAddress);
    const base = { direccion: formatAddress(address), padre: parentOf(address) };

    switch (address.level) {
        case "root":
            return { ...base, cursos: await viewCourses(session) };

        case "course":
            return { ...base, secciones: await viewCourse(session, address.courseId) };

        case "module":
            return { ...base, ...(await viewModule(session, address, page)) };

        case "discussion":
            return { ...base, ...(await viewDiscussion(session, address.discussionId)) };
    }
}

async function viewCourses(session: AulaSession) {
    const courses = await getUserCourses(session);
    return courses.map((c) => ({
        direccion: courseAddr(c.id),
        id: c.id,
        nombre: c.fullname,
        nombreCorto: c.shortname,
        visible: c.visible === 1,
        progreso: c.progress ?? null,
        ultimoAcceso: isoDate(c.lastaccess),
    }));
}

/** El mapa del curso: secciones y módulos, con las descripciones recortadas. */
async function viewCourse(session: AulaSession, courseId: number) {
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

async function viewModule(session: AulaSession, address: ModuleAddress, page: number) {
    const { sectionName, module } = await findModule(session, address.courseId, address.cmid);
    const base = { seccion: sectionName, modulo: toModule(module, address.courseId) };
    switch (module.modname) {
        case "forum":
            return { ...base, ...(await viewForum(session, address, module.instance, page)) };
        case "assign":
            return { ...base, entrega: await viewSubmission(session, address.courseId, module) };
        case "choice":
            return { ...base, eleccion: await viewChoice(session, address.courseId, module) };
        case "choicegroup":
            return { ...base, eleccion: await viewChoicegroup(session, module) };
        default:
            return base;
    }
}

/** Un foro es un índice: asuntos y un fragmento de cada uno. El mensaje completo sale al abrir la discusión. */
async function viewForum(session: AulaSession, address: ModuleAddress, forumid: number, page: number) {
    const [{ discussions }, canStartDiscussion] = await Promise.all([
        getForumDiscussions(session, forumid, page),
        canAddDiscussion(session, forumid),
    ]);
    return {
        puedeAbrirHilo: canStartDiscussion,
        discusiones: discussions.map((d) => ({
            direccion: discussionAddr(address.courseId, address.cmid, d.discussion),
            asunto: d.subject,
            autor: d.userfullname,
            autorId: d.userid,
            fecha: isoDate(d.created),
            ultimaActividad: isoDate(d.timemodified),
            respuestas: d.numreplies,
            fijada: d.pinned || undefined,
            adjuntos: d.attachment || undefined,
            resumen: htmlToSnippet(d.message),
        })),
        pagina: page,
        hayMasDiscusiones: discussions.length === PAGE_SIZE || undefined,
    };
}

async function viewDiscussion(session: AulaSession, discussionId: number) {
    const { posts } = await getDiscussionPosts(session, discussionId);
    const visible = posts.filter((p) => !p.isdeleted);
    return {
        asunto: visible[0]?.subject,
        publicaciones: visible.map((p) => ({
            autor: p.author.fullname,
            autorId: p.author.id,
            fecha: isoDate(p.timecreated),
            respuestaA: p.parentid ?? undefined,
            id: p.id,
            mensaje: htmlToText(p.message),
            adjuntos: p.attachments.length ? p.attachments.map(toFile) : undefined,
            // Lo que el usuario puede hacer con cada publicación, para no intentar lo que Moodle va a rechazar.
            acciones: allowedActions(p.capabilities),
        })),
    };
}

function allowedActions(c: { reply: boolean; edit: boolean; delete: boolean }) {
    const allowed = [c.reply && "responder", c.edit && "editar", c.delete && "borrar"].filter(Boolean);
    return allowed.length ? allowed : undefined;
}

/** Ubica un módulo por su cmid y se queda con la sección que lo contiene. */
export async function findModule(
    session: AulaSession,
    courseId: number,
    cmid: number,
): Promise<{ sectionName: string; module: CourseModule }> {
    const sections: CourseSection[] = await getCourseSections(session, courseId, cmid);
    for (const section of sections) {
        const module = section.modules.find((m) => m.id === cmid);
        if (!module) continue;
        if (!module.uservisible) throw new Error(`No tenés acceso al módulo ${cmid}.`);
        return { sectionName: section.name, module };
    }
    throw new Error(`No existe el módulo ${cmid} en el curso ${courseId}.`);
}

/** `summarized` recorta la descripción: en el mapa del curso alcanza para decidir si entrar. */
function toModule(m: CourseModule, courseId: number, summarized = false) {
    const contents = m.contents ?? [];
    const files = contents.filter((c) => c.type === "file");
    const links = contents.filter((c) => c.type === "url");
    return {
        direccion: moduleAddr(courseId, m.id),
        id: m.id,
        nombre: m.name,
        tipo: m.modname,
        url: m.url,
        descripcion: (summarized ? htmlToSnippet(m.description) : htmlToText(m.description)) || undefined,
        restriccion: htmlToText(m.availabilityinfo) || undefined,
        fechas: m.dates?.length
            ? m.dates.map((d) => ({ etiqueta: d.label, fecha: isoDate(d.timestamp) }))
            : undefined,
        archivos: files.length ? files.map(toFile) : undefined,
        enlaces: links.length ? links.map((l) => l.fileurl) : undefined,
    };
}
