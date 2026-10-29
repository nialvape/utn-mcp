import { McpServer } from "@modelcontextprotocol/server";
import type { AulaSession } from "./aula-virtual/client/session.js";
import { registerAulaVirtualTools } from "./aula-virtual/tools.js";
import { loadInstalledSystems } from "./autogestion/client/installed-systems.js";
import { LocalAutogestionSession } from "./autogestion/client/local-session.js";
import { systemForRegional } from "./autogestion/client/connector.js";
import { registerAutogestionTools } from "./autogestion/tools.js";
import { logger } from "./shared/logger.js";
import type { FileSource } from "./shared/uploads.js";

/**
 * Un servidor MCP para un usuario. Las entradas STDIO y HTTP lo crean por conexión o por request.
 * `files`: de dónde salen los archivos que el usuario sube a una plataforma.
 * Es async porque, en local, resuelve la regional y los conectores instalados antes de registrar la autogestión.
 */
export async function createServer(aula: AulaSession, files: FileSource): Promise<McpServer> {
    const server = new McpServer({
        name: "UTN-MCP",
        version: "0.9.0",
    });

    registerAulaVirtualTools(server, aula, files);
    if (files.local) {
        // Un conector roto no puede dejar sin aula virtual: si falla, seguimos sin las tools de autogestión.
        try {
            const regional = await aula.getRegional();
            const systems = await loadInstalledSystems();
            const system = systemForRegional(regional.id, systems);
            if (system) registerAutogestionTools(server, new LocalAutogestionSession(system));
        } catch (e) {
            logger.warn((e as Error).message);
        }
    }

    return server;
}
