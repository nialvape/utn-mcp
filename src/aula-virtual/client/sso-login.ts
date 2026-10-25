import { randomInt } from "node:crypto";
import { CookieJar } from "tough-cookie";
import type { Credentials } from "./credentials.js";
import { UnsupportedRegionalError, type Regional, type SsoProviderId } from "./regionals.js";
import { MoodleError } from "./moodle-api.js";

export class LoginRequiredError extends Error {
    constructor(message = "Hace falta iniciar sesión: corré `utn-mcp login`.") {
        super(message);
        this.name = "LoginRequiredError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor(reason?: string) {
        const base = "El aula rechazó usuario o contraseña. Corré `utn-mcp login` para actualizarlos.";
        super(reason ? `${base} Motivo del aula: ${reason}` : base);
        this.name = "InvalidCredentialsError";
    }
}

const MAX_REDIRECTS = 20;
const TIMEOUT_MS = 30_000;

type Landing = { token: string } | { url: string; html: string };
type Page = Extract<Landing, { url: string }>;

/** Lo que cambia de un SSO a otro; el recorrido (aula → SSO → aula → token) es el mismo. */
interface SsoProvider {
    /** El botón de la página de login de Moodle que lleva al SSO. */
    link: RegExp;
    /** Manda usuario y contraseña al formulario del SSO. Si los rechaza, la página queda en el SSO. */
    submit(jar: CookieJar, page: Page, credentials: Credentials): Promise<Landing>;
    /** El motivo del rechazo que muestra el SSO. */
    loginError(html: string): string | undefined;
}

const PROVIDERS: Record<SsoProviderId, SsoProvider> = {
    keycloak: {
        link: /href="([^"]*\/auth\/oauth2\/login\.php[^"]*)"/,
        submit: submitKeycloakForm,
        loginError: extractLoginError,
    },
    microsoft: {
        link: /href="([^"]*\/auth\/oidc\/[^"]*)"/,
        submit: submitMicrosoftForm,
        loginError: microsoftLoginError,
    },
};

/**
 * Obtiene un token del web service. Dos estrategias según la regional:
 * - Regionales con SSO (Keycloak como FRBA, Office 365 como FRH): flujo de launch.php, que usa la
 *   sesión del SSO. Si el SSO rechaza las credenciales, `login/token.php`: hay usuarios sin cuenta en
 *   el SSO.
 * - Regionales con login directo de Moodle (ej. FRT): primero `login/token.php` (no depende del
 *   plugin de mobile launch, que puede estar deshabilitado); si falla, flujo de launch.php.
 * Las cookies se usan solo durante el login y se descartan: las sesiones de Moodle y del SSO duran
 * horas y el token, semanas, así que no sirven para renovarlo.
 */
export async function fetchToken(regional: Regional, credentials: Credentials): Promise<string> {
    if (regional.support === "unsupported") throw new UnsupportedRegionalError(regional);
    const { baseUrl, sso } = regional;
    const jar = new CookieJar();

    // Regionales con login directo: intentamos token.php primero (no depende de launch.php).
    if (!sso) {
        const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
        if (viaTokenPhp) return viaTokenPhp;
    }

    const launchUrl =
        `${baseUrl}/admin/tool/mobile/launch.php` +
        `?service=moodle_mobile_app&passport=${randomInt(1e9)}&urlscheme=moodlemobile`;

    let landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;

    const provider = sso && PROVIDERS[sso.provider];
    const ssoHref = provider && landing.html.match(provider.link)?.[1];
    if (sso && provider && ssoHref) {
        landing = await follow(jar, new URL(decodeHtml(ssoHref), landing.url).toString());
        if ("token" in landing) return landing.token;

        if (new URL(landing.url).host === sso.host) {
            landing = await provider.submit(jar, landing, credentials);
            if ("token" in landing) return landing.token;
            if (new URL(landing.url).host === sso.host) {
                // Aspirantes del ingreso y algunas tecnicaturas no tienen cuenta en el SSO: entran con el login de Moodle.
                const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
                if (viaTokenPhp) return viaTokenPhp;
                throw new InvalidCredentialsError(provider.loginError(landing.html));
            }
        }
    } else {
        const loginPageUrl = `${baseUrl}/login/index.php`;
        const loginPage = await follow(jar, loginPageUrl);
        if ("token" in loginPage) return loginPage.token;
        landing = await submitMoodleLoginForm(jar, loginPage.url, loginPage.html, credentials);
        if ("token" in landing) return landing.token;
        const stillOnLogin =
            landing.url.includes("/login") ||
            /alert-danger/i.test(landing.html) ||
            /loginerrors/i.test(landing.html);
        if (stillOnLogin) {
            const reason = extractLoginError(landing.html);
            throw new InvalidCredentialsError(reason);
        }
    }

    landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;

    if (!sso) {
        const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
        if (viaTokenPhp) return viaTokenPhp;
    }

    throw unexpected(landing.url);
}

