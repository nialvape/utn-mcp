import { createHash, randomUUID } from "node:crypto";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import {
    buildOAuthProtectedResourceMetadata,
    checkResourceAllowed,
    getOAuthProtectedResourceMetadataUrl,
    type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { linkAulaAccount, type LinkedAccount } from "../aula-virtual/client/link.js";
import { availableRegionals, defaultRegional, type Regional } from "../aula-virtual/client/regionals.js";
import { InvalidCredentialsError, MfaError, type MfaPrompt } from "../aula-virtual/client/sso-login.js";
import { logger } from "../shared/logger.js";
import { escapeHtml, page } from "../shared/pages.js";
import type { SessionStore } from "../shared/store/session-store.js";
import type { AccessPolicy } from "./access.js";
import { Expiring, RateLimiter } from "./expiring.js";
import { PendingLogin } from "./pending-login.js";
import { describeRedirect, redirectTrust, type RedirectAllowlist } from "./redirects.js";

/** Duración del access token, en segundos: una baja de acceso se aplica a más tardar en este tiempo. */
const ACCESS_TTL = 60 * 60;
/** Duración del refresh token, en segundos. Rota en cada uso. */
const REFRESH_TTL = 30 * 24 * 60 * 60;
/** Cuánto vive un code sin canjear, en milisegundos. */
const CODE_TTL_MS = 60_000;
/** Cuánto tiene el usuario para completar el login, en milisegundos. */
const PENDING_TTL_MS = 10 * 60_000;
/** Intentos de login por IP cada 15 minutos: que el servidor no sirva para probar contraseñas contra el SSO. */
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** Registros de clientes por IP cada hora. */
const REGISTER_ATTEMPTS = 20;
const REGISTER_WINDOW_MS = 60 * 60_000;

export interface OAuthOptions {
    /** URL base del servidor, sin barra final: es el issuer y de ahí salen los endpoints. */
    issuer: string;
    store: SessionStore;
    access: AccessPolicy;
    /** Rechaza los POST de formularios que vengan de otro origen. */
    sameOrigin: RequestHandler;
    /** A dónde puede volver el navegador con el code. */
    redirects: RedirectAllowlist;
}

/** Un pedido de `/authorize` esperando que el usuario entre con la UTN. */
interface PendingAuthorization {
    clientId: string;
    clientName: string | null;
    redirectUri: string;
    /** Vuelve a un sitio que no es de un cliente conocido: el usuario tiene que aceptar el aviso. */
    unknownRedirect: boolean;
    codeChallenge: string;
    state?: string;
    resource?: string;
}

/** Vuelve a mostrar el formulario de login con un error, en el request que esté contestando. */
type Retry = (res: Response, error: string) => void;

/** Un login con usuario y contraseña ya mandados, que puede quedar esperando el segundo factor. */
interface UtnLogin {
    flow: PendingLogin<LinkedAccount>;
    regional: Regional;
    username: string;
    retry: Retry;
    /** Lo que se hace con la cuenta cuando el login termina: emitir el code o avisar que se renovó. */
    finish: (res: Response, account: LinkedAccount) => Promise<void>;
}

interface IssuedCode {
    userId: number;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
}

/**
 * Servidor de autorización OAuth 2.1 para los clientes MCP: registro dinámico, PKCE obligatorio y
 * clientes públicos. El usuario se identifica con la UTN, y ese mismo login vincula su aula: la
 * contraseña se usa una vez y no se guarda. Devuelve la URL de la metadata del recurso, que va en el 401.
 */
export function mountOAuth(app: Express, { issuer, store, access, sameOrigin, redirects }: OAuthOptions): string {
    const resource = `${issuer}/mcp`;
    const metadata: OAuthMetadata = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
    };
    // Valida el issuer al arrancar (HTTPS salvo en localhost) en lugar de en el primer request.
    const resourceMetadata = buildOAuthProtectedResourceMetadata({
        oauthMetadata: metadata,
        resourceServerUrl: new URL(resource),
        resourceName: "UTN-MCP",
    });

    const pending = new Expiring<PendingAuthorization>(PENDING_TTL_MS);
    const codes = new Expiring<IssuedCode>(CODE_TTL_MS);
    const secondFactors = new Expiring<UtnLogin>(PENDING_TTL_MS);
    const limiter = new RateLimiter(LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);
    const registerLimiter = new RateLimiter(REGISTER_ATTEMPTS, REGISTER_WINDOW_MS);
    const form = express.urlencoded({ extended: false, limit: "16kb" });
    const regionals = async () => availableRegionals(await store.listVerifiedRegionals());

    app.get("/.well-known/oauth-authorization-server", cors, (_req, res) => void res.json(metadata));
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], cors, (_req, res) =>
        void res.json(resourceMetadata),
    );

    app.options(["/register", "/token", "/revoke"], cors, (_req, res) => void res.sendStatus(204));

    app.post("/register", cors, express.json({ limit: "16kb" }), async (req, res) => {
        if (!registerLimiter.allow(req.ip ?? "desconocida")) {
            return void oauthError(res, 429, "too_many_requests", "Demasiados registros desde esta IP. Probá en una hora.");
        }
        const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
        const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
        if (!uris.length || uris.some((u) => redirectTrust(u, redirects) === "rejected")) {
            // Queda en el log para poder habilitar el esquema de una app nueva con UTN_MCP_REDIRECT_ALLOW.
            logger.warn(`OAuth /register rechazado: ${JSON.stringify(uris).slice(0, 300)}`);
            return void oauthError(
                res,
                400,
                "invalid_redirect_uri",
                "Las redirect_uri tienen que ser HTTPS, de loopback o de una app habilitada en este servidor " +
                    "(UTN_MCP_REDIRECT_ALLOW), y sin fragmento.",
            );
        }
        const client = {
            clientId: randomUUID(),
            clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null,
            redirectUris: uris as string[],
        };
        await store.saveClient(client);
        res.status(201).json({
            client_id: client.clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: client.clientName ?? undefined,
            redirect_uris: client.redirectUris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        });
    });

    app.get("/authorize", async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const client = q.client_id ? await store.findClient(q.client_id) : null;
        // Sin cliente o redirect_uri válidos no se redirige a ningún lado: el error lo ve el usuario.
        if (!client) return void errorPage(res, 400, "Cliente desconocido", "Este cliente no está registrado. Volvé a conectarlo desde tu app.");
        if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
            return void errorPage(res, 400, "Redirección inválida", "La redirect_uri no es la que registró el cliente.");
        }
        const trust = redirectTrust(q.redirect_uri, redirects);
        if (trust === "rejected") {
            return void errorPage(res, 400, "App no habilitada", "Esta app vuelve a una dirección que este servidor no acepta.");
        }

        const fail = (error: string, description: string) => redirectWith(res, q.redirect_uri!, { error, error_description: description, state: q.state });
        if (q.response_type !== "code") return void fail("unsupported_response_type", "Solo se acepta response_type=code.");
        if (!q.code_challenge || q.code_challenge_method !== "S256") {
            return void fail("invalid_request", "PKCE es obligatorio, con code_challenge_method=S256.");
        }
        if (q.resource && !checkResourceAllowed({ requestedResource: q.resource, configuredResource: resource })) {
            return void fail("invalid_target", `El único recurso de este servidor es ${resource}.`);
        }

        const id = pending.add({
            clientId: client.clientId,
            clientName: client.clientName,
            redirectUri: q.redirect_uri,
            unknownRedirect: trust === "unknown",
            codeChallenge: q.code_challenge,
            state: q.state,
            resource: q.resource,
        });
        res.type("html").send(
            loginPage({
                action: "/authorize",
                regionals: await regionals(),
                pendingId: id,
                clientName: client.clientName,
                redirectUri: q.redirect_uri,
                unknownRedirect: trust === "unknown",
            }),
        );
    });

    app.post("/authorize", sameOrigin, form, async (req, res) => {
        const id = String(req.body?.pedido ?? "");
        const request = pending.get(id);
        if (!request) return void errorPage(res, 400, "Pedido vencido", "Pasó demasiado tiempo. Volvé a conectar desde tu app.");

        const list = await regionals();
        const retry: Retry = (res, error) =>
            res.type("html").send(
                loginPage({
                    action: "/authorize",
                    regionals: list,
                    pendingId: id,
                    clientName: request.clientName,
                    redirectUri: request.redirectUri,
                    unknownRedirect: request.unknownRedirect,
                    regional: req.body?.regional,
                    error,
                }),
            );
        if (request.unknownRedirect && req.body?.acepto !== "si") {
            return void retry(res, "Para conectar una app que no es un cliente conocido tenés que aceptar el aviso.");
        }
        await login(req, res, list, retry, async (res, account) => {
            const decision = await access({ regional: account.regional.id, username: account.username, email: account.email });
            if (!decision.allowed) return void deniedPage(res, decision.reason, decision.url);

            if (!pending.take(id)) {
                return void errorPage(res, 400, "Pedido vencido", "Pasó demasiado tiempo. Volvé a conectar desde tu app.");
            }
            const code = codes.add({
                userId: account.userId,
                clientId: request.clientId,
                redirectUri: request.redirectUri,
                codeChallenge: request.codeChallenge,
            });
            logger.info(`OAuth: ${account.username} (${account.regional.id}) autorizó a ${request.clientName ?? request.clientId}.`);
            redirectWith(res, request.redirectUri, { code, state: request.state, iss: issuer });
        });
    });

    app.post("/token", cors, form, express.json({ limit: "16kb" }), async (req, res) => {
        const body = (req.body ?? {}) as Record<string, string | undefined>;
        try {
            if (body.grant_type === "authorization_code") {
                const code = body.code ? codes.take(body.code) : undefined;
                if (!code) return void oauthError(res, 400, "invalid_grant", "El code no existe, venció o ya se usó.");
                if (body.client_id && body.client_id !== code.clientId) {
                    return void oauthError(res, 400, "invalid_grant", "El code es de otro cliente.");
                }
                if (body.redirect_uri && body.redirect_uri !== code.redirectUri) {
                    return void oauthError(res, 400, "invalid_grant", "La redirect_uri no coincide con la del pedido.");
                }
                if (!body.code_verifier || pkceChallenge(body.code_verifier) !== code.codeChallenge) {
                    return void oauthError(res, 400, "invalid_grant", "El code_verifier no corresponde al code_challenge.");
                }
                return void res.json(await issueTokens(store, code.userId, code.clientId));
            }

            if (body.grant_type === "refresh_token") {
                const found = body.refresh_token ? await store.findToken(body.refresh_token, "refresh") : null;
                if (!found) return void oauthError(res, 400, "invalid_grant", "El refresh token no existe, venció o fue revocado.");
                const clientId = found.clientId ?? body.client_id ?? "desconocido";
                if (body.client_id && found.clientId && body.client_id !== found.clientId) {
                    return void oauthError(res, 400, "invalid_grant", "El refresh token es de otro cliente.");
                }
                await store.revokeToken(body.refresh_token!);

                // El acceso se vuelve a mirar en cada refresh: si la cuenta se dio de baja, acá se corta.
                const user = await store.findUser(found.userId);
                if (!user) return void oauthError(res, 400, "invalid_grant", "El usuario ya no existe.");
                const decision = await access({ regional: user.regional, username: user.utnUsername, email: user.email });
                if (!decision.allowed) return void oauthError(res, 400, "invalid_grant", decision.reason);
                return void res.json(await issueTokens(store, user.id, clientId));
            }

            oauthError(res, 400, "unsupported_grant_type", "Solo authorization_code y refresh_token.");
        } catch (e) {
            logger.error(`OAuth /token: ${(e as Error).message}`);
            oauthError(res, 500, "server_error", "Error interno al emitir el token.");
        }
    });

    app.post("/revoke", cors, form, express.json({ limit: "16kb" }), async (req, res) => {
        const token = (req.body as { token?: string } | undefined)?.token;
        if (token) await store.revokeToken(token);
        // RFC 7009: se contesta 200 aunque el token no exista.
        res.sendStatus(200);
    });

    // Volver a iniciar sesión cuando vence la sesión del aula: no emite tokens, solo renueva la sesión.
    app.get("/login", async (_req, res) => void res.type("html").send(loginPage({ action: "/login", regionals: await regionals() })));
    app.post("/login", sameOrigin, form, async (req, res) => {
        const list = await regionals();
        const retry: Retry = (res, error) =>
            res.type("html").send(
                loginPage({
                    action: "/login",
                    regionals: list,
                    regional: req.body?.regional,
                    error,
                }),
            );
        await login(req, res, list, retry, async (res, account) => {
            logger.info(`OAuth: ${account.username} (${account.regional.id}) renovó su sesión del aula.`);
            res.type("html").send(page("Listo", "<p>Ya renovamos tu sesión del aula. Volvé al chat y pedile al agente que reintente.</p>"));
        });
    });

    app.post("/segundo-factor", sameOrigin, form, async (req, res) => {
        const id = String(req.body?.login ?? "");
        const utnLogin = secondFactors.get(id);
        if (!utnLogin) return void errorPage(res, 400, "Login vencido", "Pasó demasiado tiempo. Volvé a iniciar sesión.");
        utnLogin.flow.answer(String(req.body?.respuesta ?? ""));
        await advance(res, utnLogin, id);
    });

    /** Entra al aula con lo que mandó el formulario; si falla, vuelve a mostrarlo con el error. */
    async function login(req: Request, res: Response, list: Regional[], retry: Retry, finish: UtnLogin["finish"]) {
        if (!limiter.allow(req.ip ?? "desconocida")) {
            return retry(res, "Demasiados intentos. Esperá unos minutos y probá de nuevo.");
        }
        const username = String(req.body?.usuario ?? "").trim();
        const password = String(req.body?.contrasena ?? "");
        if (!username || !password) return retry(res, "Completá usuario y contraseña.");
        const regional = list.find((r) => r.id === String(req.body?.regional ?? ""));
        if (!regional) return retry(res, "Elegí tu regional de la lista.");
        if (regional.support === "unsupported") {
            return retry(res, `Todavía no hay soporte para ${regional.name}: su aula todavía no funciona con UTN-MCP.`);
        }
        const flow = new PendingLogin((secondFactor) => linkAulaAccount(store, regional, { username, password }, secondFactor));
        await advance(res, { flow, regional, username, retry, finish });
    }

    /**
     * Sigue el login hasta que termina o pide el segundo factor: entonces muestra la página para
     * contestarlo y lo guarda hasta la respuesta. `id` es el de un login que ya estaba esperando.
     */
    async function advance(res: Response, utnLogin: UtnLogin, id?: string) {
        const { flow, regional, username, retry, finish } = utnLogin;
        try {
            const step = await flow.next();
            if ("prompt" in step) {
                return void res.type("html").send(secondFactorPage(id ?? secondFactors.add(utnLogin), step.prompt));
            }
            if (id) secondFactors.take(id);
            await finish(res, step.done);
        } catch (e) {
            if (id) secondFactors.take(id);
            if (e instanceof InvalidCredentialsError) retry(res, "La UTN rechazó el usuario o la contraseña.");
            else if (e instanceof MfaError) retry(res, e.message);
            else if (regional.support === "candidate") {
                // Nadie la había usado acá: lo más probable es que todavía no ande, no que esté caída.
                logger.warn(`Regional ${regional.id} sin verificar, falló el login de ${username}: ${(e as Error).message}`);
                retry(res, `No pudimos usar el aula de ${regional.name}: puede que todavía no ande con UTN-MCP.`);
            } else {
                logger.error(`Login de ${username} (${regional.id}): ${(e as Error).message}`);
                retry(res, "No pudimos entrar al aula. Puede que esté caída: probá de nuevo en unos minutos.");
            }
        }
    }

    return getOAuthProtectedResourceMetadataUrl(new URL(resource));
}

