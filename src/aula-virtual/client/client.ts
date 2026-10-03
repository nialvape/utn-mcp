import { callWs } from "./moodle-api.js";
import type { AulaSession } from "./session.js";
import type { Course, SiteInfo } from "../types.js";

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
        ultimoAcceso: c.lastaccess ? new Date(c.lastaccess * 1000).toISOString() : null,
    }));
}
