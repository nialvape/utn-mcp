/**
 * Direcciones de navegación del aula: un path que el modelo recibe en una respuesta
 * y devuelve tal cual para entrar ahí. No hay estado en el servidor; la dirección
 * dice todo lo necesario, y el padre se deduce del texto (eso es el "volver").
 */
export type Address =
    | { nivel: "raiz" }
    | { nivel: "curso"; courseId: number }
    | { nivel: "modulo"; courseId: number; cmid: number }
    | { nivel: "discusion"; courseId: number; cmid: number; discussionId: number };

export const RAIZ = "/";
export const cursoAddr = (courseId: number) => `/curso/${courseId}`;
export const moduloAddr = (courseId: number, cmid: number) => `/curso/${courseId}/mod/${cmid}`;
export const discusionAddr = (courseId: number, cmid: number, discussionId: number) =>
    `/curso/${courseId}/mod/${cmid}/disc/${discussionId}`;

const FORMATOS = [
    "/",
    "/curso/{courseId}",
    "/curso/{courseId}/mod/{cmid}",
    "/curso/{courseId}/mod/{cmid}/disc/{discussionId}",
].join(", ");

const PATRON = /^\/curso\/(\d+)(?:\/mod\/(\d+)(?:\/disc\/(\d+))?)?$/;

export function parseAddress(raw: string): Address {
    const path = raw.trim().replace(/\/+$/, "") || "/";
    if (path === "/") return { nivel: "raiz" };

    const m = PATRON.exec(path);
    if (!m) throw new Error(`Dirección inválida: "${raw}". Formatos válidos: ${FORMATOS}`);

    const [, curso, cmid, disc] = m;
    const courseId = Number(curso);
    if (!cmid) return { nivel: "curso", courseId };
    if (!disc) return { nivel: "modulo", courseId, cmid: Number(cmid) };
    return { nivel: "discusion", courseId, cmid: Number(cmid), discussionId: Number(disc) };
}

/** La dirección de un nivel más arriba, o null si ya estamos en la raíz. */
export function padre(address: Address): string | null {
    switch (address.nivel) {
        case "raiz":
            return null;
        case "curso":
            return RAIZ;
        case "modulo":
            return cursoAddr(address.courseId);
        case "discusion":
            return moduloAddr(address.courseId, address.cmid);
    }
}
