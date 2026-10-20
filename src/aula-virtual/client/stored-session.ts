import type { SessionStore } from "../../shared/store/session-store.js";
import { loadCredentials } from "./credentials.js";
import { defaultRegional, findRegional, type Regional } from "./regionals.js";
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
 * Sesión del modo HTTP: la de un usuario del store, en el aula de su regional. Renueva el token con la
 * contraseña del keychain cuando es de este mismo usuario: eso pasa solo en local, porque el servidor
 * hosteado no guarda contraseñas. Si no, el usuario vuelve a iniciar sesión.
 */
export class StoredAulaSession implements AulaSession {
    private refreshing: Promise<string> | null = null;
    private regional: Promise<Regional> | null = null;

    /** `loginUrl` es la página donde el usuario vuelve a iniciar sesión, si el servidor tiene una. */
    constructor(
        private readonly store: SessionStore,
        private readonly userId: number,
        private readonly loginUrl?: string,
    ) {}

    /** La del usuario en el store; no cambia mientras dura la sesión, así que se lee una sola vez. */
    getRegional(): Promise<Regional> {
        this.regional ??= this.store.findUser(this.userId).then((user) => {
            if (!user) throw this.loginRequired("No hay usuario para esta sesión.");
            return findRegional(user.regional);
        });
        return this.regional;
    }

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
        const [stored, regional] = await Promise.all([this.read(), this.getRegional()]);
        // Las del keychain (o UTN_USER/UTN_PASS) son de una sola persona: con otro usuario (o el mismo
        // nombre en otra regional) entraríamos al aula de ella y guardaríamos su token en la sesión de este.
        const credentials = await loadCredentials();
        const sameUser =
            credentials?.username.trim().toLowerCase() === stored.username &&
            (credentials.regional ?? defaultRegional().id) === regional.id;
        if (!credentials || !sameUser) throw this.loginRequired("La sesión del aula venció.");

        const token = await fetchToken(regional, credentials);
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
