#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({
    name: "UTN-MCP",
    version: "0.0.1"
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Servidor MCP Iniciado en STDIO!")
}

main().catch((e) => {
    console.error("Error al iniciar el servidor MCP:", e);
    process.exit(1);
})