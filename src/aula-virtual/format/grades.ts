import { htmlToText } from "../../shared/html.js";
import { getCourseGradeItems } from "../client/client.js";
import type { AulaSession } from "../client/session.js";
import { courseAddr, moduleAddr, parseAddress } from "./address.js";

/** Sin nota, Moodle formatea "-": eso no le dice nada al modelo. */
const NO_GRADE = "-";

/** Moodle deja `itemname` vacío en los totales; sin esto, el modelo no sabe de qué es la nota. */
const UNNAMED_ITEMS: Record<string, string> = { course: "Total del curso", category: "Total de categoría" };

/**
 * Las calificaciones del usuario en un curso, con las que el docente carga a mano. Las de un módulo
 * traen su `direccion` para abrirlo; las categorías y el total del curso vienen marcados en `tipo`.
 */
export async function viewGrades(session: AulaSession, rawAddress: string) {
    const address = parseAddress(rawAddress);
    if (address.level !== "course") {
        throw new Error(`Pasá la dirección de un curso, como "/curso/691"; "${rawAddress}" no lo es.`);
    }
    const items = await getCourseGradeItems(session, address.courseId);
    return {
        direccion: courseAddr(address.courseId),
        calificaciones: items.map((i) => ({
            nombre: i.itemname || UNNAMED_ITEMS[i.itemtype],
            tipo: i.itemmodule ?? i.itemtype,
            direccion: i.cmid ? moduleAddr(address.courseId, i.cmid) : undefined,
            calificacion: i.gradeformatted && i.gradeformatted !== NO_GRADE ? i.gradeformatted : undefined,
            maximo: i.grademax,
            porcentaje:
                i.percentageformatted && i.percentageformatted !== NO_GRADE ? i.percentageformatted : undefined,
            oculta: i.gradeishidden || undefined,
            devolucion: htmlToText(i.feedback) || undefined,
        })),
    };
}
