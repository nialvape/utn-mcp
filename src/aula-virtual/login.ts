import { ask, askHidden } from "../shared/input.js";
import { logger } from "../shared/logger.js";
import { saveCredentials } from "./client/credentials.js";
import { LocalSession } from "./client/local-session.js";

/**
 * `utn-mcp login`: pide usuario y contraseña una vez, los guarda en el keychain
 * y obtiene el primer token. Después el servidor renueva solo.
 */
export async function runLogin(): Promise<void> {
    const username = await ask("Usuario institucional de la UTN: ");
    if (!username) throw new Error("Falta el usuario.");
    const password = await askHidden("Contraseña: ");
    const credentials = { username, password };

    await new LocalSession().login(credentials);

    // Se guardan recién después de comprobar que el SSO las aceptó.
    if (await saveCredentials(credentials)) {
        logger.info("Credenciales guardadas en el keychain del sistema.");
    } else {
        logger.warn("No hay keychain disponible: para renovar sin intervención definí UTN_USER y UTN_PASS.");
    }
    logger.info("Listo: ya podés usar el servidor MCP.");
}
