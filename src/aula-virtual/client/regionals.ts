/**
 * Qué se sabe de si el MCP anda con el aula de una regional:
 * - `verified`: alguien ya entró y usó las tools.
 * - `candidate`: tiene habilitado el servicio `moodle_mobile_app` (y se sabe si entra por SSO), así que
 *   casi seguro anda; se verifica con el primer login que funcione.
 * - `unsupported`: no tiene el servicio habilitado; se puede elegir, pero todavía no se puede usar.
 */
export type RegionalSupport = "verified" | "candidate" | "unsupported";

/** El aula virtual de una regional de la UTN. */
export interface Regional {
    id: string;
    name: string;
    baseUrl: string;
    ssoHost?: string;
    support: RegionalSupport;
}

const REGIONALS: Regional[] = [
    {
        id: "frba",
        name: "Buenos Aires (FRBA)",
        baseUrl: "https://aulasvirtuales.frba.utn.edu.ar",
        ssoHost: "auth.frba.utn.edu.ar",
        support: "verified",
    },
    { id: "frre", name: "Resistencia (FRRE)", baseUrl: "https://frre.cvg.utn.edu.ar", support: "verified" },
    { id: "frt", name: "Tucumán (FRT)", baseUrl: "https://frt.cvg.utn.edu.ar", support: "verified" },
];

const DEFAULT_REGIONAL = "frba";

/** `UTN_REGIONAL` no está en el registro: sin cortar acá, las credenciales irían al SSO de FRBA. */
export class UnknownRegionalError extends Error {
    name = "UnknownRegionalError";
    constructor(regional: string) {
        super(
            `"${regional}" no es una regional conocida. Las válidas son: ${availableRegionals().map((r) => r.id).join(", ")}. ` +
                "Si tu campus no está en la lista, borrá UTN_REGIONAL y definí UTN_AULA_BASE_URL con la URL del aula " +
                "(y UTN_SSO_HOST si usa Keycloak).",
        );
    }
}

/** La regional no tiene habilitado `moodle_mobile_app`: sin él no hay token, así que ni se intenta entrar. */
export class UnsupportedRegionalError extends Error {
    name = "UnsupportedRegionalError";
    constructor(readonly regional: Regional) {
        super(
            `El aula de ${regional.name} todavía no tiene habilitado el servicio que usa UTN-MCP, así que por ahora ` +
                "no se puede usar. Lo tiene que habilitar quien administra el aula de esa regional.",
        );
    }
}

/** El aula de UTN_AULA_BASE_URL, para un campus que no está en el registro. */
function customRegional(): Regional | undefined {
    const raw = process.env.UTN_AULA_BASE_URL?.trim();
    if (!raw) return undefined;
    const baseUrl = raw.replace(/\/+$/, "");
    const host = new URL(baseUrl).host;
    return { id: host, name: host, baseUrl, ssoHost: process.env.UTN_SSO_HOST?.trim() || undefined, support: "verified" };
}

/**
 * Las que se pueden elegir al iniciar sesión: el catálogo y, si está definida, la de UTN_AULA_BASE_URL.
 * `verifiedIds` son las `candidate` que ya se verificaron en el servidor (las guarda el store).
 */
export function availableRegionals(verifiedIds: Iterable<string> = []): Regional[] {
    const verified = new Set(verifiedIds);
    const custom = customRegional();
    return [...REGIONALS, ...(custom ? [custom] : [])].map((r) =>
        r.support === "candidate" && verified.has(r.id) ? { ...r, support: "verified" } : r,
    );
}

/** La regional con ese id; si no está entre las disponibles, `UnknownRegionalError`. */
export function findRegional(id: string): Regional {
    const wanted = id.trim().toLowerCase();
    const found = availableRegionals().find((r) => r.id === wanted);
    if (!found) throw new UnknownRegionalError(id);
    return found;
}

/**
 * La que viene elegida si nadie dice otra: la de UTN_REGIONAL; si no, la de UTN_AULA_BASE_URL; si no,
 * FRBA. Es la de quien usa UTN_USER/UTN_PASS sin `utn-mcp login`, y la opción por defecto al elegir.
 */
export function defaultRegional(): Regional {
    const fromEnv = process.env.UTN_REGIONAL?.trim();
    if (fromEnv) return findRegional(fromEnv);
    return customRegional() ?? findRegional(DEFAULT_REGIONAL);
}
