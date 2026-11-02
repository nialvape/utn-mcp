import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../../shared/logger.js";
import { CATALOG, type CatalogEntry } from "./catalog.js";
import type { AutogestionSystem } from "./connector.js";
import { connectorDir, installedManifest } from "./install.js";

/**
 * Los conectores disponibles: los del catálogo que `utn-mcp login` instaló en la carpeta de datos y,
 * a mano, los paquetes que nombre `UTN_MCP_CONNECTORS`, resueltos desde la carpeta en la que arranca
 * el proceso. Esa variable es para probar un conector propio: cargarlo ejecuta su código.
 */
export async function loadInstalledSystems(): Promise<AutogestionSystem[]> {
    const systems: AutogestionSystem[] = [];
    for (const entry of CATALOG) {
        const system = await loadFromCatalog(entry);
        if (system) systems.push(system);
    }

    const manual = process.env.UTN_MCP_CONNECTORS?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
    const require = createRequire(join(process.cwd(), "package.json"));
    for (const name of new Set(manual)) {
        const system = validSystem(await import(pathToFileURL(require.resolve(name)).href), name);
        if (systems.some((existing) => existing.id === system.id || existing.regionales.some((id) => system.regionales.includes(id)))) {
            throw new Error(`El conector ${name} repite un sistema o una regional que ya cubre otro conector.`);
        }
        systems.push(system);
    }
    return systems;
}

/** El conector del catálogo si está instalado y es la versión que espera este core; si no, null. */
async function loadFromCatalog(entry: CatalogEntry): Promise<AutogestionSystem | null> {
    const manifest = await installedManifest(entry);
    if (!manifest) return null;
    if (manifest.version !== entry.version) {
        logger.warn(
            `El conector de ${entry.name} instalado es la versión ${manifest.version} y esta versión de utn-mcp usa la ` +
                `${entry.version}: corré \`utn-mcp login autogestion\` para actualizarlo.`,
        );
        return null;
    }
    const system = validSystem(await import(pathToFileURL(join(connectorDir(entry), manifest.main ?? "index.js")).href), entry.package);
    if (system.id !== entry.id) throw new Error(`El paquete ${entry.package} no es el conector ${entry.id}.`);
    return system;
}

function validSystem(module: unknown, source: string): AutogestionSystem {
    const system = (module as { default?: AutogestionSystem }).default;
    const nonEmpty = (value: unknown) => typeof value === "string" && value.trim() !== "";
    if (
        !system ||
        !nonEmpty(system.id) ||
        !nonEmpty(system.name) ||
        !Array.isArray(system.regionales) ||
        system.regionales.length === 0 ||
        !system.regionales.every(nonEmpty) ||
        typeof system.create !== "function"
    ) {
        throw new Error(`El paquete ${source} no exporta un conector de autogestión válido.`);
    }
    return system;
}
