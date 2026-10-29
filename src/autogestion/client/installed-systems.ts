import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AutogestionSystem } from "./connector.js";

const require = createRequire(`${process.cwd()}/package.json`);

export async function loadInstalledSystems(): Promise<AutogestionSystem[]> {
    const packages = process.env.UTN_MCP_CONNECTORS?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
    const systems: AutogestionSystem[] = [];
    for (const name of new Set(packages)) {
        const module: unknown = await import(pathToFileURL(require.resolve(name)).href);
        const system = (module as { default?: AutogestionSystem }).default;
        if (!system || typeof system.id !== "string" || !system.id.trim() || typeof system.name !== "string" || !system.name.trim() || !Array.isArray(system.regionales) ||
            system.regionales.length === 0 || system.regionales.some((id) => typeof id !== "string" || !id.trim()) ||
            !["verified", "unverified"].includes(system.support) ||
            typeof system.create !== "function") {
            throw new Error(`El paquete ${name} no exporta un conector de autogestión válido.`);
        }
        if (systems.some((existing) => existing.id === system.id ||
            existing.regionales.some((id) => system.regionales.includes(id)))) {
            throw new Error(`El conector ${name} repite un sistema o una regional ya configurada.`);
        }
        systems.push(system);
    }
    return systems;
}
