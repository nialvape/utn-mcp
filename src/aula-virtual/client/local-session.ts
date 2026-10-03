import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import { sessionFile } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import type { AulaSession } from "./session.js";
import { fetchToken } from "./sso-login.js";

interface StoredSession {
    token: string | null;
    obtainedAt: string | null;
    cookies: SerializedCookieJar | null;
}

/**
 * Sesión del modo local: un solo usuario, guardada en disco.
 * Credenciales en el keychain (o UTN_USER/UTN_PASS); token y cookies del SSO en session.json.
 */
export class LocalSession implements AulaSession {
    private refreshing: Promise<string> | null = null;

    async getToken(): Promise<string> {
        return (await this.read()).token ?? this.refreshToken();
    }

    /** Una sola renovación en curso aunque varias tools fallen a la vez. */
    refreshToken(): Promise<string> {
        this.refreshing ??= loadCredentials()
            .then((creds) => this.login(creds))
            .finally(() => {
                this.refreshing = null;
            });
        return this.refreshing;
    }

    /** Obtiene un token nuevo y lo guarda junto con las cookies del SSO. */
    async login(credentials: Credentials | null): Promise<string> {
        logger.info("Obteniendo token del aula virtual...");
        const stored = await this.read();
        const jar = stored.cookies ? await CookieJar.deserialize(stored.cookies) : new CookieJar();

        const token = await fetchToken(jar, credentials);
        await this.write({ token, obtainedAt: new Date().toISOString(), cookies: await jar.serialize() });
        return token;
    }

    private async read(): Promise<StoredSession> {
        try {
            return JSON.parse(await readFile(sessionFile(), "utf8")) as StoredSession;
        } catch {
            return { token: null, obtainedAt: null, cookies: null };
        }
    }

    private async write(data: StoredSession): Promise<void> {
        const file = sessionFile();
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
        await chmod(file, 0o600).catch(() => {}); // no-op en Windows
    }
}
