import { htmlToText } from "../../shared/html.js";
import {
    getAssignments,
    getChoiceOptions,
    getChoicegroupOptions,
    getChoices,
    getSubmissionStatus,
} from "../client/client.js";
import type { AulaSession } from "../client/session.js";
import type { AssignPlugin, ChoiceOption, CourseModule, MoodleFile } from "../client/types.js";
import { isoDate, toFile } from "./fields.js";

const SUBMISSION_STATUS_LABELS: Record<string, string> = {
    new: "sin entregar",
    draft: "borrador",
    submitted: "enviada",
    reopened: "reabierta",
};

/** La entrega del usuario (o la de su grupo): qué acepta la tarea, qué subió y la devolución si la hay. */
export async function viewSubmission(session: AulaSession, courseId: number, module: CourseModule) {
    const [assignments, status] = await Promise.all([
        getAssignments(session, courseId),
        getSubmissionStatus(session, module.instance),
    ]);
    const assignment = assignments.find((a) => a.cmid === module.id);
    const attempt = status.lastattempt;
    // En las entregas grupales la individual queda vacía; la que cuenta es la del grupo.
    const submission = attempt?.teamsubmission ?? attempt?.submission;
    const config = (plugin: string, name: string) =>
        assignment?.configs.find((c) => c.subtype === "assignsubmission" && c.plugin === plugin && c.name === name)
            ?.value;

    const accepts = [];
    if (config("file", "enabled") === "1") {
        accepts.push({
            tipo: "archivos",
            maximo: Number(config("file", "maxfilesubmissions")) || undefined,
            tamanioMaximo: Number(config("file", "maxsubmissionsizebytes")) || undefined,
            extensiones: config("file", "filetypeslist") || undefined,
        });
    }
    if (config("onlinetext", "enabled") === "1") {
        accepts.push({ tipo: "texto en línea", limitePalabras: Number(config("onlinetext", "wordlimit")) || undefined });
    }

    const feedback = status.feedback;
    return {
        estado: submission ? (SUBMISSION_STATUS_LABELS[submission.status] ?? submission.status) : "sin entregar",
        grupal: assignment?.teamsubmission === 1 || undefined,
        // Moodle crea la entrega vacía al abrir la tarea: su fecha no dice nada hasta que hay algo subido.
        modificada: (submission?.status !== "new" && isoDate(submission?.timemodified)) || undefined,
        abre: isoDate(assignment?.allowsubmissionsfromdate) || undefined,
        vence: isoDate(assignment?.duedate) || undefined,
        prorroga: isoDate(attempt?.extensionduedate) || undefined,
        cierreDefinitivo: isoDate(assignment?.cutoffdate) || undefined,
        acepta: accepts.length ? accepts : undefined,
        // Con borradores, lo subido no cuenta hasta confirmar el envío.
        requiereConfirmarEnvio: assignment?.submissiondrafts === 1 || undefined,
        requiereDeclaracion: assignment?.requiresubmissionstatement === 1 || undefined,
        puedeEditar: attempt?.canedit ?? false,
        puedeEnviar: attempt?.cansubmit || undefined,
        bloqueada: attempt?.locked || undefined,
        ...pluginContent(submission?.plugins),
        devolucion: feedback
            ? {
                  calificacion: feedback.gradefordisplay || undefined,
                  fecha: isoDate(feedback.gradeddate),
                  ...pluginContent(feedback.plugins),
              }
            : undefined,
    };
}

/** Los archivos y textos de una entrega o devolución, sin los plugins vacíos. */
function pluginContent(plugins: AssignPlugin[] = []) {
    const files: MoodleFile[] = plugins.flatMap((p) => p.fileareas?.flatMap((a) => a.files ?? []) ?? []);
    const texts = plugins
        .flatMap((p) => p.editorfields ?? [])
        .map((e) => htmlToText(e.text))
        .filter(Boolean);
    return {
        archivos: files.length ? files.map(toFile) : undefined,
        texto: texts.length ? texts.join("\n\n") : undefined,
    };
}

export async function viewChoice(session: AulaSession, courseId: number, module: CourseModule) {
    const [choices, options] = await Promise.all([
        getChoices(session, courseId),
        getChoiceOptions(session, module.instance),
    ]);
    const choice = choices.find((c) => c.coursemodule === module.id);
    return {
        multiple: choice?.allowmultiple || undefined,
        puedeCambiar: choice?.allowupdate,
        abre: isoDate(choice?.timeopen) || undefined,
        cierra: isoDate(choice?.timeclose) || undefined,
        opciones: options.map(toOption),
    };
}

/** El plugin no expone si deja cambiar o elegir varios grupos: eso lo dice la descripción o el error al elegir. */
export async function viewChoicegroup(session: AulaSession, module: CourseModule) {
    const options = await getChoicegroupOptions(session, module.instance);
    return { opciones: options.map(toOption) };
}

export function toOption(o: ChoiceOption) {
    return {
        id: o.id,
        texto: o.text ?? o.name,
        elegida: o.checked || undefined,
        deshabilitada: o.disabled || undefined,
        cupo: o.maxanswers || undefined,
        anotados: o.countanswers,
    };
}
