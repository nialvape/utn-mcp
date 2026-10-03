import { logger } from "../../shared/logger.js";

export interface Credentials {
    username: string;
    password: string;
}

const SERVICE = "utn-mcp";
const ACCOUNT = "aula-virtual";

// Import dinámico: si el binario nativo o el Secret Service (Linux) no están, seguimos con env vars.
async function entry() {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, ACCOUNT);
}

/** Primero UTN_USER/UTN_PASS; si no están, el keychain del sistema. */
export async function loadCredentials(): Promise<Credentials | null> {
    const { UTN_USER, UTN_PASS } = process.env;
    if (UTN_USER && UTN_PASS) return { username: UTN_USER, password: UTN_PASS };

    try {
        const raw = (await entry()).getPassword();
        return raw ? (JSON.parse(raw) as Credentials) : null;
    } catch (e) {
        logger.warn("Keychain no disponible:", (e as Error).message);
        return null;
    }
}

/** Guarda en el keychain. Devuelve false si no hay keychain (ej. Linux sin Secret Service). */
export async function saveCredentials(creds: Credentials): Promise<boolean> {
    try {
        (await entry()).setPassword(JSON.stringify(creds));
        return true;
    } catch (e) {
        logger.warn("No se pudo guardar en el keychain:", (e as Error).message);
        return false;
    }
}
