import type { SessionStore } from "../../shared/store/session-store.js";
import { getOwnUser } from "./client.js";
import type { Credentials } from "./credentials.js";
import type { AulaSession } from "./session.js";
import { fetchToken } from "./sso-login.js";
import { AULA_PLATFORM, type StoredAulaData } from "./stored-session.js";

export interface LinkedAccount {
    userId: number;
    username: string;
    email: string | null;
}

/**
 * Entra al aula con usuario y contraseña, crea el usuario del store si no existe y le guarda la
 * sesión (el token). La contraseña se usa solo acá: no se guarda en ningún lado.
 * Lo usan `utn-mcp login --http` y el login por OAuth de la versión hosteada.
 */
export async function linkAulaAccount(store: SessionStore, credentials: Credentials): Promise<LinkedAccount> {
    const token = await fetchToken(credentials);

    // El token recién emitido: si falla, no hay con qué renovarlo.
    const fresh: AulaSession = {
        getToken: async () => token,
        refreshToken: async () => {
            throw new Error("El aula rechazó el token recién emitido.");
        },
    };
    const own = await getOwnUser(fresh);
    // El de Moodle, en minúscula, igual que en `users`: es con lo que se compara al renovar.
    const username = own.username.toLowerCase();

    const userId = await store.findOrCreateUser(username, own.email ?? undefined);
    const data: StoredAulaData = { username, token };
    await store.saveSession(userId, AULA_PLATFORM, JSON.stringify(data));
    return { userId, username, email: own.email };
}
