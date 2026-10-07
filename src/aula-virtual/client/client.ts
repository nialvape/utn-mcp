import { callWs, MoodleError } from "./moodle-api.js";
import type { AulaSession } from "./session.js";
import type {
    Assignment,
    AssignSubmissionStatus,
    Choice,
    ChoiceOption,
    Course,
    CourseSection,
    ForumDiscussion,
    ForumPost,
    SiteInfo,
} from "./types.js";

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
export const PAGE_SIZE = 50;

/**
 * Discusiones de un foro, las más recientes primero. Moodle manda el mensaje completo de la
 * primera publicación de cada una; el que lee decide si lo recorta.
 */
export function getForumDiscussions(
    session: AulaSession,
    forumid: number,
    page = 0,
): Promise<{ discussions: ForumDiscussion[] }> {
    return callWs(session, "mod_forum_get_forum_discussions", { forumid, page, perpage: PAGE_SIZE });
}

/** Publicaciones de una discusión, incluidas las respuestas. */
export function getDiscussionPosts(session: AulaSession, discussionid: number): Promise<{ posts: ForumPost[] }> {
    return callWs(session, "mod_forum_get_discussion_posts", { discussionid });
}

/** Si el usuario puede abrir un hilo en el foro, con el grupo que le toque. */
export async function canAddDiscussion(session: AulaSession, forumid: number): Promise<boolean> {
    const { status } = await callWs<{ status: boolean }>(session, "mod_forum_can_add_discussion", { forumid });
    return status;
}

/** Abre un hilo. Moodle elige solo el grupo del usuario si el foro es por grupos. */
export async function addDiscussion(
    session: AulaSession,
    forumid: number,
    subject: string,
    message: string,
): Promise<number> {
    const { discussionid } = await callWs<{ discussionid: number }>(session, "mod_forum_add_discussion", {
        forumid,
        subject,
        message,
    });
    return discussionid;
}

/** Responde a una publicación, que puede ser la primera de la discusión. */
export async function addDiscussionPost(
    session: AulaSession,
    postid: number,
    subject: string,
    message: string,
): Promise<number> {
    const { postid: newPostId } = await callWs<{ postid: number }>(session, "mod_forum_add_discussion_post", {
        postid,
        subject,
        message,
    });
    return newPostId;
}

/** Edita una publicación propia; con asunto vacío Moodle deja el que tenía. */
export async function updateDiscussionPost(
    session: AulaSession,
    postid: number,
    subject: string,
    message: string,
): Promise<void> {
    await callWs(session, "mod_forum_update_discussion_post", { postid, subject, message });
}

/** Borra una publicación; si es la primera, se va la discusión entera. */
export async function deletePost(session: AulaSession, postid: number): Promise<void> {
    await callWs(session, "mod_forum_delete_post", { postid });
}

// --- Tareas ---

/** Las tareas de un curso con su configuración: fechas y qué tipos de entrega aceptan. */
export async function getAssignments(session: AulaSession, courseId: number): Promise<Assignment[]> {
    const { courses } = await callWs<{ courses: { assignments: Assignment[] }[] }>(
        session,
        "mod_assign_get_assignments",
        { "courseids[0]": courseId },
    );
    return courses[0]?.assignments ?? [];
}

/** Estado de la entrega del usuario y, si ya la corrigieron, la devolución. */
export function getSubmissionStatus(session: AulaSession, assignid: number): Promise<AssignSubmissionStatus> {
    return callWs(session, "mod_assign_get_submission_status", { assignid });
}

// --- Elecciones (choice) y selección de grupos (choicegroup) ---

export async function getChoices(session: AulaSession, courseId: number): Promise<Choice[]> {
    const { choices } = await callWs<{ choices: Choice[] }>(session, "mod_choice_get_choices_by_courses", {
        "courseids[0]": courseId,
    });
    return choices;
}

export async function getChoiceOptions(session: AulaSession, choiceid: number): Promise<ChoiceOption[]> {
    const { options } = await callWs<{ options: ChoiceOption[] }>(session, "mod_choice_get_choice_options", {
        choiceid,
    });
    return options;
}

