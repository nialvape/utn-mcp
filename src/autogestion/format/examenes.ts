import { HttpError } from "../../shared/http.js";
import type { AutogestionSession } from "../client/session.js";
import type { ExamenMateria } from "../client/types.js";

export async function getExamenes(session: AutogestionSession): Promise<ExamenMateria[]> {
    const connector = await session.getConnector();
    if (!connector.examenes) {
        throw new HttpError(
            "El sistema de autogestión de tu regional todavía no tiene conector para el historial de exámenes.",
        );
    }
    return connector.examenes();
}
