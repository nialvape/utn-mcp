import { htmlToText } from "../../shared/html.js";
import { callWs } from "./moodle-api.js";
import type { AulaSession } from "./session.js";
import type { Course, CourseModule, CourseSection, SiteInfo } from "../types.js";

const isoDate = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

export function getSiteInfo(session: AulaSession): Promise<SiteInfo> {
    return callWs<SiteInfo>(session, "core_webservice_get_site_info");
}

export async function listCourses(session: AulaSession) {
    const { userid } = await getSiteInfo(session);
    const courses = await callWs<Course[]>(session, "core_enrol_get_users_courses", { userid });
    return courses.map((c) => ({
        id: c.id,
        nombre: c.fullname,
        nombreCorto: c.shortname,
        visible: c.visible === 1,
        progreso: c.progress ?? null,
        ultimoAcceso: isoDate(c.lastaccess),
    }));
}

/** Secciones de un curso con sus actividades y archivos. Omite lo que el usuario no puede ver. */
export async function getCourseContents(session: AulaSession, courseid: number) {
    const sections = await callWs<CourseSection[]>(session, "core_course_get_contents", { courseid });
    return sections
        .filter((s) => s.uservisible !== false)
        .map((s) => ({
            id: s.id,
            numero: s.section,
            nombre: s.name,
            resumen: htmlToText(s.summary) || undefined,
            actividades: s.modules.filter((m) => m.uservisible).map(toActivity),
        }))
        .filter((s) => s.resumen || s.actividades.length > 0);
}

function toActivity(m: CourseModule) {
    const contents = m.contents ?? [];
    const files = contents.filter((c) => c.type === "file");
    const links = contents.filter((c) => c.type === "url");
    return {
        id: m.id,
        nombre: m.name,
        tipo: m.modname,
        url: m.url,
        descripcion: htmlToText(m.description) || undefined,
        restriccion: htmlToText(m.availabilityinfo) || undefined,
        fechas: m.dates?.length
            ? m.dates.map((d) => ({ etiqueta: d.label, fecha: isoDate(d.timestamp) }))
            : undefined,
        archivos: files.length
            ? files.map((f) => ({
                  nombre: f.filename,
                  ruta: f.filepath,
                  tamanio: f.filesize,
                  mimetype: f.mimetype,
                  modificado: isoDate(f.timemodified),
                  url: f.fileurl,
              }))
            : undefined,
        enlaces: links.length ? links.map((l) => l.fileurl) : undefined,
    };
}