export class MfaRequiredError extends Error {
    constructor(reason?: string) {
        super(
            "Tu cuenta de Microsoft pide un segundo factor (código, app o similar), que UTN-MCP todavía no puede " +
                "completar solo." + (reason ? ` Microsoft dijo: ${reason}` : ""),
        );
        this.name = "MfaRequiredError";
    }
}

/** El `$Config` de las páginas de login de Microsoft: los campos que necesita el flujo. */
interface AadConfig {
    sFT?: string;
    sCtx?: string;
    canary?: string;
    urlPost?: string;
    sErrorCode?: string;
    strServiceExceptionMessage?: string;
    arrUserProofs?: unknown[];
}

/** Cantidad máxima de pasos de Microsoft entre la contraseña y la vuelta al aula (KMSI y similares). */
const MAX_MICROSOFT_STEPS = 6;

/**
 * Formulario de Office 365 (Microsoft Entra ID). No es un `<form>`: los datos están en el `$Config` de
 * la página. Después de la contraseña puede venir "¿Mantener la sesión iniciada?" antes del formulario
 * que vuelve al aula con el `code`. No completa MFA ni logins federados (ADFS).
 */
async function submitMicrosoftForm(jar: CookieJar, page: Page, { username, password }: Credentials): Promise<Landing> {
    const ssoHost = new URL(page.url).host;
    const cfg = parseAadConfig(page.html);
    if (!cfg?.urlPost || !cfg.sFT) {
        throw new Error("No se encontró el formulario de Microsoft; puede que haya cambiado o que el login sea federado.");
    }
    let landing = await follow(jar, new URL(cfg.urlPost, page.url).toString(), {
        method: "POST",
        body: new URLSearchParams({
            login: username,
            loginfmt: username,
            passwd: password,
            type: "11",
            LoginOptions: "3",
            flowToken: cfg.sFT,
            ctx: cfg.sCtx ?? "",
            canary: cfg.canary ?? "",
            i13: "0",
            ps: "2",
        }),
    });

    for (let i = 0; i < MAX_MICROSOFT_STEPS; i++) {
        if ("token" in landing) return landing;
        const form = findPostForm(landing.html);
        const action = form && new URL(form.action, landing.url).toString();
        if (form && action && new URL(action).host !== ssoHost) {
            return follow(jar, action, { method: "POST", body: new URLSearchParams(form.inputs) });
        }

        const step = parseAadConfig(landing.html);
        if (step?.arrUserProofs?.length) throw new MfaRequiredError(step.strServiceExceptionMessage);
        if (step?.sErrorCode) return landing;
        if (step?.urlPost) {
            landing = await follow(jar, new URL(step.urlPost, landing.url).toString(), {
                method: "POST",
                body: new URLSearchParams({
                    LoginOptions: "1",
                    type: "28",
                    ctx: step.sCtx ?? "",
                    flowToken: step.sFT ?? "",
                    canary: step.canary ?? "",
                }),
            });
            continue;
        }
        if (form && action) {
            landing = await follow(jar, action, { method: "POST", body: new URLSearchParams(form.inputs) });
            continue;
        }
        throw unexpected(landing.url);
    }
    throw new Error("Demasiados pasos en el login de Microsoft.");
}

/** El motivo del rechazo en una página de Microsoft (ej. AADSTS50126: usuario o contraseña incorrectos). */
function microsoftLoginError(html: string): string | undefined {
    const cfg = parseAadConfig(html);
    if (!cfg?.sErrorCode) return undefined;
    return cfg.strServiceExceptionMessage || `AADSTS${cfg.sErrorCode}`;
}

/**
 * Extrae el objeto `$Config={...}` que Microsoft embebe en sus páginas de login, recorriendo las
 * llaves a mano (el objeto es grande y una regex no lo acota bien). Devuelve null si no está.
 */
function parseAadConfig(html: string): AadConfig | null {
    const at = html.indexOf("$Config=");
    if (at < 0) return null;
    const start = html.indexOf("{", at);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
            try {
                return JSON.parse(html.slice(start, i + 1)) as AadConfig;
            } catch {
                return null;
            }
        }
    }
    return null;
}

