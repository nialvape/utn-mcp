import { timingSafeEqual } from "node:crypto";
import express, { type Express, type RequestHandler, type Response } from "express";
import { linkAulaAccount, type LinkedAccount } from "../aula-virtual/client/link.js";
import { availableRegionals, type Regional, type RegionalSupport } from "../aula-virtual/client/regionals.js";
import { InvalidCredentialsError, MfaError, type MfaPrompt } from "../aula-virtual/client/sso-login.js";
import { AULA_PLATFORM } from "../aula-virtual/client/stored-session.js";
import { logger } from "../shared/logger.js";
import type { SessionStore, StoredUser } from "../shared/store/session-store.js";
import { Expiring, RateLimiter } from "../shared/expiring.js";
import { PendingLogin } from "./pending-login.js";

/** Intentos de `/admin/verificar` por cuenta del aula cada 15 minutos: que no sirva para probar contraseñas. */
const VERIFY_ATTEMPTS = 5;
const VERIFY_WINDOW_MS = 15 * 60_000;
/** Cuánto tiene el usuario para completar el segundo factor, en milisegundos: lo mismo que en el login de OAuth. */
const SECOND_FACTOR_TTL_MS = 10 * 60_000;

/** Una verificación con usuario y contraseña ya mandados, que puede quedar esperando el segundo factor. */
interface PendingVerification {
    flow: PendingLogin<LinkedAccount>;
    regional: Regional;
    username: string;
}

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
    const secondFactors = new Expiring<PendingVerification>(SECOND_FACTOR_TTL_MS);

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
     * existe y le guarda la sesión, así ya puede usar las tools. Devuelve `{ usuario, nombre, email,
     * primero? }`, con `primero` si fue el primero en verificar la regional; si no entra, `{ error, motivo }`.
     * Si Microsoft pide MFA, devuelve `{ segundoFactor }` y el login sigue con `/admin/segundo-factor`.
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
        const flow = new PendingLogin((secondFactor) => linkAulaAccount(store, regional, { username, password }, secondFactor));
        await advance(res, { flow, regional, username });
    });

    /**
     * `{ login, respuesta }` → contesta lo que pidió el segundo factor: el `id` del método, el código o
     * cualquier cosa cuando el usuario ya aprobó. Devuelve lo mismo que `/admin/verificar`.
     */
    app.post("/admin/segundo-factor", requireSecret, json, async (req, res) => {
        const id = typeof req.body?.login === "string" ? req.body.login : "";
        const verification = id ? secondFactors.get(id) : undefined;
        if (!verification) {
            return void res.status(410).json({ error: "vencido", motivo: "Pasó demasiado tiempo. Volvé a iniciar sesión." });
        }
        verification.flow.answer(typeof req.body?.respuesta === "string" ? req.body.respuesta : "");
        await advance(res, verification, id);
    });

    /** Sigue el login hasta que termina o pide el segundo factor; `id` es el de uno que ya estaba esperando. */
    async function advance(res: Response, verification: PendingVerification, id?: string) {
        const { flow, regional, username } = verification;
        try {
            const step = await flow.next();
            if ("prompt" in step) {
                return void res.json({ segundoFactor: secondFactorJson(id ?? secondFactors.add(verification), step.prompt) });
            }
            if (id) secondFactors.take(id);
            const account = step.done;
            logger.info(`Admin: ${account.username} (${regional.id}) vinculó su aula.`);
            res.json({
                usuario: account.username,
                nombre: account.fullname,
                email: account.email ?? undefined,
                primero: account.firstVerifier || undefined,
            });
        } catch (e) {
            if (id) secondFactors.take(id);
            if (e instanceof InvalidCredentialsError) {
                return void res.status(401).json({ error: "credenciales", motivo: "El aula rechazó el usuario o la contraseña." });
            }
            if (e instanceof MfaError) return void res.status(422).json({ error: "mfa", motivo: e.message });
            logger.warn(`Verificación de ${username} (${regional.id}): ${(e as Error).message}`);
            res.status(502).json({ error: "aula", motivo: `No pudimos entrar al aula de ${regional.name}.` });
        }
    }
}

/**
 * Lo que pide el segundo factor, para que el panel se lo muestre al usuario. `login` es el id con el que
 * se contesta; `paso` es "elegir" (con `metodos`), "codigo" (con `reintento` si el anterior estaba mal)
 * o "aprobar" (con `numero` si Authenticator pide tipearlo).
 */
function secondFactorJson(login: string, prompt: MfaPrompt) {
    if (prompt.step === "choose") {
        return { login, paso: "elegir", metodos: prompt.methods.map((m) => ({ id: m.id, nombre: m.label })) };
    }
    if (prompt.step === "code") return { login, paso: "codigo", metodo: prompt.method.label, reintento: prompt.retry || undefined };
    return { login, paso: "aprobar", metodo: prompt.method.label, numero: prompt.number };
}
