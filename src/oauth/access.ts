import { logger } from "../shared/logger.js";

export type AccessDecision = { allowed: true } | { allowed: false; reason: string; url?: string };

/** Quién puede usar el servidor: decide con el usuario que acaba de entrar al aula de su regional. */
export type AccessPolicy = (user: { regional: string; username: string; email: string | null }) => Promise<AccessDecision>;

/** Cuánto esperamos la respuesta de UTN_MCP_ACCESS_URL, en milisegundos. */
const ACCESS_TIMEOUT_MS = 5_000;

/** Lo que contesta UTN_MCP_ACCESS_URL. */
interface RemoteDecision {
    permitido?: boolean;
    motivo?: string;
    url?: string;
}

/**
 * La política sale del entorno: con UTN_MCP_ACCESS_URL decide otro servicio;
 * con UTN_MCP_ALLOWED_EMAILS, una lista; sin ninguna, entra cualquiera con usuario de la UTN.
 */
export function accessPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AccessPolicy {
    if (env.UTN_MCP_ACCESS_URL) return remotePolicy(env.UTN_MCP_ACCESS_URL, env.UTN_MCP_ACCESS_SECRET);
    if (env.UTN_MCP_ALLOWED_EMAILS) return listPolicy(env.UTN_MCP_ALLOWED_EMAILS);
    logger.warn("Sin UTN_MCP_ACCESS_URL ni UTN_MCP_ALLOWED_EMAILS: puede entrar cualquiera con usuario de la UTN.");
    return async () => ({ allowed: true });
}

/** Emails o dominios (`@frba.utn.edu.ar`), separados por coma. */
function listPolicy(raw: string): AccessPolicy {
    const entries = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    return async ({ email }) => {
        const own = email?.toLowerCase();
        if (own && entries.some((e) => (e.startsWith("@") ? own.endsWith(e) : own === e))) return { allowed: true };
        return { allowed: false, reason: "Tu cuenta no está habilitada en este servidor. Pedile acceso a quien lo administra." };
    };
}

/** `POST url` con `{ email, usuario, regional }`; contesta `{ permitido, motivo?, url? }`. */
function remotePolicy(url: string, secret: string | undefined): AccessPolicy {
    if (!secret) logger.warn("UTN_MCP_ACCESS_URL sin UTN_MCP_ACCESS_SECRET: el pedido de acceso va sin autenticar.");
    return async ({ regional, username, email }) => {
        if (!email) return { allowed: false, reason: "El aula no devolvió tu email, y sin él no podemos verificar tu acceso." };
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
                body: JSON.stringify({ email, usuario: username, regional }),
                signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as RemoteDecision;
            if (data.permitido === true) return { allowed: true };
            return { allowed: false, reason: data.motivo || "Tu cuenta no está habilitada en este servidor.", url: data.url };
        } catch (e) {
            logger.error(`No se pudo consultar el acceso de ${email}: ${(e as Error).message}`);
            return { allowed: false, reason: "No pudimos verificar si tenés acceso: probá de nuevo en unos minutos." };
        }
    };
}
