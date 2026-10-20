/**
 * Qué se sabe de si el MCP anda con el aula de una regional:
 * - `verified`: alguien ya entró y usó las tools.
 * - `candidate`: tiene habilitado el servicio `moodle_mobile_app` (y se sabe si entra por SSO), así que
 *   casi seguro anda; se verifica con el primer login que funcione.
 * - `unsupported`: no tiene el servicio habilitado, o entra por un SSO que todavía no sabemos usar
 *   (Office 365); se puede elegir, pero todavía no se puede usar.
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

/**
 * El soporte de las que no son `verified` sale de `tool_mobile_get_public_config`, que Moodle contesta
 * sin login (octubre de 2026). Falta Villa María (FRVM): no encontramos su aula.
 */
const REGIONALS: Regional[] = [
    { id: "fra", name: "Avellaneda (FRA)", baseUrl: "https://www.utnfravirtual.org.ar", support: "candidate" },
    { id: "frbb", name: "Bahía Blanca (FRBB)", baseUrl: "https://aulavirtual.frbb.utn.edu.ar", support: "candidate" },
    {
        id: "frba",
        name: "Buenos Aires (FRBA)",
        baseUrl: "https://aulasvirtuales.frba.utn.edu.ar",
        ssoHost: "auth.frba.utn.edu.ar",
        support: "verified",
    },
    { id: "frch", name: "Chubut (FRCh)", baseUrl: "https://frch.cvg.utn.edu.ar", support: "candidate" },
    { id: "frcu", name: "Concepción del Uruguay (FRCU)", baseUrl: "https://virtual.frcu.utn.edu.ar", support: "candidate" },
    { id: "frcon", name: "Concordia (FRCon)", baseUrl: "https://frcon.cvg.utn.edu.ar", support: "candidate" },
    { id: "frc", name: "Córdoba (FRC)", baseUrl: "https://uv.frc.utn.edu.ar", support: "candidate" },
    { id: "frd", name: "Delta (FRD)", baseUrl: "https://frd.cvg.utn.edu.ar", support: "candidate" },
    { id: "frgp", name: "General Pacheco (FRGP)", baseUrl: "https://frgp.cvg.utn.edu.ar", support: "candidate" },
    // Office 365.
    { id: "frh", name: "Haedo (FRH)", baseUrl: "https://frh.cvg.utn.edu.ar", support: "unsupported" },
    { id: "frlp", name: "La Plata (FRLP)", baseUrl: "https://frlp.cvg.utn.edu.ar", support: "candidate" },
    { id: "frlr", name: "La Rioja (FRLR)", baseUrl: "https://frlr.cvg.utn.edu.ar", support: "candidate" },
    // Tiene también frmdp.cvg.utn.edu.ar, pero ese no tiene el servicio habilitado y entra con Office 365.
    { id: "frmdp", name: "Mar del Plata (FRMDP)", baseUrl: "https://campus.mdp.utn.edu.ar", support: "candidate" },
    // Sin el servicio habilitado.
    { id: "frm", name: "Mendoza (FRM)", baseUrl: "https://campusvirtual.frm.utn.edu.ar", support: "unsupported" },
    { id: "frn", name: "Neuquén (FRN)", baseUrl: "https://frn.cvg.utn.edu.ar", support: "candidate" },
    { id: "frp", name: "Paraná (FRP)", baseUrl: "https://frp.cvg.utn.edu.ar", support: "candidate" },
    { id: "frra", name: "Rafaela (FRRa)", baseUrl: "https://frra.cvg.utn.edu.ar", support: "candidate" },
    { id: "frrq", name: "Reconquista (FRRq)", baseUrl: "https://frrq.cvg.utn.edu.ar", support: "candidate" },
    { id: "frre", name: "Resistencia (FRRE)", baseUrl: "https://frre.cvg.utn.edu.ar", support: "verified" },
    { id: "frro", name: "Rosario (FRRo)", baseUrl: "https://frro.cvg.utn.edu.ar", support: "candidate" },
    { id: "frsfco", name: "San Francisco (FRSFco)", baseUrl: "https://frsfco.cvg.utn.edu.ar", support: "candidate" },
    // Office 365.
    { id: "frsn", name: "San Nicolás (FRSN)", baseUrl: "https://frsn.cvg.utn.edu.ar", support: "unsupported" },
    { id: "frsr", name: "San Rafael (FRSR)", baseUrl: "https://campus.frsr.utn.edu.ar/moodle", support: "candidate" },
    { id: "frsc", name: "Santa Cruz (FRSC)", baseUrl: "https://frsc.cvg.utn.edu.ar", support: "candidate" },
    { id: "frsf", name: "Santa Fe (FRSF)", baseUrl: "https://campusvirtual.frsf.utn.edu.ar", support: "candidate" },
    // Sin el servicio habilitado.
    { id: "frtdf", name: "Tierra del Fuego (FRTDF)", baseUrl: "https://cvg.frtdf.utn.edu.ar", support: "unsupported" },
    { id: "frtl", name: "Trenque Lauquen (FRTL)", baseUrl: "https://frtl.cvg.utn.edu.ar", support: "candidate" },
    { id: "frt", name: "Tucumán (FRT)", baseUrl: "https://frt.cvg.utn.edu.ar", support: "verified" },
    // Sin el servicio habilitado.
    { id: "frvt", name: "Venado Tuerto (FRVT)", baseUrl: "https://frvt.cvg.utn.edu.ar", support: "unsupported" },
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

/** Su aula no tiene el servicio habilitado o entra por un SSO que no sabemos usar: ni se intenta entrar. */
export class UnsupportedRegionalError extends Error {
    name = "UnsupportedRegionalError";
    constructor(readonly regional: Regional) {
        super(
            `Todavía no hay soporte para ${regional.name}: su aula no tiene habilitado el servicio que usa ` +
                "UTN-MCP o entra por un login que todavía no sabemos usar.",
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
