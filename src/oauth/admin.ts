import { timingSafeEqual } from "node:crypto";
import express, { type Express, type RequestHandler } from "express";
import { linkAulaAccount } from "../aula-virtual/client/link.js";
import { availableRegionals, type RegionalSupport } from "../aula-virtual/client/regionals.js";
import { InvalidCredentialsError } from "../aula-virtual/client/sso-login.js";
import { AULA_PLATFORM } from "../aula-virtual/client/stored-session.js";
import { logger } from "../shared/logger.js";
import type { SessionStore, StoredUser } from "../shared/store/session-store.js";
import { RateLimiter } from "./expiring.js";

/** Intentos de `/admin/verificar` por cuenta del aula cada 15 minutos: que no sirva para probar contraseñas. */
const VERIFY_ATTEMPTS = 5;
const VERIFY_WINDOW_MS = 15 * 60_000;

const SUPPORT: Record<RegionalSupport, string> = { verified: "verificada", candidate: "candidata", unsupported: "sin_soporte" };

/** Segundos desde epoch, como los guarda el store, a ISO. */
const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * API para que otro servicio del que hostea (un panel de cuenta, por ejemplo) liste usuarios, muestre y
 * desconecte sus apps, consulte las regionales y dé de alta cuentas vinculando su aula. Solo
 * existe con UTN_MCP_ADMIN_SECRET, que va como `Authorization: Bearer`. Los usuarios se buscan por email.
 */
export function mountAdmin(app: Express, store: SessionStore, secret: string) {
    const json = express.json({ limit: "4kb" });
    const verifyLimiter = new RateLimiter(VERIFY_ATTEMPTS, VERIFY_WINDOW_MS);

    const requireSecret: RequestHandler = (req, res, next) => {
        const got = Buffer.from(req.headers.authorization ?? "");
        const want = Buffer.from(`Bearer ${secret}`);
        if (got.length === want.length && timingSafeEqual(got, want)) return next();
        res.status(401).json({ error: "No autorizado." });
    };

    /** El usuario, su regional, cuándo se renovó su sesión del aula y sus apps conectadas. */
    async function summary(user: StoredUser) {
        const [clients, aulaAt] = await Promise.all([
            store.listConnectedClients(user.id),
            store.sessionUpdatedAt(user.id, AULA_PLATFORM),
        ]);
        return {
            usuario: user.utnUsername,
            regional: user.regional,
            sesionAula: aulaAt ? isoDate(aulaAt) : undefined,
            clientes: clients.map((c) => ({
                id: c.clientId,
                nombre: c.clientName ?? (c.clientId === "local" ? "Token de utn-mcp login" : "App sin nombre"),
                ultimoUso: isoDate(c.lastTokenAt),
            })),
        };
    }

    /** `{ email }` → el resumen de ese usuario. */
    app.post("/admin/clientes", requireSecret, json, async (req, res) => {
        const email = typeof req.body?.email === "string" ? req.body.email : "";
        const user = email ? await store.findUserByEmail(email) : null;
        res.json(user ? await summary(user) : { clientes: [] });
    });

    /** Todos los usuarios con su resumen, para el panel de quien administra el servidor. */
    app.post("/admin/usuarios", requireSecret, async (_req, res) => {
        const users = await store.listUsers();
        const usuarios = await Promise.all(
            users.map(async (u) => ({ email: u.email || undefined, alta: isoDate(u.createdAt), ...(await summary(u)) })),
        );
        res.json({ usuarios });
    });

    /** `{ email, cliente }` → borra los tokens de esa app: tiene que volver a conectarse. */
    app.post("/admin/clientes/revocar", requireSecret, json, async (req, res) => {
        const email = typeof req.body?.email === "string" ? req.body.email : "";
        const clientId = typeof req.body?.cliente === "string" ? req.body.cliente : "";
        const user = email ? await store.findUserByEmail(email) : null;
        if (!user || !clientId) return void res.status(404).json({ error: "No existe ese usuario o esa app." });
        await store.revokeClient(user.id, clientId);
        res.json({ revocado: true });
    });

    /** Las regionales que se pueden elegir, con su soporte en este servidor. */
    app.post("/admin/regionales", requireSecret, async (_req, res) => {
        const regionales = availableRegionals(await store.listVerifiedRegionals()).map((r) => ({
            id: r.id,
            nombre: r.name,
            soporte: SUPPORT[r.support],
        }));
        res.json({ regionales });
    });

    /**
     * `{ regional, usuario, contrasena }` → entra al aula como el login de OAuth: crea el usuario si no
     * existe y le guarda la sesión, así ya puede usar las tools. Devuelve `{ usuario, nombre, email }`; si
     * no entra, `{ error, motivo }`.
     */
    app.post("/admin/verificar", requireSecret, json, async (req, res) => {
        const id = typeof req.body?.regional === "string" ? req.body.regional : "";
        const username = typeof req.body?.usuario === "string" ? req.body.usuario.trim() : "";
        const password = typeof req.body?.contrasena === "string" ? req.body.contrasena : "";
        const regional = availableRegionals(await store.listVerifiedRegionals()).find((r) => r.id === id);
        if (!regional || !username || !password) {
            return void res.status(400).json({ error: "pedido", motivo: "Faltan la regional, el usuario o la contraseña." });
        }
        if (regional.support === "unsupported") {
            return void res.status(422).json({ error: "sin_soporte", motivo: `Todavía no hay soporte para ${regional.name}.` });
        }
        if (!verifyLimiter.allow(`${regional.id}:${username.toLowerCase()}`)) {
            return void res.status(429).json({ error: "intentos", motivo: "Demasiados intentos. Esperá unos minutos." });
        }
        try {
            const account = await linkAulaAccount(store, regional, { username, password });
            logger.info(`Admin: ${account.username} (${regional.id}) vinculó su aula.`);
            res.json({ usuario: account.username, nombre: account.fullname, email: account.email ?? undefined });
        } catch (e) {
            if (e instanceof InvalidCredentialsError) {
                return void res.status(401).json({ error: "credenciales", motivo: "El aula rechazó el usuario o la contraseña." });
            }
            logger.warn(`Verificación de ${username} (${regional.id}): ${(e as Error).message}`);
            res.status(502).json({ error: "aula", motivo: `No pudimos entrar al aula de ${regional.name}.` });
        }
    });
}
