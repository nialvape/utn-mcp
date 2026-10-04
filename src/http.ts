import express, { type RequestHandler } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { logger } from "./shared/logger.js";

type Guard = (req: IncomingMessage, res: ServerResponse) => boolean;
const asMiddleware = (guard: Guard): RequestHandler => (req, res, next) => {
    if (guard(req, res)) next();
};

export function startHttpServer(factory: McpServerFactory, port: number) {
    const handler = createMcpHandler(factory, { onerror: (e) => logger.error(e.message) });

    const app = express();
    app.use(asMiddleware(localhostHostValidation()));
    app.use(asMiddleware(localhostOriginValidation()));
    // Sin express.json(): el handler lee el body por su cuenta.
    app.all("/mcp", toNodeHandler(handler));

    app.listen(port, "127.0.0.1", () => {
        logger.info(`Servidor MCP escuchando en http://127.0.0.1:${port}/mcp`);
    });
}
