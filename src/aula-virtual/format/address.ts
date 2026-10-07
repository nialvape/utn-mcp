/**
 * Direcciones de navegación del aula: un path que el modelo recibe en una respuesta
 * y devuelve tal cual para entrar ahí. No hay estado en el servidor; la dirección
 * dice todo lo necesario, y el padre se deduce del texto (eso es el "volver").
 */
export type Address =
    | { level: "root" }
    | { level: "course"; courseId: number }
    | { level: "module"; courseId: number; cmid: number }
    | { level: "discussion"; courseId: number; cmid: number; discussionId: number };

export const ROOT = "/";
export const courseAddr = (courseId: number) => `/curso/${courseId}`;
export const moduleAddr = (courseId: number, cmid: number) => `/curso/${courseId}/mod/${cmid}`;
export const discussionAddr = (courseId: number, cmid: number, discussionId: number) =>
    `/curso/${courseId}/mod/${cmid}/disc/${discussionId}`;

const FORMATS = [
    "/",
    "/curso/{courseId}",
    "/curso/{courseId}/mod/{cmid}",
    "/curso/{courseId}/mod/{cmid}/disc/{discussionId}",
].join(", ");

const PATTERN = /^\/curso\/(\d+)(?:\/mod\/(\d+)(?:\/disc\/(\d+))?)?$/;

export function parseAddress(raw: string): Address {
    const path = raw.trim().replace(/\/+$/, "") || "/";
    if (path === "/") return { level: "root" };

    const m = PATTERN.exec(path);
    if (!m) throw new Error(`Dirección inválida: "${raw}". Formatos válidos: ${FORMATS}`);

    const [, course, cmid, disc] = m;
    const courseId = Number(course);
    if (!cmid) return { level: "course", courseId };
    if (!disc) return { level: "module", courseId, cmid: Number(cmid) };
    return { level: "discussion", courseId, cmid: Number(cmid), discussionId: Number(disc) };
}

/** La dirección en texto, tal como la ve el modelo. */
export function formatAddress(address: Address): string {
    switch (address.level) {
        case "root":
            return ROOT;
        case "course":
            return courseAddr(address.courseId);
        case "module":
            return moduleAddr(address.courseId, address.cmid);
        case "discussion":
            return discussionAddr(address.courseId, address.cmid, address.discussionId);
    }
}

/** La dirección de un nivel más arriba, o null si ya estamos en la raíz. */
export function parentOf(address: Address): string | null {
    switch (address.level) {
        case "root":
            return null;
        case "course":
            return ROOT;
        case "module":
            return courseAddr(address.courseId);
        case "discussion":
            return moduleAddr(address.courseId, address.cmid);
    }
}