async function issueTokens(store: SessionStore, userId: number, clientId: string) {
    const accessToken = await store.issueToken(userId, { kind: "access", clientId, ttlSeconds: ACCESS_TTL });
    const refreshToken = await store.issueToken(userId, { kind: "refresh", clientId, ttlSeconds: REFRESH_TTL });
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refreshToken };
}

const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Los endpoints que llaman los clientes desde el navegador (como el MCP Inspector) aceptan cualquier origen. */
export const cors: RequestHandler = (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
    );
    // Sin exponerlos, el navegador no deja leer el 401 que arranca el OAuth ni la sesión del transporte.
    res.setHeader("Access-Control-Expose-Headers", "www-authenticate, mcp-session-id");
    // Un día, en segundos: el navegador no repite el preflight en cada request.
    res.setHeader("Access-Control-Max-Age", "86400");
    next();
};

function redirectWith(res: Response, base: string, params: Record<string, string | undefined>) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    res.redirect(302, url.toString());
}

function oauthError(res: Response, status: number, error: string, description: string) {
    res.status(status).json({ error, error_description: description });
}

function errorPage(res: Response, status: number, title: string, message: string) {
    res.status(status).type("html").send(page(title, `<p>${escapeHtml(message)}</p>`));
}

function deniedPage(res: Response, reason: string, url?: string) {
    const link = url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : "";
    res.status(403).type("html").send(page("Sin acceso", `<p>${escapeHtml(reason)}</p>${link}`));
}

