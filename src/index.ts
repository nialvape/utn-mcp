#!/usr/bin/env node

import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LocalSession } from "./aula-virtual/client/local-session.js";
import { runLogin } from "./aula-virtual/login.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";
import { logger } from "./shared/logger.js";

const USAGE = `Uso:
  utn-mcp                 servidor MCP por STDIO (lo lanza el cliente)
  utn-mcp --http [--port N]  servidor MCP por HTTP en 127.0.0.1 (por defecto 3000)
  utn-mcp login           guardar credenciales de la UTN y obtener el primer token`;

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            http: { type: "boolean", default: false },
            port: { type: "string", default: process.env.PORT ?? "3000" },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help) {
        console.error(USAGE);
        return;
    }
    if (positionals[0] === "login") {
        await runLogin();
        return;
    }

    // Modo local: un solo usuario, la misma sesión para todas las conexiones.
    const aula = new LocalSession();
    const factory = () => createServer(aula);

    if (values.http) {
        startHttpServer(factory, Number(values.port));
    } else {
        serveStdio(factory, { onerror: (e) => logger.error(e.message) });
        logger.info("Servidor MCP iniciado en STDIO");
    }
}

main().catch((e) => {
    logger.error((e as Error).message);
    process.exit(1);
});
