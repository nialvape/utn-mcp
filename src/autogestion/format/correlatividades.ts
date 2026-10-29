import type { AutogestionSession } from "../client/session.js";
import type { Correlatividades } from "../client/types.js";

/** Correlatividades de cursar y, si el conector la publica, de rendir. */
export async function getCorrelatividades(session: AutogestionSession): Promise<Correlatividades> {
    return (await session.getConnector()).correlatividades();
}
