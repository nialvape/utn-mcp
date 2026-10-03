import { randomInt } from "node:crypto";
import type { CookieJar } from "tough-cookie";
import type { Credentials } from "./credentials.js";
import { AULA_BASE_URL, SSO_HOST } from "./constants.js";

export class LoginRequiredError extends Error {
    constructor(message = "Hace falta iniciar sesión: corré `utn-mcp login`.") {
        super(message);
        this.name = "LoginRequiredError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor() {
        super("El SSO rechazó usuario o contraseña. Corré `utn-mcp login` para actualizarlos.");
        this.name = "InvalidCredentialsError";
    }
}

const MAX_REDIRECTS = 20;
const TIMEOUT_MS = 30_000;

type Landing = { token: string } | { url: string; html: string };

/**
 * Obtiene un token del web service siguiendo el flujo de launch.php por HTTP:
 * launch.php → login de Moodle → SSO (Keycloak) → Moodle → launch.php → moodlemobile://token=BASE64.
 * Las cookies del SSO quedan en `jar`: mientras sigan vivas no hace falta la contraseña.
 */
export async function fetchToken(jar: CookieJar, credentials: Credentials | null): Promise<string> {
    const launchUrl =
        `${AULA_BASE_URL}/admin/tool/mobile/launch.php` +
        `?service=moodle_mobile_app&passport=${randomInt(1e9)}&urlscheme=moodlemobile`;

    // 1. Con sesión de Moodle viva, launch.php redirige directo al token.
    let landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;

    // 2. Login de Moodle: el botón "Usuarios Institucionales" lleva al SSO.
    const oauthUrl = landing.html.match(/href="([^"]*\/auth\/oauth2\/login\.php[^"]*)"/)?.[1];
    if (!oauthUrl) throw unexpected(landing.url);
    landing = await follow(jar, decodeHtml(oauthUrl));
    if ("token" in landing) return landing.token;

    // 3. Si el SSO no nos recuerda, muestra su formulario: lo completamos.
    if (new URL(landing.url).host === SSO_HOST) {
        if (!credentials) throw new LoginRequiredError();
        landing = await submitSsoForm(jar, landing.html, credentials);
        if ("token" in landing) return landing.token;
        if (new URL(landing.url).host === SSO_HOST) throw new InvalidCredentialsError();
    }

    // 4. Ya con sesión de Moodle (el SSO nos deja en el dashboard), pedimos el token de nuevo.
    landing = await follow(jar, launchUrl);
    if ("token" in landing) return landing.token;
    throw unexpected(landing.url);
}

async function submitSsoForm(jar: CookieJar, html: string, { username, password }: Credentials): Promise<Landing> {
    // La página de Keycloak trae su config como JSON (kcContext); de ahí sale la URL del form.
    const action = html.match(/"loginAction"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1];
    if (!action) throw new Error("No se encontró el formulario del SSO; puede que haya cambiado.");

    const body = new URLSearchParams({ username, password, rememberMe: "on", credentialId: "" });
    return follow(jar, JSON.parse(action) as string, { method: "POST", body });
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

const unexpected = (url: string) => {
    const { host, pathname } = new URL(url);
    return new Error(`Flujo de login inesperado: terminó en ${host}${pathname}`);
};
