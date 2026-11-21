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

/** Token de Moodle del modo local. */
export const sessionFile = () => join(configDir(), "session.json");

/** Mapeo materia → repo de GitHub para publicar TPs (aula_tp_to_github), editable a mano. */
export const tpReposFile = () => join(configDir(), "tp-repos.json");

/** Base de usuarios, tokens y sesiones del modo HTTP: UTN_MCP_DB o un SQLite en la carpeta de configuración. */
export const storeFile = () => process.env.UTN_MCP_DB ?? join(configDir(), "utn-mcp.db");

/** Clave con la que se cifran las sesiones en la base, si no viene en UTN_MCP_KEY. */
export const storeKeyFile = () => join(configDir(), "store.key");

/** Dónde quedan los archivos que arma el servidor (packs de estudio): UTN_MCP_EXPORTS o exports/ en la configuración. */
export function exportsDir(): string {
    return process.env.UTN_MCP_EXPORTS ?? join(configDir(), "exports");
}
