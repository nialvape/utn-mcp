import { McpServer } from "@modelcontextprotocol/server";
import type { AulaSession } from "./aula-virtual/client/session.js";
import { registerAulaVirtualTools } from "./aula-virtual/tools.js";

/** Un servidor MCP para un usuario. Las entradas STDIO y HTTP lo crean por conexión o por request. */
export function createServer(aula: AulaSession): McpServer {
    const server = new McpServer({
        name: "UTN-MCP",
        version: "0.2.0",
    });

    registerAulaVirtualTools(server, aula);

    return server;
}
