import type { SessionStore } from "../../shared/store/session-store.js";
import { loadCredentials } from "./credentials.js";
import type { AulaSession } from "./session.js";
import { fetchToken, LoginRequiredError } from "./sso-login.js";

/** Con qué nombre guarda el aula su sesión en el store. */
export const AULA_PLATFORM = "aula";

/** Lo que el aula guarda en el store para un usuario. */
export interface StoredAulaData {
    username: string;
    token: string;
}

/**
 * Sesión del modo HTTP: la de un usuario del store. Renueva el token con la contraseña del keychain
 * cuando es de este mismo usuario: eso pasa solo en local, porque el servidor hosteado no guarda
 * contraseñas. Si no, el usuario vuelve a iniciar sesión.
 */
export class StoredAulaSession implements AulaSession {
    private refreshing: Promise<string> | null = null;

    /** `loginUrl` es la página donde el usuario vuelve a iniciar sesión, si el servidor tiene una. */
    constructor(
        private readonly store: SessionStore,
        private readonly userId: number,
        private readonly loginUrl?: string,
    ) {}

    async getToken(): Promise<string> {
        return (await this.read()).token;
    }

    refreshToken(): Promise<string> {
        this.refreshing ??= this.renew().finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    private async renew(): Promise<string> {
        const stored = await this.read();
        // Las del keychain (o UTN_USER/UTN_PASS) son de una sola persona: con otro usuario
        // entraríamos al aula de ella y guardaríamos su token en la sesión de este.
        const credentials = await loadCredentials();
        if (credentials?.username.trim().toLowerCase() !== stored.username) {
            throw this.loginRequired("La sesión del aula venció.");
        }

        const token = await fetchToken(credentials);
        // Sin `...stored`: las sesiones guardadas antes traen cookies, que ya no se usan.
        const data: StoredAulaData = { username: stored.username, token };
        await this.store.saveSession(this.userId, AULA_PLATFORM, JSON.stringify(data));
        return token;
    }

    private async read(): Promise<StoredAulaData> {
        const raw = await this.store.loadSession(this.userId, AULA_PLATFORM);
        if (!raw) throw this.loginRequired("No hay sesión del aula para este usuario.");
        return JSON.parse(raw) as StoredAulaData;
    }

    /** Hosteado, el usuario vuelve a entrar por la página del servidor; sin ella, por el CLI. */
    private loginRequired(reason: string): LoginRequiredError {
        const next = this.loginUrl
            ? `Pedile al usuario que vuelva a iniciar sesión en ${this.loginUrl} y después reintentá.`
            : "Volvé a iniciar sesión con `utn-mcp login --http` en la máquina del servidor.";
        return new LoginRequiredError(`${reason} ${next}`);
    }
}
