import { loadInstalledSystems } from "./client/installed-systems.js";
import { ask, askHidden } from "../shared/input.js";
import { logger } from "../shared/logger.js";
import { systemForRegional, UnsupportedRegionalError } from "./client/connector.js";
import { saveAutogestionCredentials } from "./client/credentials.js";

/**
 * `utn-mcp login autogestion`: pide legajo/usuario y contraseña del sistema de autogestión de la
 * regional del usuario, los prueba contra el sistema y recién ahí los guarda en el keychain.
 * La misma regional que se usa para el aula decide qué sistema de autogestión toca.
 */
export async function runAutogestionLogin(regionalId: string): Promise<void> {
    const system = systemForRegional(regionalId, await loadInstalledSystems());
    if (!system) throw new UnsupportedRegionalError(regionalId);

    const username = (await ask("Legajo o usuario de la autogestión: ")).trim();
    if (!username) throw new Error("Falta el usuario.");
    const password = await askHidden("Contraseña: ");

    // Se guardan recién después de comprobar que el sistema las aceptó.
    const connector = system.create();
    await connector.login({ username, password });

    if (await saveAutogestionCredentials(system.id, { username, password })) {
        logger.info("Credenciales guardadas en el keychain del sistema.");
    } else {
        logger.warn("No hay keychain disponible: definí las variables de entorno del sistema (ver README).");
    }
    logger.info(`Listo: autogestión ${system.name} conectada.`);
}
