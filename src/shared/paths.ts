import { homedir } from "node:os";
import { join } from "node:path";

/** Carpeta de configuración: UTN_MCP_HOME, %APPDATA% en Windows, o XDG/~/.config en Linux y macOS. */
export function configDir(): string {
    if (process.env.UTN_MCP_HOME) return process.env.UTN_MCP_HOME;
    if (process.platform === "win32") {
        return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "utn-mcp");
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "utn-mcp");
}

/** Token de Moodle + cookies del SSO del modo local. */
export const sessionFile = () => join(configDir(), "session.json");
