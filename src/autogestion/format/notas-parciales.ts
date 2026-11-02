import { HttpError } from "../../shared/http.js";
import type { AutogestionSession } from "../client/session.js";
import type { NotasParcialesMateria } from "../client/types.js";

export async function getCursandoAhora(session: AutogestionSession): Promise<NotasParcialesMateria[]> {
    const connector = await session.getConnector();
    if (!connector.notasParciales) {
        throw new HttpError(
            "El sistema de autogestión de tu regional todavía no tiene conector para la cursada actual.",
        );
    }
    return (await connector.notasParciales()).filter((m) => m.cursando);
}
