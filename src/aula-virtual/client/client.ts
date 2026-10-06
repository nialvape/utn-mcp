import { callWs } from "./moodle-api.js";
import type { AulaSession } from "./session.js";
import type { Course, CourseSection, ForumDiscussion, ForumPost, SiteInfo } from "./types.js";

export function getSiteInfo(session: AulaSession): Promise<SiteInfo> {
    return callWs<SiteInfo>(session, "core_webservice_get_site_info");
}

export async function getUserCourses(session: AulaSession): Promise<Course[]> {
    const { userid } = await getSiteInfo(session);
    return callWs<Course[]>(session, "core_enrol_get_users_courses", { userid });
}

/**
 * Secciones del curso con sus módulos. Con `cmid` Moodle devuelve igual todas las secciones
 * pero solo popula el módulo pedido, así que no hay que traerse el curso entero para abrir una cosa.
 */
export function getCourseSections(session: AulaSession, courseId: number, cmid?: number): Promise<CourseSection[]> {
    const params: Record<string, string | number> = { courseid: courseId };
    if (cmid !== undefined) {
        params["options[0][name]"] = "cmid";
        params["options[0][value]"] = cmid;
    }
    return callWs<CourseSection[]>(session, "core_course_get_contents", params);
}

// --- Foros ---

/** Cuántas discusiones trae una página del índice de un foro. */
export const POR_PAGINA = 50;

/**
 * Discusiones de un foro, las más recientes primero. Moodle manda el mensaje completo de la
 * primera publicación de cada una; el que lee decide si lo recorta.
 */
export function getForumDiscussions(
    session: AulaSession,
    forumid: number,
    page = 0,
): Promise<{ discussions: ForumDiscussion[] }> {
    return callWs(session, "mod_forum_get_forum_discussions", { forumid, page, perpage: POR_PAGINA });
}

/** Publicaciones de una discusión, incluidas las respuestas. */
export function getDiscussionPosts(session: AulaSession, discussionid: number): Promise<{ posts: ForumPost[] }> {
    return callWs(session, "mod_forum_get_discussion_posts", { discussionid });
}
