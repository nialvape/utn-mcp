import { postForm } from "../../shared/http.js";
import { AULA_BASE_URL } from "./constants.js";
import type { AulaSession } from "./session.js";

const WS_URL = `${AULA_BASE_URL}/webservice/rest/server.php`;
const TOKEN_ERRORS = new Set(["invalidtoken", "expiredtoken"]);

export class MoodleError extends Error {
    constructor(message: string, readonly errorcode?: string) {
        super(message);
        this.name = "MoodleError";
    }
}

interface MoodleException {
    exception: string;
    errorcode?: string;
    message?: string;
}

const isException = (data: unknown): data is MoodleException =>
    typeof data === "object" && data !== null && "exception" in data;

/** Llama a una función del web service de Moodle; renueva el token una vez si venció. */
export async function callWs<T>(
    session: AulaSession,
    wsfunction: string,
    params: Record<string, string | number> = {},
): Promise<T> {
    let token = await session.getToken();

    for (let attempt = 0; ; attempt++) {
        const data = await postForm<T | MoodleException>(WS_URL, {
            ...params,
            wstoken: token,
            wsfunction,
            moodlewsrestformat: "json",
        });
        if (!isException(data)) return data;

        if (attempt === 0 && data.errorcode && TOKEN_ERRORS.has(data.errorcode)) {
            token = await session.refreshToken();
            continue;
        }
        throw new MoodleError(data.message ?? data.exception, data.errorcode);
    }
}
