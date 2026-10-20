import { randomInt } from "node:crypto";
import { CookieJar } from "tough-cookie";
import type { Credentials } from "./credentials.js";
import { UnsupportedRegionalError, type Regional } from "./regionals.js";
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

/**
 * Obtiene un token del web service. Dos estrategias según la regional:
 * - Regionales con SSO (Keycloak, ej. FRBA): flujo de launch.php, que usa la sesión del SSO. Si el
 *   SSO rechaza las credenciales, `login/token.php`: hay usuarios sin cuenta en el SSO.
 * - Regionales con login directo de Moodle (ej. FRT): primero `login/token.php` (no depende del
 *   plugin de mobile launch, que puede estar deshabilitado); si falla, flujo de launch.php.
 * Las cookies se usan solo durante el login y se descartan: las sesiones de Moodle y del SSO duran
 * horas y el token, semanas, así que no sirven para renovarlo.
 */
export async function fetchToken(regional: Regional, credentials: Credentials): Promise<string> {
    if (regional.support === "unsupported") throw new UnsupportedRegionalError(regional);
    const { baseUrl, ssoHost } = regional;
    const jar = new CookieJar();

    // Regionales con login directo: intentamos token.php primero (no depende de launch.php).
    if (!ssoHost) {
        const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
        if (viaTokenPhp) return viaTokenPhp;
    }

    const launchUrl =
        `${baseUrl}/admin/tool/mobile/launch.php` +
        `?service=moodle_mobile_app&passport=${randomInt(1e9)}&urlscheme=moodlemobile`;

    let landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;

    const oauthUrl = landing.html.match(/href="([^"]*\/auth\/oauth2\/login\.php[^"]*)"/)?.[1];
    if (oauthUrl) {
        landing = await follow(jar, decodeHtml(oauthUrl));
        if ("token" in landing) return landing.token;

        if (ssoHost && new URL(landing.url).host === ssoHost) {
            landing = await submitSsoForm(jar, landing.html, credentials);
            if ("token" in landing) return landing.token;
            if (ssoHost && new URL(landing.url).host === ssoHost) {
                // Aspirantes del ingreso y algunas tecnicaturas no tienen cuenta en el SSO: entran con el login de Moodle.
                const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
                if (viaTokenPhp) return viaTokenPhp;
                throw new InvalidCredentialsError(extractLoginError(landing.html));
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

    if (!ssoHost) {
        const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
        if (viaTokenPhp) return viaTokenPhp;
    }

    throw unexpected(landing.url);
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
    // El mismo servicio lo usa launch.php: si token.php lo rechaza, seguir no sirve.
    throw new MoodleError(
        `El aula no dio el token (${data.errorcode ?? res.status}): ${data.error ?? "respuesta sin token"}. ` +
            "Si dice que el servicio web no está disponible, lo tiene que habilitar el admin del aula.",
        data.errorcode,
    );
}

async function submitSsoForm(jar: CookieJar, html: string, { username, password }: Credentials): Promise<Landing> {
    const action = html.match(/"loginAction"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    if (!action) throw new Error("No se encontró el formulario del SSO; puede que haya cambiado.");

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
