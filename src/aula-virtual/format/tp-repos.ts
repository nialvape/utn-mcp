import { readFile } from "node:fs/promises";
import { tpReposFile } from "../../shared/paths.js";
import { getRepoReadme, listOwnRepos } from "../../shared/github.js";

/** Una entrada del mapeo materia → repo, guardado en el tp-repos.json de la carpeta de configuración. */
export interface TpRepoMapping {
    cursoId?: number;
    materia?: string;
    repo: string;
    carpetaBase?: string;
}

interface TpReposConfig {
    cursos?: TpRepoMapping[];
}

export interface RepoCandidate {
    repo: string;
    origen: string;
}

export type RepoResolution =
    | { estado: "resuelto"; repo: string; carpetaBase?: string; origen: string }
    | { estado: "elegir"; motivo: string; candidatos: RepoCandidate[]; reposPropios?: string[] };

const normalize = (text: string) =>
    text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "en", "a", "al"]);

/** Tokens con los que se reconoce una materia: "Nuevas Tecnologías de Redes WAN" → ["nuevas","tecnologias","redes","wan"]. */
function materiaTokens(nombre: string): string[] {
    return normalize(nombre)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Lee el mapeo materia → repo; un archivo que no existe todavía es un mapeo vacío. */
async function readMappings(): Promise<TpRepoMapping[]> {
    let raw: string;
    try {
        raw = await readFile(tpReposFile(), "utf8");
    } catch {
        return [];
    }
    let parsed: TpReposConfig;
    try {
        parsed = JSON.parse(raw) as TpReposConfig;
    } catch {
        throw new Error(`El mapeo materia → repo (${tpReposFile()}) no es JSON válido: corregilo o borralo.`);
    }
    return Array.isArray(parsed.cursos) ? parsed.cursos : [];
}

const asCandidate = (m: TpRepoMapping): RepoCandidate => ({
    repo: m.repo,
    origen: m.cursoId !== undefined ? `mapeo por curso ${m.cursoId}` : `mapeo por materia "${m.materia}"`,
});

/**
 * De qué repo es el TP de un curso. Orden: argumento explícito, mapeo de tp-repos.json (por cursoId
 * y después por nombre de materia) y, en última instancia, heurística sobre los repos propios de
 * GitHub (nombre y descripción; el README desempata). Si no hay una sola respuesta clara, devuelve
 * los candidatos para que el usuario elija: nunca adivina entre repos parecidos.
 */
export async function resolveTpRepo(
    courseId: number,
    courseName: string | undefined,
    repoArg?: string,
): Promise<RepoResolution> {
    if (repoArg) return { estado: "resuelto", repo: repoArg, origen: "argumento `repo`" };

    const mappings = await readMappings();
    const byId = mappings.filter((m) => m.cursoId === courseId);
    if (byId.length === 1) {
        return { estado: "resuelto", repo: byId[0].repo, carpetaBase: byId[0].carpetaBase, origen: asCandidate(byId[0]).origen };
    }
    if (byId.length > 1) {
        return {
            estado: "elegir",
            motivo: `Hay ${byId.length} entradas del mapeo para el curso ${courseId}; dejá una sola en tp-repos.json o pasá \`repo\`.`,
            candidatos: byId.map(asCandidate),
        };
    }

    const nameNorm = normalize(courseName ?? "");
    const byName = mappings.filter((m) => m.materia && nameNorm.includes(normalize(m.materia)));
    if (byName.length === 1) {
        return { estado: "resuelto", repo: byName[0].repo, carpetaBase: byName[0].carpetaBase, origen: asCandidate(byName[0]).origen };
    }
    if (byName.length > 1) {
        return {
            estado: "elegir",
            motivo: `Varias materias del mapeo entran en el nombre del curso "${courseName}".`,
            candidatos: byName.map(asCandidate),
        };
    }

    const tokens = materiaTokens(courseName ?? "");
    if (tokens.length === 0) {
        return {
            estado: "elegir",
            motivo: "El curso no tiene un nombre con el que buscar el repo; pasá `repo` o armá el mapeo.",
            candidatos: [],
        };
    }

    interface Scored {
        repo: string;
        puntaje: number;
        donde: string[];
    }
    const repos = await listOwnRepos();
    const scored: Scored[] = [];
    for (const repo of repos) {
        const hayNombre = normalize(`${repo.fullName} ${repo.description}`);
        const porNombre = tokens.filter((t) => hayNombre.includes(t));
        if (porNombre.length === 0) continue;
        // El README solo desempata entre los que ya coinciden por nombre o descripción.
        const readme = normalize((await getRepoReadme(repo.fullName)) ?? "");
        const porReadme = tokens.filter((t) => !porNombre.includes(t) && readme.includes(t));
        scored.push({
            repo: repo.fullName,
            puntaje: (porNombre.length + 0.5 * porReadme.length) / tokens.length,
            donde: [
                ...(porNombre.length ? [`nombre/descripción (${porNombre.join(", ")})`] : []),
                ...(porReadme.length ? [`README (${porReadme.join(", ")})`] : []),
            ],
        });
    }
    scored.sort((a, b) => b.puntaje - a.puntaje);

    const top = scored[0];
    const second = scored[1];
    if (top && top.puntaje >= 0.5 && (!second || top.puntaje - second.puntaje >= 0.25)) {
        return {
            estado: "resuelto",
            repo: top.repo,
            origen: `heurística por ${top.donde.join(" y ")} (sin mapeo en tp-repos.json)`,
        };
    }
    return {
        estado: "elegir",
        motivo:
            scored.length === 0
                ? `Ningún repo propio coincide con "${courseName}". Pasá \`repo\` o agregá la materia al mapeo.`
                : `Hay ${scored.length} repos que podrían ser de "${courseName}" y ninguno destaca.`,
        candidatos: scored.slice(0, 5).map((s) => ({ repo: s.repo, origen: `coincide por ${s.donde.join(" y ")}` })),
        reposPropios: repos.slice(0, 20).map((r) => r.fullName),
    };
}
