import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergePdfs } from "../../shared/documents/merge.js";
import { exportsDir } from "../../shared/paths.js";
import { withRetry } from "../../shared/retry.js";
import { getCourseFiles, getUserCourses, type CourseFileEntry } from "../client/client.js";
import type { AulaSession } from "../client/session.js";
import { parseAddress } from "./address.js";
import { downloadUrl, MAX_BYTES } from "./files.js";
import { fetchFile } from "../client/moodle-api.js";

/**
 * Topes de tamaño por pack: pdf-lib junta todo el resultado en memoria, así que sin tope total un
 * curso enorme podría colgar la compu donde corre el servidor. Lo que queda afuera por un tope se
 * lista en `omitidos` con el motivo, para pedir el resto en otro pack.
 * Una variable de entorno con basura NO puede desactivar el tope: si no es un número válido,
 * vuelve al default.
 */
const capFromEnv = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw ?? fallback);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_PACK_FILES = capFromEnv(process.env.UTN_MCP_PACK_MAX_FILES, 150);
const MAX_PACK_BYTES = capFromEnv(process.env.UTN_MCP_PACK_MAX_MB, 300) * 1024 * 1024;
/** Máximo del PDF final: se estima con los tamaños de entrada para cortar antes de bajar todo. */
const MAX_FINAL_MB = capFromEnv(process.env.UTN_MCP_PACK_MAX_FINAL_MB, 30);
const MAX_FINAL_BYTES = MAX_FINAL_MB * 1024 * 1024;

const isPdf = (e: CourseFileEntry) =>
    e.file.mimetype === "application/pdf" || e.file.filename.toLowerCase().endsWith(".pdf");

/** Los caracteres que no sirven para un nombre de archivo se cambian por "-". */
const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");

/**
 * Escribe el pack sin pisar packs anteriores: nombre con fecha-hora y, si ya existe (dos packs
 * en el mismo segundo), un sufijo -2, -3... La escritura es atómica por nombre (bandera "wx").
 */
