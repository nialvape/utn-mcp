import { createHash } from "node:crypto";
import type { AulaSession } from "../client/session.js";
import { getUserCourses } from "../client/client.js";
import { AddressLevel, parseAddress } from "./address.js";
import { downloadAulaFile } from "./file-download.js";
import { userFacingUrl } from "./files.js";
import { findModule } from "./navigate.js";
import { createBranch, createPullRequest, getRepoRef, putFile } from "../../shared/github.js";
import { tpReposFile } from "../../shared/paths.js";
import { resolveTpRepo } from "./tp-repos.js";

/** Un archivo externo linkeado desde la consigna (típico: el notebook de Colab que ES el TP). */
interface ExternalDownload {
    filename: string;
    bytes: Uint8Array;
    sha256: string;
    size: number;
}

/** Extrae el id de Drive de un link de Colab o Drive, si la URL es de ese tipo. */
function driveFileId(url: string): string | null {
    const m =
        /(?:colab\.research\.google\.com\/drive\/|drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/\w+\/d\/)([\w-]+)/.exec(
            url,
        );
    return m?.[1] ?? null;
}

/** Links salientes de la consigna: los href del HTML de la descripción más los contenidos tipo url. */
function externalLinks(description: string | undefined, urls: string[]): string[] {
    const hrefs = [...(description ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    return [...hrefs, ...urls];
}

/**
 * Baja el notebook externo de la consigna (Colab/Drive compartido por link). No es un archivo del
 * aula: la evidencia es el sha256 de lo bajado, no una comparación contra el aula.
 */
async function downloadExternalNotebook(links: string[]): Promise<ExternalDownload> {
    const id = links.map(driveFileId).find((x) => x !== null);
    if (!id) {
        throw new Error(
            "La consigna no tiene adjuntos del aula ni un link de Colab/Drive. Si el TP es otro " +
                "link externo, bajalo a mano: no hay nada que la tool pueda publicar byte-idéntico.",
        );
    }
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, {
        signal: AbortSignal.timeout(60_000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || contentType.startsWith("text/html")) {
        throw new Error(
            "No se pudo bajar el notebook de Colab/Drive: el link no es público (o pide confirmación). " +
                "Abrí el link de la consigna y compartilo como 'cualquiera con el link' para que la tool pueda bajarlo.",
        );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") ?? "";
    const named = /filename\*?=(?:UTF-8''|")?([^";]+)/.exec(disposition)?.[1];
    return {
        filename: named ? decodeURIComponent(named).replace(/"$/, "") : "notebook.ipynb",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
    };
}

export interface TpToGithubArgs {
    direccion: string;
    repo?: string;
    carpeta?: string;
    archivos?: string[];
    rama?: string;
    titulo?: string;
}

interface TpFile {
    filename: string;
    bytes: Uint8Array;
    sha256: string;
    size: number;
}

/** Caracteres que no pueden ir en un path de git; el nombre queda lo más parecido al original. */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^\.+/, "").trim();

const slugify = (text: string) =>
    text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");

/**
 * Carpeta por defecto a partir del nombre de la consigna: "TP 5 - Aplicaciones de AG" →
 * "TP5-Aplicaciones-AG" (sinonimios cortos fuera, siglas en mayúscula conservadas).
 */
const CARPETA_STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "en", "a", "al"]);

export function defaultCarpeta(moduleName: string): string {
    const cleaned = moduleName.trim().replace(/\s+/g, " ");
    const m = /^tp\s*(\d+)\s*[-–:]?\s*(.*)$/i.exec(cleaned);
    const resto = (m ? m[2] : cleaned)
        .split(/\s*[-–—]\s*|\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0 && !CARPETA_STOPWORDS.has(w.toLowerCase()))
        .map((w) => (/^\p{Lu}+$/u.test(w) && w.length <= 4 ? w : w[0].toUpperCase() + w.slice(1)))
        .join("-");
    const carpeta = (m ? `TP${m[1]}` + (resto ? `-${resto}` : "") : resto) || "TP";
    return safeName(carpeta);
}

/**
 * Publica los archivos de una consigna del aula como PR en GitHub: descarga byte-idéntica,
 * rama nueva solo con esos archivos y PR con fuente, sha256 y verificación en la descripción.
 */
export async function tpToGithubPr(session: AulaSession, args: TpToGithubArgs) {
    const address = parseAddress(args.direccion);
    if (address.level !== AddressLevel.Module) {
        throw new Error(
            `Pasá la dirección del módulo de la consigna ("/curso/{courseId}/mod/{cmid}", de aula_open), no "${args.direccion}".`,
        );
    }

    // El repo se resuelve antes de bajar o escribir nada: si hay duda, la respuesta es "elegí", sin efectos.
    const course = (await getUserCourses(session)).find((c) => c.id === address.courseId);
    const courseName = course?.fullname ?? course?.shortname ?? undefined;
    const resolution = await resolveTpRepo(address.courseId, courseName, args.repo);
    if (resolution.estado === "elegir") {
        return {
            estado: "elegir_repo" as const,
            motivo: resolution.motivo,
            candidatos: resolution.candidatos,
            reposPropios: resolution.reposPropios,
            comoElegir:
                "Volvé a llamar la tool con `repo` (y `carpeta` si querés). Para que no lo pregunte más, " +
                `agregá el curso al mapeo ${tpReposFile()}: { "cursos": [ { "cursoId": ${address.courseId}, "materia": "...", "repo": "owner/nombre" } ] }.`,
            curso: courseName,
            consigna: args.direccion,
        };
    }
    const repo = resolution.repo;

    const { module } = await findModule(session, address.courseId, address.cmid);
    const adjuntos = (module.contents ?? []).filter((c) => c.type === "file");
    const links = (module.contents ?? []).filter((c) => c.type === "url").map((c) => c.fileurl);

    let archivos: TpFile[];
    let verificacion: string;
    if (adjuntos.length > 0) {
        const elegidos = args.archivos?.length
            ? adjuntos.filter((c) => args.archivos?.includes(c.filename))
            : adjuntos;
        if (elegidos.length === 0) {
            throw new Error(
                `Ninguno de los nombres pedidos coincide con los adjuntos: ${adjuntos.map((c) => c.filename).join(", ")}.`,
            );
        }
        const { baseUrl } = await session.getRegional();
        archivos = [];
        for (const adjunto of elegidos) {
            const dl = await downloadAulaFile(session, baseUrl, adjunto.fileurl);
            if (adjunto.filesize && dl.size !== adjunto.filesize) {
                throw new Error(
                    `La descarga de "${adjunto.filename}" no es byte-idéntica: el aula dice ${adjunto.filesize} bytes y bajaron ${dl.size}.`,
                );
            }
            archivos.push({ filename: adjunto.filename, bytes: dl.bytes, sha256: dl.sha256, size: dl.size });
        }
        verificacion =
            "descarga byte-idéntica al original del aula (tamaño y sha256); el blob sha de GitHub coincide con lo descargado";
    } else {
        const notebook = await downloadExternalNotebook(externalLinks(module.description, links));
        archivos = [{ filename: notebook.filename, bytes: notebook.bytes, sha256: notebook.sha256, size: notebook.size }];
        verificacion =
            "el archivo es externo (no está en el aula): sha256 del notebook bajado; el blob sha de GitHub coincide con lo descargado";
    }

    const carpetaBase = resolution.carpetaBase?.replace(/^\/+|\/+$/g, "");
    const carpetaPropia = (args.carpeta ?? defaultCarpeta(module.name)).replace(/^\/+|\/+$/g, "");
    const carpeta = carpetaBase ? `${carpetaBase}/${carpetaPropia}` : carpetaPropia;
    const rama = args.rama ?? `tp/${slugify(carpetaPropia)}`;

    const repoRef = await getRepoRef(repo);
    await createBranch(repo, rama, repoRef.headSha);

    const publicados = [];
    for (const archivo of archivos) {
        const path = `${carpeta}/${safeName(archivo.filename)}`;
        const committed = await putFile(repo, rama, path, archivo.bytes, `Add ${path} from the aula TP`);
        if (!committed.verified) {
            throw new Error(
                `GitHub no guardó byte-idéntico "${path}" (blob sha ${committed.blobSha}). Revisá el repo antes de reintentar.`,
            );
        }
        publicados.push({ path, sha256: archivo.sha256, bytes: archivo.size, blobSha: committed.blobSha });
    }

    const fuente = module.url ?? (adjuntos[0] ? userFacingUrl(adjuntos[0].fileurl) : undefined);
    const tabla = publicados.map((f) => `| \`${f.path}\` | \`${f.sha256}\` | ${f.bytes} |`).join("\n");
    const cuerpo =
        `${archivos.length === 1 ? "Archivo original" : "Archivos originales"} del TP tal como está en el aula.\n\n` +
        `- Fuente: aula del curso ${course?.fullname ?? address.courseId}, consigna "${module.name}"${fuente ? ` (${fuente})` : ""}.\n` +
        `- Rama \`${rama}\`: solo ${publicados.length === 1 ? "este archivo" : `estos ${publicados.length} archivos`}.\n` +
        `- Verificación: ${verificacion}.\n\n` +
        "| Archivo | sha256 | Bytes |\n|---|---|---|\n" +
        tabla;

    const pr = await createPullRequest(
        repo,
        rama,
        repoRef.defaultBranch,
        args.titulo ?? module.name,
        cuerpo,
    );

    return {
        estado: "publicado" as const,
        pr: { url: pr.url, numero: pr.number },
        repo,
        repoOrigen: resolution.origen,
        rama,
        base: repoRef.defaultBranch,
        consigna: module.name,
        curso: course?.fullname,
        archivos: publicados,
        verificacion,
    };
}
