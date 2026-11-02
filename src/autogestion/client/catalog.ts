/** Qué se sabe del conector en una regional: `verified` = alguien entró con una cuenta real; `candidate` = falta esa prueba. */
export type SystemSupport = "verified" | "candidate";

/**
 * Un conector que `utn-mcp login` sabe instalar: el `.tgz` de `npm pack` adjunto a un release del repo.
 * La URL fija la versión y `integrity` el contenido exacto: cargar un paquete es ejecutar su código,
 * así que solo se instala lo que nombra este catálogo, nunca un nombre que venga del usuario o del entorno.
 */
export interface CatalogEntry {
    id: string;
    name: string;
    package: string;
    version: string;
    tarball: string;
    /** sha512 del `.tgz` en base64, como el campo `integrity` de npm. */
    integrity: string;
    /** Las regionales que atiende y su soporte, para ofrecerlo en el login antes de bajar nada. */
    regionales: Record<string, SystemSupport>;
}

const RELEASES = "https://github.com/nialvape/utn-mcp/releases/download";

/** Las mismas regionales que `ASP_REGIONALS` del paquete; las que quedaron afuera dicen por qué ahí. */
const SYSACAD_ASP_REGIONALS = [
    "frbb", "frch", "frcon", "frd", "frgp", "frh", "frlr", "frmdp", "frn",
    "frp", "frrq", "frsf", "frsfco", "frsn", "frsr", "frt", "frtdf", "frvt",
] as const;

export const CATALOG: CatalogEntry[] = [
    {
        id: "sysacad-asp",
        name: "Sysacad",
        package: "utn-mcp-sysacad-asp",
        version: "0.1.0",
        tarball: `${RELEASES}/sysacad-asp-v0.1.0/utn-mcp-sysacad-asp-0.1.0.tgz`,
        integrity: "sha512-dFiMVUwQJdLHmrKD6BZnUgn5EU73pzAzSBEEQyCA4P2eXOI6QeTRLnmGW//K1hmFJXl74Ax10VQrpVweY6+1Gw==",
        // FRT anduvo con cuenta real (oct 2026) con la versión anterior, que posteaba directo a `menuAlumno.asp`;
        // esta lee el formulario y todavía no entró nadie con ella.
        regionales: Object.fromEntries(SYSACAD_ASP_REGIONALS.map((id) => [id, "candidate" as const])),
    },
];

export function catalogEntryForRegional(regionalId: string): CatalogEntry | null {
    return CATALOG.find((entry) => regionalId in entry.regionales) ?? null;
}