export async function submitChoiceResponse(session: AulaSession, choiceid: number, optionIds: number[]): Promise<void> {
    const params: Record<string, number> = { choiceid };
    optionIds.forEach((id, i) => (params[`responses[${i}]`] = id));
    await callWs(session, "mod_choice_submit_choice_response", params);
}

export async function deleteChoiceResponses(session: AulaSession, choiceid: number): Promise<void> {
    await callWs(session, "mod_choice_delete_choice_responses", { choiceid });
}

export async function getChoicegroupOptions(session: AulaSession, choicegroupid: number): Promise<ChoiceOption[]> {
    const { userid } = await getSiteInfo(session);
    const { options } = await callWs<{ options: ChoiceOption[] }>(session, "mod_choicegroup_get_choicegroup_options", {
        choicegroupid,
        userid,
    });
    return options;
}

/**
 * El plugin lee `responses` si la actividad deja un solo grupo y `choicegroup_<id>: "true"` si deja
 * varios, y la configuración no se puede consultar: mandamos las dos formas y él usa la que le sirve.
 * Con varios grupos, los que no vienen marcados se quitan.
 */
export async function submitChoicegroupResponse(
    session: AulaSession,
    choicegroupid: number,
    optionIds: number[],
): Promise<void> {
    const data = [
        { name: "responses", value: String(optionIds[0]) },
        ...optionIds.map((id) => ({ name: `choicegroup_${id}`, value: "true" })),
    ];
    const params: Record<string, string | number> = { choicegroupid };
    data.forEach((d, i) => {
        params[`data[${i}][name]`] = d.name;
        params[`data[${i}][value]`] = d.value;
    });
    await callWs(session, "mod_choicegroup_submit_choicegroup_response", params);
}

export async function deleteChoicegroupResponses(session: AulaSession, choicegroupid: number): Promise<void> {
    await callWs(session, "mod_choicegroup_delete_choicegroup_responses", { choicegroupid });
}

// --- Mensajes ---

/** Nombre de otro usuario, visto desde el usuario logueado, o null si no existe. */
export async function getMemberName(session: AulaSession, userId: number): Promise<string | null> {
    const { userid } = await getSiteInfo(session);
    let members: { id: number; fullname: string; isdeleted: boolean }[];
    try {
        members = await callWs(session, "core_message_get_member_info", {
            referenceuserid: userid,
            "userids[0]": userId,
        });
    } catch (e) {
        // Con un id que no existe, Moodle 5.1 no devuelve vacío: revienta con un error de PHP.
        if (e instanceof MoodleError) return null;
        throw e;
    }
    const m = members.find((x) => x.id === userId && !x.isdeleted);
    return m?.fullname ?? null;
}

/** Manda un mensaje privado. Moodle no tira excepción si falla: devuelve `msgid: -1` y el motivo. */
export async function sendInstantMessage(session: AulaSession, touserid: number, html: string): Promise<number> {
    const [res] = await callWs<{ msgid: number; errormessage?: string }[]>(
        session,
        "core_message_send_instant_messages",
        { "messages[0][touserid]": touserid, "messages[0][text]": html, "messages[0][textformat]": 1 },
    );
    if (!res || res.msgid === -1) throw new MoodleError(res?.errormessage || "Moodle no aceptó el mensaje.");
    return res.msgid;
}

// --- Calendario ---

/** Crea un evento personal: solo lo ve el usuario. */
export async function createUserEvent(
    session: AulaSession,
    event: { name: string; description: string; timestart: number; timeduration: number },
): Promise<number> {
    const { events } = await callWs<{ events: { id: number }[]; warnings: { message: string }[] }>(
        session,
        "core_calendar_create_calendar_events",
        {
            "events[0][name]": event.name,
            "events[0][description]": event.description,
            "events[0][format]": 1,
            "events[0][eventtype]": "user",
            "events[0][timestart]": event.timestart,
            "events[0][timeduration]": event.timeduration,
        },
    );
    if (!events[0]) throw new MoodleError("Moodle no creó el evento.");
    return events[0].id;
}
