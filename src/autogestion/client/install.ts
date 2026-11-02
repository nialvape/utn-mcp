import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { HttpError } from "../../shared/http.js";
import { logger } from "../../shared/logger.js";
import { configDir } from "../../shared/paths.js";
import { CATALOG, type CatalogEntry } from "./catalog.js";

/** Donde quedan los conectores instalados, uno por carpeta con el nombre de su paquete. */
export const connectorsDir = () => join(configDir(), "connectors");

export const connectorDir = (entry: CatalogEntry) => join(connectorsDir(), entry.package);

/** El package.json del conector instalado, o null si no está. */
export async function installedManifest(entry: CatalogEntry): Promise<{ version?: string; main?: string } | null> {
    try {
        return JSON.parse(await readFile(join(connectorDir(entry), "package.json"), "utf8"));
    } catch {
        return null;
    }
}

/**
 * Para el modo HTTP, que atiende usuarios de cualquier regional: instala los conectores del catálogo que
 * falten o hayan quedado viejos. Uno que no se puede bajar no frena el servidor: queda sin esas tools.
 */
export async function installCatalog(): Promise<void> {
    for (const entry of CATALOG) {
        if ((await installedManifest(entry))?.version === entry.version) continue;
        try {
            await installConnector(entry);
            logger.info(`Conector de ${entry.name} ${entry.version} instalado.`);
        } catch (e) {
            logger.warn(`No se pudo instalar el conector de ${entry.name}: ${(e as Error).message}`);
        }
    }
}

/** Bloques del formato tar: encabezado y datos van de a 512 bytes. */
const TAR_BLOCK = 512;

/**
 * Baja el `.tgz` del catálogo, comprueba su hash y lo extrae en su carpeta. Sin `npm install`: los
 * conectores no tienen dependencias, así que alcanza con desempaquetarlos, y no hace falta npm en la máquina.
 */
export async function installConnector(entry: CatalogEntry): Promise<void> {
    let res: Response;
    try {
        res = await fetch(entry.tarball, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
        throw new HttpError(`No se pudo bajar el conector de ${entry.name}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new HttpError(`HTTP ${res.status} al bajar el conector de ${entry.name} (${entry.tarball}).`, res.status);
    const tgz = Buffer.from(await res.arrayBuffer());

    const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
    if (integrity !== entry.integrity) {
        throw new Error(`El conector de ${entry.name} que se bajó no es el que espera esta versión de utn-mcp: no se instala.`);
    }

    const target = connectorDir(entry);
    const staging = `${target}.tmp-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await extractPackage(tgz, staging);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
}

/** Extrae los archivos de `package/` de un tarball de `npm pack`; cualquier ruta que salga de ahí se rechaza. */
async function extractPackage(tgz: Buffer, dest: string): Promise<void> {
    const tar = gunzipSync(tgz);
    const text = (start: number, length: number) =>
        tar.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    for (let offset = 0; offset + TAR_BLOCK <= tar.length; ) {
        if (tar.subarray(offset, offset + TAR_BLOCK).every((b) => b === 0)) break;
        const name = text(offset, 100);
        const prefix = text(offset + 345, 155);
        const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
        // "0" o NUL es un archivo común; los demás (carpetas, encabezados pax) no traen nada que escribir.
        const type = String.fromCharCode(tar[offset + 156]);
        const path = prefix ? `${prefix}/${name}` : name;
        const data = offset + TAR_BLOCK;
        if (type === "0" || type === "\0") {
            const relative = path.replace(/^package\//, "");
            if (!path.startsWith("package/") || isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
                throw new Error(`El conector trae una ruta inválida (${path}): no se instala.`);
            }
            const file = join(dest, relative);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, tar.subarray(data, data + size));
        }
        offset = data + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    }
}
