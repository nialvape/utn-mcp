// servidor MCP STDIO based
export const logger = {
    info: (...args: unknown[]) => console.error("[utn-mcp]", ...args),
    warn: (...args: unknown[]) => console.error("[utn-mcp] WARN", ...args),
    error: (...args: unknown[]) => console.error("[utn-mcp] ERROR", ...args),
};
