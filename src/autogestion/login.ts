import { ask, askChoice, askHidden } from "../shared/input.js";
import { logger } from "../shared/logger.js";
import { catalogEntryForRegional } from "./client/catalog.js";
import { connectorKit, systemForRegional, UnsupportedRegionalError } from "./client/connector.js";
import { saveAutogestionCredentials } from "./client/credentials.js";
import { installConnector, installedManifest } from "./client/install.js";
import { loadInstalledSystems } from "./client/installed-systems.js";

/**
 * `utn-mcp login autogestion`: instala el conector de la regional si falta o quedó viejo, pide legajo
 * y contraseña, los prueba contra el sistema y recién ahí los guarda en el keychain. La misma regional
 * que se usa para el aula decide qué sistema de autogestión toca.
 */
export async function runAutogestionLogin(regionalId: string): Promise<void> {
    const entry = catalogEntryForRegional(regionalId);
    if (entry && (await installedManifest(entry))?.version !== entry.version) {
        logger.info(`Bajando el conector de ${entry.name}...`);
        await installConnector(entry);
    }
    const system = systemForRegional(regionalId, await loadInstalledSystems());
    if (!system) throw new UnsupportedRegionalError(regionalId);
    if (entry?.regionales[regionalId] === "candidate") {
        logger.info(
            `El conector de ${system.name} todavía no se probó en tu regional: si algo no anda, contalo en ` +
                "https://github.com/nialvape/utn-mcp/issues.",
        );
    }

    const hint = system.usernameHint?.(regionalId);
    const username = (await ask(`Legajo o usuario de ${system.name}${hint ? ` (${hint})` : ""}: `)).trim();
    if (!username) throw new Error("Falta el usuario.");
    const password = await askHidden("Contraseña: ");

    // Se guardan recién después de comprobar que el sistema las aceptó.
    const connector = system.create(regionalId, connectorKit);
    await connector.login({ username, password });

    if (await saveAutogestionCredentials(system.id, { username, password })) {
        logger.info("Credenciales guardadas en el keychain del sistema.");
    } else {
        logger.warn("No hay keychain disponible: definí las variables de entorno del sistema (ver README).");
    }
    logger.info(`Listo: ${system.name} conectado.`);
}

/**
 * Después del login del aula: si la regional tiene un conector en el catálogo, ofrece conectarlo.
 * Un error acá no deshace el login del aula, que ya quedó guardado.
 */
export async function offerAutogestionLogin(regionalId: string): Promise<void> {
    const entry = catalogEntryForRegional(regionalId);
    if (!entry) return;
    const options = ["Sí", "No, después con `utn-mcp login autogestion`"];
    if ((await askChoice(`¿Conectar también ${entry.name} (estado académico, correlativas, finales)?`, options)) !== 0) return;
    try {
        await runAutogestionLogin(regionalId);
    } catch (e) {
        logger.warn(`${(e as Error).message}\nEl aula quedó conectada; ${entry.name} se puede conectar después con \`utn-mcp login autogestion\`.`);
    }
}