/** La página del segundo factor de Microsoft: elegir el método, tipear el código o avisar que ya se aprobó. */
function secondFactorPage(id: string, prompt: MfaPrompt): string {
    const hidden = `<input type="hidden" name="login" value="${escapeHtml(id)}">`;
    const formWith = (fields: string, button: string) =>
        `<form method="post" action="/segundo-factor">${hidden}${fields}<button type="submit">${button}</button></form>`;
    if (prompt.step === "choose") {
        const options = prompt.methods
            .map(
                (m, i) =>
                    `<label class=acepto><input type="radio" name="respuesta" value="${escapeHtml(m.id)}"${i === 0 ? " checked" : ""}>` +
                    `<span>${escapeHtml(m.label)}</span></label>`,
            )
            .join("");
        return page("Segundo factor", "<p>Tu cuenta de Microsoft pide un segundo factor. ¿Con cuál seguís?</p>" + formWith(options, "Seguir"));
    }
    if (prompt.step === "code") {
        const error = prompt.retry ? "<p class=error>El código no era correcto. Probá de nuevo.</p>" : "";
        const field =
            `<label>${escapeHtml(prompt.method.label)}<input name="respuesta" inputmode="numeric" ` +
            `autocomplete="one-time-code" autocapitalize="none" required></label>`;
        return page("Segundo factor", error + formWith(field, "Verificar"));
    }
    const number = prompt.number ? `<p>Cuando te lo pida, tocá este número:</p><p class=numero>${prompt.number}</p>` : "";
    return page(
        "Segundo factor",
        `<p>Aprobá el inicio de sesión en el celular (${escapeHtml(prompt.method.label)}).</p>` +
            number +
            formWith(`<input type="hidden" name="respuesta" value="ok">`, "Ya aprobé"),
    );
}