export async function writePackFile(dir: string, courseName: string, bytes: Uint8Array): Promise<string> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const base = join(dir, `${safeFileName(courseName)}-apuntes-${stamp}`);
    for (let n = 1; n <= 100; n++) {
        const candidate = n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`;
        try {
            await writeFile(candidate, bytes, { flag: "wx" });
            return candidate;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
    }
    throw new Error(`No se pudo guardar el pack: ya existen 100 archivos para "${base}".`);
}

/**
 * Baja PDF de un curso y los une en un solo archivo con índice, guardado en exportsDir().
 * Con `archivos` une solo las URL pedidas (tal como las devuelve aula_open, validadas con
 * `downloadUrl` como en aula_read_file); sin `archivos`, todos los PDF del curso. El pack sigue
 * el orden del aula, no el de la lista, para que el índice acompañe las unidades. Los duplicados
 * exactos se descartan al armar, porque ahí se bajan igual. Todo lo omitido queda listado en
 * `omitidos` con el motivo; en el atajo sin `archivos`, los archivos que no son PDF solo se
 * cuentan en `archivosNoPdf` en vez de listarse uno por uno.
 */
export async function buildStudyPack(session: AulaSession, rawAddress: string, archivos?: string[]) {
    const address = parseAddress(rawAddress);
    if (address.level !== "course") {
        throw new Error(
            `Para armar el pack pasá la dirección de un curso entero ("/curso/{courseId}", de aula_list_courses), no "${rawAddress}".`,
        );
    }

    const { baseUrl } = await session.getRegional();
    const course = (await getUserCourses(session)).find((c) => c.id === address.courseId);
    const entries = await getCourseFiles(session, address.courseId);

    let selected: ReadonlyArray<CourseFileEntry>;
    const omitted: { nombre: string; seccion: string; motivo: string }[] = [];
    if (archivos) {
        // Cada URL pedida se valida igual que en aula_read_file: solo archivos del aula del usuario.
        const requested = new Set(archivos.map((u) => downloadUrl(baseUrl, u).href));
        const byUrl = new Map(entries.map((e) => [downloadUrl(baseUrl, e.file.fileurl).href, e]));
        const unknown = [...requested].filter((u) => !byUrl.has(u));
        if (unknown.length) {
            throw new Error(
                `Estas URL no son de archivos del curso (salen de aula_open sobre "${rawAddress}"):\n` +
                    unknown.map((u) => `- ${u}`).join("\n"),
            );
        }
        // El orden lo manda el aula, no la lista: el índice sigue las unidades.
        selected = entries.filter((e) => requested.has(downloadUrl(baseUrl, e.file.fileurl).href));
        for (const e of selected.filter((x) => !isPdf(x))) {
            omitted.push({ nombre: e.file.filename, seccion: e.section, motivo: "no es un PDF" });
        }
    } else {
        selected = entries;
    }

    const pdfs = selected.filter(isPdf);
    const archivosNoPdf = archivos ? 0 : selected.length - pdfs.length;
    if (!pdfs.length) {
        throw new Error(
            archivos
                ? "Ninguna de las URL pedidas es un PDF: la tool une únicamente PDF."
                : "El curso no tiene ningún PDF en sus secciones visibles.",
        );
    }

    const capMotivo = `se alcanzó el tope del pack (${MAX_PACK_FILES} archivos / ${MAX_PACK_BYTES / 1024 / 1024} MB)`;
    const inputs: { title: string; bytes: Uint8Array }[] = [];
    const kept: CourseFileEntry[] = [];
    const seen = new Map<string, string>(); // hash -> nombre del primero con ese contenido
    let totalBytes = 0;
    let finalLleno = false;
    for (const entry of pdfs) {
        const name = entry.file.filename;
        if (finalLleno) {
            omitted.push({
                nombre: name,
                seccion: entry.section,
                motivo: `el PDF final llegó al tope de ${MAX_FINAL_MB} MB (estimado con los tamaños de entrada)`,
            });
            continue;
        }
        if (inputs.length >= MAX_PACK_FILES || totalBytes + (entry.file.filesize ?? 0) > MAX_PACK_BYTES) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: capMotivo });
            continue;
        }
        let bytes: Uint8Array;
        try {
            bytes = (
                await withRetry(() => fetchFile(session, downloadUrl(baseUrl, entry.file.fileurl), MAX_BYTES), {
                    operation: "aula studyPack",
                })
            ).bytes;
        } catch (e) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: (e as Error).message });
            continue;
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        const original = seen.get(hash);
        if (original) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: `es idéntico a "${original}"` });
            continue;
        }
        // El tamaño real se conoce recién ahora (Moodle a veces no lo anuncia): tope post-descarga.
        if (totalBytes + bytes.length > MAX_PACK_BYTES) {
            omitted.push({ nombre: name, seccion: entry.section, motivo: capMotivo });
            continue;
        }
        // Corte temprano del tope del PDF final, estimado con los tamaños de entrada: lo que ya
        // no puede entrar no se baja de más ni tira abajo el pack entero al final.
        if (totalBytes + bytes.length > MAX_FINAL_BYTES) {
            finalLleno = true;
            omitted.push({
                nombre: name,
                seccion: entry.section,
                motivo: `el PDF final llegó al tope de ${MAX_FINAL_MB} MB (estimado con los tamaños de entrada)`,
            });
            continue;
        }
        seen.set(hash, name);
        inputs.push({ title: name, bytes });
        kept.push(entry);
        totalBytes += bytes.length;
    }

    // En el índice va el módulo, que se lee mejor que el archivo; si el módulo aporta más de un
    // archivo, también el archivo, para que las entradas no queden repetidas.
    const perModule = new Map<string, number>();
    const moduleKey = (e: CourseFileEntry) => `${e.section}\n${e.module}`;
    for (const e of kept) perModule.set(moduleKey(e), (perModule.get(moduleKey(e)) ?? 0) + 1);
    kept.forEach((e, i) => {
        inputs[i].title = perModule.get(moduleKey(e))! > 1 ? `${e.module}: ${e.file.filename}` : e.module;
    });

    const courseName = course?.shortname ?? `curso-${address.courseId}`;
    const dir = exportsDir();

    // La estimación puede quedar corta (el índice y los enlaces agregan páginas): si el unido
    // supera el tope igual, salen los últimos materiales hasta que entre, en vez de tirar todo
    // el trabajo de descarga.
    let pack = await mergePdfs(inputs, `Apuntes de ${course?.fullname ?? courseName}`);
    while (pack.bytes.length > MAX_FINAL_BYTES && inputs.length > 1) {
        inputs.pop();
        const entry = kept.pop()!;
        omitted.push({
            nombre: entry.file.filename,
            seccion: entry.section,
            motivo: `el PDF final superó el tope de ${MAX_FINAL_MB} MB al unir`,
        });
        pack = await mergePdfs(inputs, `Apuntes de ${course?.fullname ?? courseName}`);
    }
    if (pack.bytes.length > MAX_FINAL_BYTES) {
        const mb = Math.round((pack.bytes.length / 1024 / 1024) * 10) / 10;
        throw new Error(
            `El PDF final pesa ${mb} MB, más del máximo (${MAX_FINAL_MB} MB): no se guardó. ` +
                "Pedí el pack con `archivos`, eligiendo solo los PDF que necesitás.",
        );
    }
    for (const s of pack.skipped) {
        omitted.push({ nombre: kept[s.index].file.filename, seccion: kept[s.index].section, motivo: s.reason });
    }

    await mkdir(dir, { recursive: true });
    const path = await writePackFile(dir, courseName, pack.bytes);

    return {
        archivo: path,
        curso: course?.fullname ?? courseName,
        paginas: pack.pages,
        materiales: pack.merged.map((m) => ({
            nombre: kept[m.index].file.filename,
            seccion: kept[m.index].section,
            modulo: kept[m.index].module,
            paginas: m.pages,
            empiezaEn: m.startPage,
        })),
        omitidos: omitted.length ? omitted : undefined,
        archivosNoPdf: archivosNoPdf || undefined,
    };
}