/** El primer `<form method="post">` de la página: su `action` y sus inputs ocultos. */
function findPostForm(html: string): { action: string; inputs: Record<string, string> } | null {
    const m = html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/i);
    if (!m || !/method\s*=\s*["']?post/i.test(m[0])) return null;
    const action = m[0].match(/action\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!action) return null;
    const inputs: Record<string, string> = {};
    for (const input of m[1].matchAll(/<input\b[^>]*>/gi)) {
        const name = input[0].match(/name\s*=\s*["']([^"']*)["']/i)?.[1];
        if (name) inputs[name] = decodeHtml(input[0].match(/value\s*=\s*["']([^"']*)["']/i)?.[1] ?? "");
    }
    return { action: decodeHtml(action), inputs };
}

/**
 * Pide el token a /login/token.php (Moodle estándar). Devuelve null si el aula no lo expone
 * (no contesta JSON), para seguir con launch.php; si contesta con un error, lo propaga.
 */
async function tryTokenPhp(baseUrl: string, credentials: Credentials): Promise<string | null> {
    const res = await fetch(`${baseUrl}/login/token.php`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            username: credentials.username,
            password: credentials.password,
            service: "moodle_mobile_app",
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data: { token?: string; error?: string; errorcode?: string };
    try {
        data = await res.json();
    } catch {
        return null;
    }
    if (data.token) return data.token;
    if (data.errorcode === "invalidlogin" || /invalid login/i.test(data.error ?? "")) {
        throw new InvalidCredentialsError(data.error);
    }
    // Hay aulas (ej. la TUP) a las que se les rompe un plugin de autenticación con cada login
    // rechazado: contestan `generalexceptionmessage`, y el formulario web muestra la misma excepción.
    if (data.errorcode === "generalexceptionmessage") {
        throw new InvalidCredentialsError(
            `${data.error} (es un error interno del aula, que en algunas aparece cuando el usuario o la contraseña están mal)`,
        );
    }
    // El mismo servicio lo usa launch.php: si token.php lo rechaza, seguir no sirve.
    throw new MoodleError(
        `El aula no dio el token (${data.errorcode ?? res.status}): ${data.error ?? "respuesta sin token"}. ` +
            "Si dice que el servicio web no está disponible, lo tiene que habilitar el admin del aula.",
        data.errorcode,
    );
}

/** Formulario de Keycloak: el `action` viene en el `loginAction` del JSON que arma la página. */
async function submitKeycloakForm(jar: CookieJar, { html }: Page, { username, password }: Credentials): Promise<Landing> {
    const action = html.match(/"loginAction"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    if (!action) throw new Error("No se encontró el formulario de Keycloak; puede que haya cambiado.");

    const body = new URLSearchParams({ username, password, rememberMe: "on", credentialId: "" });
    return follow(jar, JSON.parse(action) as string, { method: "POST", body });
}

/** Login directo de Moodle (sin SSO): manda usuario y contraseña al formulario de /login/index.php. */
async function submitMoodleLoginForm(
    jar: CookieJar,
    pageUrl: string,
    html: string,
    { username, password }: Credentials,
): Promise<Landing> {
    const tokenMatch =
        html.match(/name="logintoken"\s+value="([^"]*)"/) ||
        html.match(/value="([^"]*)"\s+name="logintoken"/);
    const logintoken = tokenMatch?.[1] ?? "";

    const actionMatch = html.match(/<form[^>]*action="([^"]*)"[^>]*>/i);
    let action = actionMatch?.[1] ? decodeHtml(actionMatch[1]) : "";
    if (!action) action = pageUrl;
    if (!action.startsWith("http")) action = new URL(action, pageUrl).toString();

    const body = new URLSearchParams({ username, password, logintoken, anchor: "" });
    return follow(jar, action, { method: "POST", body });
}

/** Hace la request y sigue redirecciones a mano, guardando cookies en cada salto. */
async function follow(jar: CookieJar, url: string, init?: RequestInit): Promise<Landing> {
    for (let i = 0; i < MAX_REDIRECTS; i++) {
        const cookie = await jar.getCookieString(url);
        const res = await fetch(url, {
            ...init,
            redirect: "manual",
            headers: cookie ? { cookie } : {},
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        for (const setCookie of res.headers.getSetCookie()) {
            await jar.setCookie(setCookie, url, { ignoreError: true });
        }

        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
            await res.body?.cancel();
            if (location.startsWith("moodlemobile://")) return { token: decodeLaunchToken(location) };
            url = new URL(location, url).toString();
            init = undefined; // tras un redirect, siempre GET
            continue;
        }
        return { url, html: await res.text() };
    }
    throw new Error("Demasiadas redirecciones en el login.");
}

/** moodlemobile://token=BASE64(siteid:::token[:::privatetoken]) → token */
export function decodeLaunchToken(url: string): string {
    const encoded = decodeURIComponent(url.split("token=")[1] ?? "");
    const parts = Buffer.from(encoded, "base64").toString("utf8").split(":::");
    if (parts.length < 2 || !parts[1]) throw new Error("Formato de token inesperado en launch.php");
    return parts[1];
}

const decodeHtml = (s: string) => s.replaceAll("&amp;", "&");

/** Extrae el mensaje de error que muestra Moodle/Keycloak en la página de login. */
function extractLoginError(html: string): string | undefined {
    const patterns = [
        /alert-danger[^>]*>([\s\S]*?)<\/div>/i,
        /alert-error[^>]*>([\s\S]*?)<\/div>/i,
        /class="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*id="loginerrormessage"[^>]*>([\s\S]*?)<\/div>/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]) {
            const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (text) return text;
        }
    }
    return undefined;
}

const unexpected = (url: string) => {
    const { host, pathname } = new URL(url);
    return new Error(`Flujo de login inesperado: terminó en ${host}${pathname}`);
};
