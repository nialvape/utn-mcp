import { textToHtml } from "../../shared/html.js";
import {
    addDiscussion,
    addDiscussionPost,
    createUserEvent,
    deleteChoiceResponses,
    deleteChoicegroupResponses,
    deletePost,
    getChoiceOptions,
    getChoicegroupOptions,
    getDiscussionPosts,
    getMemberName,
    sendInstantMessage,
    submitChoiceResponse,
    submitChoicegroupResponse,
    updateDiscussionPost,
} from "../client/client.js";
import { AULA_BASE_URL } from "../client/constants.js";
import type { AulaSession } from "../client/session.js";
import type { ChoiceOption, ForumPost } from "../client/types.js";
import { toOption } from "./activities.js";
import { discussionAddr, formatAddress, parseAddress } from "./address.js";
import { isoDate } from "./fields.js";
import { findModule } from "./navigate.js";

// --- Foros ---

/**
 * Con la dirección de un foro abre un hilo; con la de una discusión responde. Así el modelo no elige
 * entre dos operaciones: la dirección que ya tiene dice cuál es.
 */
export async function postToForum(
    session: AulaSession,
    rawAddress: string,
    message: string,
    subject?: string,
    replyTo?: number,
) {
    const address = parseAddress(rawAddress);

    if (address.level === "module") {
        const { module } = await findModule(session, address.courseId, address.cmid);
        if (module.modname !== "forum") {
            throw new Error(`"${rawAddress}" no es un foro, es un módulo de tipo ${module.modname}.`);
        }
        if (!subject?.trim()) throw new Error("Para abrir un hilo hace falta un `asunto`.");
        const discussionId = await addDiscussion(session, module.instance, subject.trim(), textToHtml(message));
        return { publicado: "hilo nuevo", direccion: discussionAddr(address.courseId, address.cmid, discussionId) };
    }

    if (address.level === "discussion") {
        const { posts } = await getDiscussionPosts(session, address.discussionId);
        const parent = replyTo
            ? findPost(posts, replyTo, rawAddress)
            : posts.find((p) => p.parentid === null && !p.isdeleted);
        if (!parent) throw new Error(`La discusión ${rawAddress} no tiene publicaciones a las que responder.`);
        if (!parent.capabilities.reply) {
            throw new Error("No podés responder en esta discusión: está cerrada o el foro no deja responder.");
        }
        const postId = await addDiscussionPost(
            session,
            parent.id,
            subject?.trim() || parent.replysubject,
            textToHtml(message),
        );
        return { publicado: "respuesta", direccion: formatAddress(address), id: postId, respuestaA: parent.id };
    }

    throw new Error(
        `Para publicar hace falta la dirección de un foro (/curso/{id}/mod/{cmid}) o de una discusión ` +
            `(/curso/{id}/mod/{cmid}/disc/{id}); "${rawAddress}" no es ninguna de las dos.`,
    );
}

export async function editForumPost(
    session: AulaSession,
    rawAddress: string,
    postId: number,
    message: string,
    subject?: string,
) {
    const { address, post } = await findPostAt(session, rawAddress, postId);
    if (!post.capabilities.edit) {
        throw new Error("No podés editar esta publicación: no es tuya o ya pasó el tiempo para editarla.");
    }
    // Asunto vacío: Moodle deja el que tenía.
    await updateDiscussionPost(session, postId, subject?.trim() ?? "", textToHtml(message));
    return { editado: true, direccion: formatAddress(address), id: postId };
}

export async function deleteForumPost(session: AulaSession, rawAddress: string, postId: number) {
    const { address, post } = await findPostAt(session, rawAddress, postId);
    if (!post.capabilities.delete) {
        throw new Error("No podés borrar esta publicación: no es tuya, tiene respuestas o ya pasó el tiempo.");
    }
    await deletePost(session, postId);
    const isFirst = post.parentid === null;
    return {
        borrado: true,
        id: postId,
        // Borrar la primera publicación se lleva la discusión entera.
        discusionBorrada: isFirst || undefined,
        direccion: isFirst ? undefined : formatAddress(address),
    };
}

async function findPostAt(session: AulaSession, rawAddress: string, postId: number) {
    const address = parseAddress(rawAddress);
    if (address.level !== "discussion") {
        throw new Error(`Hace falta la dirección de la discusión donde está la publicación; "${rawAddress}" no lo es.`);
    }
    const { posts } = await getDiscussionPosts(session, address.discussionId);
    return { address, post: findPost(posts, postId, rawAddress) };
}

