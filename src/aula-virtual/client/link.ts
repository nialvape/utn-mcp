import type { SessionStore } from "../../shared/store/session-store.js";
import { getOwnUser, getUserCourses } from "./client.js";
import type { Credentials } from "./credentials.js";
import type { Regional } from "./regionals.js";
import type { AulaSession } from "./session.js";
import { fetchToken, type SecondFactor } from "./sso-login.js";
import { AULA_PLATFORM, type StoredAulaData } from "./stored-session.js";

export interface LinkedAccount {
    userId: number;
    regional: Regional;
    username: string;
    fullname: string;
    email: string | null;
    /** Este login fue el primero en verificar la regional en este servidor. */
    firstVerifier: boolean;
}

/**
 * Entra al aula de la regional con usuario y contraseña, crea el usuario del store si no existe y le
 * guarda la sesión (el token). La contraseña se usa solo acá: no se guarda en ningún lado.
 * Lo usan `utn-mcp login --http`, el login por OAuth de la versión hosteada y `/admin/verificar`.
 * `regional` tiene que venir con su soporte en este servidor (`availableRegionals` con las verificadas).
 * `secondFactor` contesta el MFA de Microsoft si la cuenta lo pide.
 */
export async function linkAulaAccount(
    store: SessionStore,
    regional: Regional,
    credentials: Credentials,
    secondFactor?: SecondFactor,
): Promise<LinkedAccount> {
    const token = await fetchToken(regional, credentials, secondFactor);

    // El token recién emitido: si falla, no hay con qué renovarlo.
    const fresh: AulaSession = {
        getRegional: async () => regional,
        getToken: async () => token,
        refreshToken: async () => {
            throw new Error("El aula rechazó el token recién emitido.");
        },
    };
    const own = await getOwnUser(fresh);
    // La primera vez que alguien entra a una regional sin verificar se prueban también los cursos: si
    // anda, queda verificada para todos los de este servidor.
    let firstVerifier = false;
    if (regional.support === "candidate") {
        await getUserCourses(fresh);
        firstVerifier = await store.markRegionalVerified(regional.id);
    }
    // El de Moodle, en minúscula, igual que en `users`: es con lo que se compara al renovar.
    const username = own.username.toLowerCase();

    const userId = await store.findOrCreateUser(regional.id, username, own.email ?? undefined);
    const data: StoredAulaData = { username, token };
    await store.saveSession(userId, AULA_PLATFORM, JSON.stringify(data));
    return { userId, regional, username, fullname: own.fullname, email: own.email, firstVerifier };
}