function loginPage(o: {
    action: string;
    regionals: Regional[];
    pendingId?: string;
    clientName?: string | null;
    redirectUri?: string;
    unknownRedirect?: boolean;
    /** La regional que había elegido, para no hacerla elegir de nuevo si hay que reintentar. */
    regional?: string;
    error?: string;
}): string {
    const where = o.redirectUri ? `<strong>${escapeHtml(describeRedirect(o.redirectUri))}</strong>` : "";
    const destination =
        where && !o.unknownRedirect ? ` Al terminar vas a volver a ${where}: si no es la app que estás conectando, no sigas.` : "";
    const warning = o.unknownRedirect
        ? `<div class=aviso><p><strong>Esta app no es un cliente conocido.</strong> Al terminar vas a volver a ${where}, ` +
          "y desde ahí van a poder usar tu aula en tu nombre: leer tus cursos y mensajes, entregar tareas y escribir " +
          "mensajes. Si alguien te pasó este link y no estás conectando un agente tuyo o de alguien en quien confiás, " +
          "no sigas: puede ser un intento de robarte la sesión.</p></div>"
        : "";
    const consent = o.unknownRedirect
        ? `<label class=acepto><input type="checkbox" name="acepto" value="si" required><span>Entiendo el riesgo y ` +
          `conecto esta app bajo mi responsabilidad. Quien administra este servidor no se hace responsable de lo que ` +
          `${where} haga con mi aula ni con mi sesión.</span></label>`
        : "";
    const intro = o.pendingId
        ? `<p>${escapeHtml(o.clientName ?? "Una app")} quiere usar UTN-MCP con tu Aula Virtual. Entrá con tu usuario de la UTN para conectarla.${destination}</p>`
        : "<p>Tu sesión del aula venció. Entrá con tu usuario de la UTN para renovarla.</p>";
    const error = o.error ? `<p class=error>${escapeHtml(o.error)}</p>` : "";
    const hidden = o.pendingId ? `<input type="hidden" name="pedido" value="${escapeHtml(o.pendingId)}">` : "";
    const selected = o.regional || defaultRegional().id;
    const option = (r: Regional) =>
        `<option value="${escapeHtml(r.id)}"${r.id === selected ? " selected" : ""}>${escapeHtml(r.name)}</option>`;
    const group = (label: string, support: Regional["support"]) => {
        const items = o.regionals.filter((r) => r.support === support);
        return items.length ? `<optgroup label="${escapeHtml(label)}">${items.map(option).join("")}</optgroup>` : "";
    };
    const options =
        group("Regionales", "verified") +
        group("Agregar mi regional (primera vez acá)", "candidate") +
        group("Todavía sin soporte", "unsupported");
    return page(
        "Entrar con la UTN",
        intro +
            warning +
            error +
            `<form method="post" action="${o.action}">${hidden}` +
            `<label>Regional<select name="regional" required>${options}</select></label>` +
            `<label>Usuario<input name="usuario" autocomplete="username" autocapitalize="none" required></label>` +
            `<label>Contraseña<input name="contrasena" type="password" autocomplete="current-password" required></label>` +
            consent +
            `<button type="submit">Entrar</button></form>` +
            "<p class=nota>La contraseña se usa una sola vez para entrar al aula y no se guarda. " +
            'El código es abierto: <a href="https://github.com/nialvape/utn-mcp">github.com/nialvape/utn-mcp</a>.</p>',
        o.pendingId ? "Conectar app · Aula Virtual" : "Renovar sesión · Aula Virtual",
    );
}
