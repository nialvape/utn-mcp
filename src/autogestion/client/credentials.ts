import { logger } from "../../shared/logger.js";
import type { AutogestionCredentials } from "./connector.js";

const SERVICE = "utn-mcp";
/** Una entrada por sistema: la credencial es por sistema, no por regional. */
const account = (systemId: string) => `autogestion-${systemId}`;

// Import dinámico: si el binario nativo o el Secret Service (Linux) no están, seguimos con env vars.
async function entry(systemId: string) {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, account(systemId));
}

function envNames(systemId: string): [string, string] {
    const prefix = systemId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return [`${prefix}_USER`, `${prefix}_PASS`];
}

/** Primero <SISTEMA>_USER/<SISTEMA>_PASS (ej. SYSACAD_ASP_USER); si no están, el keychain. */
export async function loadAutogestionCredentials(systemId: string): Promise<AutogestionCredentials | null> {
    const [userEnv, passEnv] = envNames(systemId);
    const username = process.env[userEnv];
    const password = process.env[passEnv];
    if (username && password) return { username, password };

    try {
        const raw = (await entry(systemId)).getPassword();
        return raw ? (JSON.parse(raw) as AutogestionCredentials) : null;
    } catch (e) {
        logger.warn("Keychain no disponible:", (e as Error).message);
        return null;
    }
}

/** Guarda en el keychain. Devuelve false si no hay keychain (ej. Linux sin Secret Service). */
export async function saveAutogestionCredentials(
    systemId: string,
    creds: AutogestionCredentials,
): Promise<boolean> {
    try {
        (await entry(systemId)).setPassword(JSON.stringify(creds));
        return true;
    } catch (e) {
        logger.warn("No se pudo guardar en el keychain:", (e as Error).message);
        return false;
    }
}
