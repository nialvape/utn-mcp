import type { AutogestionSession } from "../client/session.js";
import type { EstadoMateria } from "../client/types.js";

/** Estado académico del alumno en su autogestión, delegado al conector de su regional. */
export async function getEstadoAcademico(session: AutogestionSession): Promise<EstadoMateria[]> {
    return (await session.getConnector()).estadoAcademico();
}
