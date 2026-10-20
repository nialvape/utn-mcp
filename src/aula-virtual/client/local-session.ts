import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionFile } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import { defaultRegional, findRegional, type Regional } from "./regionals.js";
import type { AulaSession } from "./session.js";
import { fetchToken, LoginRequiredError } from "./sso-login.js";

interface StoredSession {
    token: string | null;
    obtainedAt: string | null;
    /** El id de la que se eligió en `utn-mcp login`; no está en las sesiones de antes de elegirla. */
    regional?: string;
}

/**
 * Sesión del modo local: un solo usuario, guardada en disco.
 * Credenciales en el keychain (o UTN_USER/UTN_PASS); el token y la regional en session.json.
 */
export class LocalSession implements AulaSession {
    private refreshing: Promise<string> | null = null;

    /**
     * La elegida en `utn-mcp login`: la de session.json o, si se borró, la guardada con las credenciales.
     * Sin login (UTN_USER/UTN_PASS) o de antes de elegirla, la de UTN_REGIONAL.
     */
    async getRegional(): Promise<Regional> {
        const regional = (await this.read()).regional ?? (await loadCredentials())?.regional;
        return regional ? findRegional(regional) : defaultRegional();
    }

    async getToken(): Promise<string> {
        return (await this.read()).token ?? this.refreshToken();
    }

    /** Una sola renovación en curso aunque varias tools fallen a la vez. */
    refreshToken(): Promise<string> {
        this.refreshing ??= Promise.all([this.getRegional(), loadCredentials()])
            .then(([regional, creds]) => this.login(regional, creds))
            .finally(() => {
                this.refreshing = null;
            });
        return this.refreshing;
    }

    /** Obtiene un token nuevo y lo guarda. */
    async login(regional: Regional, credentials: Credentials | null): Promise<string> {
        if (!credentials) throw new LoginRequiredError();
        logger.info(`Obteniendo token del aula virtual de ${regional.name}...`);
        const token = await fetchToken(regional, credentials);
        await this.write({ token, obtainedAt: new Date().toISOString(), regional: regional.id });
        return token;
    }

    private async read(): Promise<StoredSession> {
        try {
            return JSON.parse(await readFile(sessionFile(), "utf8")) as StoredSession;
        } catch {
            return { token: null, obtainedAt: null };
        }
    }

    private async write(data: StoredSession): Promise<void> {
        const file = sessionFile();
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
        await chmod(file, 0o600).catch(() => {}); // no-op en Windows
    }
}
