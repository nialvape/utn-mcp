import { McpServer } from "@modelcontextprotocol/server";
import type { AulaSession } from "./aula-virtual/client/session.js";
import { registerAulaVirtualTools } from "./aula-virtual/tools.js";
import { systemForRegional } from "./autogestion/client/connector.js";
import type { AutogestionAccess } from "./autogestion/client/session.js";
import { registerAutogestionTools } from "./autogestion/tools.js";
import { logger } from "./shared/logger.js";
import type { FileSource } from "./shared/uploads.js";

/**
 * Un servidor MCP para un usuario. Las entradas STDIO y HTTP lo crean por conexión o por request.
 * `files`: de dónde salen los archivos que el usuario sube a una plataforma.
 * `autogestion`: los conectores cargados y la sesión del usuario; sus tools aparecen solo si uno cubre su regional.
 * Es async porque resuelve la regional del usuario antes de registrar la autogestión.
 */
export async function createServer(aula: AulaSession, files: FileSource, autogestion?: AutogestionAccess): Promise<McpServer> {
    const server = new McpServer({
        name: "UTN-MCP",
        version: "0.9.4",
    });

    registerAulaVirtualTools(server, aula, files);
    if (autogestion?.systems.length) {
        // Un conector roto no puede dejar sin aula virtual: si falla, seguimos sin las tools de autogestión.
        try {
            const regional = await aula.getRegional();
            const system = systemForRegional(regional.id, autogestion.systems);
            if (system) registerAutogestionTools(server, autogestion.sessionFor(system, regional.id), files);
        } catch (e) {
            logger.warn((e as Error).message);
        }
    }

    return server;
}