function findPost(posts: ForumPost[], postId: number, rawAddress: string): ForumPost {
    const post = posts.find((p) => p.id === postId && !p.isdeleted);
    if (!post) {
        throw new Error(
            `La publicación ${postId} no está en ${rawAddress}. Los ids salen de abrir la discusión con aula_open.`,
        );
    }
    return post;
}

// --- Elecciones y selección de grupos ---

/** Deja elegidas exactamente `optionIds`; vacío borra la respuesta. Devuelve cómo quedó. */
export async function answerChoice(session: AulaSession, rawAddress: string, optionIds: number[]) {
    const address = parseAddress(rawAddress);
    if (address.level !== "module") throw new Error(`"${rawAddress}" no es la dirección de un módulo.`);
    const { module } = await findModule(session, address.courseId, address.cmid);

    const api = CHOICE_APIS[module.modname];
    if (!api) {
        throw new Error(
            `"${rawAddress}" es un módulo de tipo ${module.modname}; solo se puede elegir en choice y choicegroup.`,
        );
    }

    const current = await api.options(session, module.instance);
    for (const id of optionIds) {
        const option = current.find((o) => o.id === id);
        if (!option) {
            throw new Error(`No existe la opción ${id}. Las válidas son: ${current.map((o) => o.id).join(", ")}.`);
        }
        if (option.disabled && !option.checked) {
            throw new Error(`La opción ${id} (${option.text ?? option.name}) está completa o deshabilitada.`);
        }
    }

    if (optionIds.length) await api.submit(session, module.instance, optionIds);
    else await api.clear(session, module.instance);

    const after = await api.options(session, module.instance);
    const chosen = after.filter((o) => o.checked).map((o) => o.id);
    const matches = chosen.length === optionIds.length && optionIds.every((id) => chosen.includes(id));
    return {
        elegidas: chosen,
        // Pasa cuando la actividad deja una sola opción y se pidieron varias.
        aviso: matches ? undefined : "Moodle no dejó exactamente las opciones pedidas; `elegidas` es lo que quedó.",
        opciones: after.map(toOption),
    };
}

interface ChoiceApi {
    options(session: AulaSession, instance: number): Promise<ChoiceOption[]>;
    submit(session: AulaSession, instance: number, optionIds: number[]): Promise<void>;
    clear(session: AulaSession, instance: number): Promise<void>;
}

const CHOICE_APIS: Record<string, ChoiceApi> = {
    choice: { options: getChoiceOptions, submit: submitChoiceResponse, clear: deleteChoiceResponses },
    choicegroup: {
        options: getChoicegroupOptions,
        submit: submitChoicegroupResponse,
        clear: deleteChoicegroupResponses,
    },
};

// --- Mensajes ---

export async function sendMessage(session: AulaSession, userId: number, message: string) {
    // Se busca antes el nombre: un id equivocado le mandaría el mensaje a otra persona sin que nadie lo note.
    const name = await getMemberName(session, userId);
    if (!name) {
        throw new Error(`No existe el usuario ${userId}. El id sale del \`autorId\` de un foro abierto con aula_open.`);
    }
    await sendInstantMessage(session, userId, textToHtml(message));
    return { enviado: true, para: name };
}

// --- Calendario ---

/** Exige la zona horaria: el servidor hosteado no está en la hora de Argentina y adivinarla corre el evento. */
const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

export async function addCalendarEvent(
    session: AulaSession,
    event: { name: string; start: string; durationMinutes?: number; description?: string },
) {
    const start = new Date(event.start);
    if (!HAS_TIMEZONE.test(event.start.trim()) || Number.isNaN(start.getTime())) {
        throw new Error(
            `Fecha inválida: "${event.start}". Usá ISO 8601 con zona horaria, por ejemplo "2026-10-14T18:00:00-03:00".`,
        );
    }
    const timestart = Math.floor(start.getTime() / 1000);
    const timeduration = Math.round((event.durationMinutes ?? 0) * 60);
    const name = event.name.trim();
    const id = await createUserEvent(session, {
        name,
        description: event.description ? textToHtml(event.description) : "",
        timestart,
        timeduration,
    });
    return {
        creado: true,
        id,
        nombre: name,
        inicio: isoDate(timestart),
        fin: timeduration ? isoDate(timestart + timeduration) : undefined,
        // Para que el usuario lo vea en el calendario del aula.
        url: `${AULA_BASE_URL}/calendar/view.php?view=day&time=${timestart}`,
    };
}
