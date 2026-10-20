#!/usr/bin/env node

import "./shared/load-env.js";
import { parseArgs } from "node:util";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LocalSession } from "./aula-virtual/client/local-session.js";
import { defaultRegional } from "./aula-virtual/client/regionals.js";
import { StoredAulaSession } from "./aula-virtual/client/stored-session.js";
import { runLogin } from "./aula-virtual/login.js";
import { startHttpServer, userIdOf } from "./http.js";
import { accessPolicyFromEnv } from "./oauth/access.js";
import { redirectAllowlistFromEnv } from "./oauth/redirects.js";
import { createServer } from "./server.js";
import { logger } from "./shared/logger.js";
import { SqliteStore } from "./shared/store/sqlite-store.js";
import { UploadInbox } from "./shared/uploads.js";

const USAGE = `Uso:
  utn-mcp                 servidor MCP por STDIO (lo lanza el cliente)
  utn-mcp --http [--host H] [--port N]  servidor MCP por HTTP (por defecto 127.0.0.1:3000)
  utn-mcp login           guardar credenciales de la UTN y obtener el primer token
  utn-mcp login --http    lo mismo, para el modo HTTP: guarda la sesión y emite el token del cliente

Si hay un .env en la carpeta actual, se lee al arrancar (ver .env.example).`;

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            http: { type: "boolean", default: false },
            // Por defecto solo desde esta máquina; hosteado, `0.0.0.0` detrás del reverse proxy.
            host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
            port: { type: "string", default: process.env.PORT ?? "3000" },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help) {
        console.error(USAGE);
        return;
    }
    // Una UTN_REGIONAL que no existe corta acá: si no, recién fallaría al primer login o al primer pedido.
    defaultRegional();

    if (positionals[0] === "login") {
        await runLogin(values.http);
        return;
    }

    if (values.http) {
        // Cada request trae el token de un usuario del store y se arma con su sesión. Los archivos
        // llegan por links de subida: el servidor puede no estar en la compu de quien entrega.
        const port = Number(values.port);
        const publicUrl = process.env.UTN_MCP_PUBLIC_URL?.replace(/\/+$/, "") || undefined;
        const baseUrl = publicUrl ?? `http://127.0.0.1:${port}`;
        // La página de `/login` del propio servidor, salvo que el que hostea prefiera mandar a otra.
        const loginUrl = process.env.UTN_MCP_LOGIN_URL || `${baseUrl}/login`;
        const store = await SqliteStore.open();
        const inbox = new UploadInbox(baseUrl);
        const factory = (ctx: { authInfo?: AuthInfo }) => {
            const userId = userIdOf(ctx.authInfo);
            const aula = new StoredAulaSession(store, userId, loginUrl);
            return createServer(aula, { local: false, inbox, owner: String(userId) });
        };
        const options = {
            host: values.host,
            port,
            publicUrl,
            access: accessPolicyFromEnv(),
            redirects: redirectAllowlistFromEnv(),
            adminSecret: process.env.UTN_MCP_ADMIN_SECRET || undefined,
        };
        startHttpServer(factory, options, store, inbox);
    } else {
        // STDIO: un solo usuario, el de la compu, con la misma sesión para todas las conexiones.
        const aula = new LocalSession();
        serveStdio(() => createServer(aula, { local: true }), { onerror: (e) => logger.error(e.message) });
        logger.info("Servidor MCP iniciado en STDIO");
    }
}

main().catch((e) => {
    logger.error((e as Error).message);
    process.exit(1);
});
