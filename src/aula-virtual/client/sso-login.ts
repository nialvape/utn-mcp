import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
    submit(jar: CookieJar, page: Page, credentials: Credentials, secondFactor?: SecondFactor): Promise<Landing>;
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
 * `secondFactor` contesta el MFA de Microsoft; sin él (las renovaciones solas), una cuenta con MFA da
 * `MfaRequiredError`.
 */
export async function fetchToken(regional: Regional, credentials: Credentials, secondFactor?: SecondFactor): Promise<string> {
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

    const ssoProvider = sso ? PROVIDERS[sso.provider] : undefined;
    const ssoHref = ssoProvider && landing.html.match(ssoProvider.link)?.[1];
    if (sso && ssoProvider && ssoHref) {
        landing = await follow(jar, new URL(decodeHtml(ssoHref), landing.url).toString());
        if ("token" in landing) return landing.token;

        if (new URL(landing.url).host === sso.host) {
            landing = await ssoProvider.submit(jar, landing, credentials, secondFactor);
            if ("token" in landing) return landing.token;
            if (new URL(landing.url).host === sso.host) {
                // Aspirantes del ingreso y algunas tecnicaturas no tienen cuenta en el SSO: entran con el login de Moodle.
                const viaTokenPhp = await tryTokenPhp(baseUrl, credentials);
                if (viaTokenPhp) return viaTokenPhp;
                throw new InvalidCredentialsError(ssoProvider.loginError(landing.html));
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

/** La cuenta pide MFA y no hay quién lo conteste: pasa al renovar solo, sin el usuario delante. */
export class MfaRequiredError extends LoginRequiredError {
    constructor() {
        super(
            "Tu cuenta de Microsoft pide un segundo factor (MFA), que solo se completa al iniciar sesión: " +
                "corré `utn-mcp login`.",
        );
        this.name = "MfaRequiredError";
    }
}

/** El segundo factor no se pudo completar; el mensaje dice por qué y se le puede mostrar al usuario. */
export class MfaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MfaError";
    }
}

/** Un método de segundo factor de la cuenta de Microsoft que sabemos completar. */
export interface MfaMethod {
    /** El `authMethodId` de Microsoft (ej. `PhoneAppNotification`, `OneWaySMS`). */
    id: string;
    /** "approve": se aprueba en el celular (notificación o llamada); "code": se tipea un código. */
    kind: "approve" | "code";
    /** Para mostrarle al usuario, con el teléfono enmascarado si Microsoft lo da (ej. "Código por SMS · +XX XXXXXXXX12"). */
    label: string;
}

/** Lo que el login le pregunta al usuario para completar el segundo factor. */
export type MfaPrompt =
    | { step: "choose"; methods: MfaMethod[] }
    | { step: "code"; method: MfaMethod; retry: boolean }
    /** `number` es el que Authenticator pide tipear al aprobar, si lo pide. */
    | { step: "approve"; method: MfaMethod; number?: number };

/**
 * Quien contesta el segundo factor: el CLI o la página de login del servidor. Con "choose" devuelve el
 * `id` del método; con "code", el código; con "approve", cualquier cosa cuando el usuario ya aprobó.
 */
export type SecondFactor = (prompt: MfaPrompt) => Promise<string>;

/** Los `authMethodId` que se completan sin navegador: los demás (FIDO, Windows Hello) necesitan uno. */
const MFA_METHODS: Record<string, { kind: MfaMethod["kind"]; label: string }> = {
    PhoneAppNotification: { kind: "approve", label: "Notificación de Microsoft Authenticator" },
    CompanionAppsNotification: { kind: "approve", label: "Notificación de Microsoft Authenticator" },
    PhoneAppOTP: { kind: "code", label: "Código de Microsoft Authenticator" },
    OneWaySMS: { kind: "code", label: "Código por SMS" },
    TwoWayVoiceMobile: { kind: "approve", label: "Llamada al celular" },
    TwoWayVoiceAlternateMobile: { kind: "approve", label: "Llamada al celular alternativo" },
    TwoWayVoiceOffice: { kind: "approve", label: "Llamada al teléfono de la oficina" },
};

/** Intentos de código antes de cortar: Microsoft también bloquea después de varios. */
const MAX_CODE_ATTEMPTS = 3;
/** Cada cuánto se pregunta si ya se aprobó, en milisegundos, y cuántas veces (un minuto en total). */
const APPROVE_POLL_MS = 2_000;
const APPROVE_POLLS = 30;

/** El `$Config` de las páginas de login de Microsoft: los campos que necesita el flujo. */
interface AadConfig {
    sFT?: string;
    sCtx?: string;
    canary?: string;
    urlPost?: string;
    sErrorCode?: string;
    strServiceExceptionMessage?: string;
    /** Los métodos de MFA de la cuenta: aparecen en la página que pide el segundo factor. */
    arrUserProofs?: { authMethodId?: string; display?: string; isDefault?: boolean }[];
    urlBeginAuth?: string;
    urlEndAuth?: string;
}

/** Respuesta de `SAS/BeginAuth` y `SAS/EndAuth`, los endpoints JSON del segundo factor. */
interface SasResponse {
    Success?: boolean;
    ResultValue?: string;
    Message?: string;
    SessionId?: string;
    FlowToken?: string;
    Ctx?: string;
    /** El número que Authenticator pide tipear; 0 si no pide. */
    Entropy?: number;
}

/** Cantidad máxima de pasos de Microsoft entre la contraseña y la vuelta al aula (MFA, KMSI y similares). */
const MAX_MICROSOFT_STEPS = 8;

/**
 * Formulario de Office 365 (Microsoft Entra ID). No es un `<form>`: los datos están en el `$Config` de
 * la página. Después de la contraseña pueden venir el segundo factor y "¿Mantener la sesión iniciada?"
 * antes del formulario que vuelve al aula con el `code`. No completa logins federados (ADFS).
 */
async function submitMicrosoftForm(
    jar: CookieJar,
    page: Page,
    { username, password }: Credentials,
    secondFactor?: SecondFactor,
): Promise<Landing> {
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
        if (step?.arrUserProofs?.length) {
            if (!secondFactor) throw new MfaRequiredError();
            landing = await completeMfa(jar, landing, step, username, secondFactor);
            continue;
        }
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

/**
 * El segundo factor de Microsoft, con los mismos endpoints que usa su página: `BeginAuth` lo arranca
 * (manda la notificación, el SMS o la llamada), `EndAuth` lo verifica (con el código, o preguntando si
 * ya se aprobó) y `ProcessAuth` sigue el login, que vuelve a la página siguiente (KMSI o el aula).
 */
async function completeMfa(
    jar: CookieJar,
    page: Page,
    cfg: AadConfig,
    username: string,
    secondFactor: SecondFactor,
): Promise<Landing> {
    const proofs = cfg.arrUserProofs ?? [];
    const methods = proofs.flatMap(({ authMethodId: id, display }): MfaMethod[] => {
        const known = id ? MFA_METHODS[id] : undefined;
        return id && known ? [{ id, kind: known.kind, label: display ? `${known.label} · ${display}` : known.label }] : [];
    });
    if (!methods.length) {
        const ids = proofs.map((p) => p.authMethodId).join(", ");
        throw new MfaError(
            `Tu cuenta de Microsoft solo tiene métodos de segundo factor que necesitan el navegador (${ids}). ` +
                "Agregá Microsoft Authenticator o un teléfono en https://mysignins.microsoft.com/security-info y volvé a intentar.",
        );
    }
    if (!cfg.urlBeginAuth || !cfg.urlEndAuth || !cfg.urlPost) {
        throw new Error("No se encontró el formulario del segundo factor de Microsoft; puede que haya cambiado.");
    }

    const preferred = proofs.find((p) => p.isDefault)?.authMethodId;
    methods.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    const chosenId = methods.length > 1 ? await secondFactor({ step: "choose", methods }) : methods[0].id;
    const method = methods.find((m) => m.id === chosenId);
    if (!method) throw new MfaError("Ese método de segundo factor no está entre los de tu cuenta.");

    const sasUrl = (url: string) => new URL(url, page.url).toString();
    const begin = await postSas(jar, sasUrl(cfg.urlBeginAuth), {
        AuthMethodId: method.id,
        Method: "BeginAuth",
        ctx: cfg.sCtx ?? "",
        flowToken: cfg.sFT ?? "",
    });
    if (!begin.Success) throw new MfaError(`Microsoft no pudo arrancar el segundo factor (${begin.Message || begin.ResultValue}).`);

    const endAuth = (extra: Record<string, unknown>) =>
        postSas(jar, sasUrl(cfg.urlEndAuth!), {
            Method: "EndAuth",
            AuthMethodId: method.id,
            SessionId: begin.SessionId,
            FlowToken: begin.FlowToken,
            Ctx: begin.Ctx,
            ...extra,
        });

    let end: SasResponse | undefined;
    let otc = "";
    if (method.kind === "code") {
        for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !end?.Success; attempt++) {
            otc = (await secondFactor({ step: "code", method, retry: attempt > 0 })).replace(/\s/g, "");
            end = await endAuth({ AdditionalAuthData: otc, PollCount: 1 });
            if (!end.Success && !/incorrect|wrongcode/i.test(end.ResultValue ?? "")) break;
        }
    } else {
        await secondFactor({ step: "approve", method, number: begin.Entropy || undefined });
        for (let poll = 1; poll <= APPROVE_POLLS; poll++) {
            end = await endAuth({ PollCount: poll });
            if (end.Success || end.ResultValue !== "AuthenticationPending") break;
            await sleep(APPROVE_POLL_MS);
        }
    }
    if (!end?.Success) {
        const reason = end?.ResultValue === "AuthenticationPending" ? "no llegó la aprobación a tiempo" : end?.Message || end?.ResultValue;
        throw new MfaError(`Microsoft no aceptó el segundo factor (${reason}). Volvé a iniciar sesión para probar de nuevo.`);
    }

    return follow(jar, sasUrl(cfg.urlPost), {
        method: "POST",
        body: new URLSearchParams({
            request: end.Ctx ?? begin.Ctx ?? "",
            mfaAuthMethod: method.id,
            flowToken: end.FlowToken ?? begin.FlowToken ?? "",
            canary: cfg.canary ?? "",
            otc,
            login: username,
            hideSmsInMfaProofs: "false",
        }),
    });
}

/** POST JSON a `SAS/BeginAuth` o `SAS/EndAuth`, con las cookies del login. */
async function postSas(jar: CookieJar, url: string, body: Record<string, unknown>): Promise<SasResponse> {
    const cookie = await jar.getCookieString(url);
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    for (const setCookie of res.headers.getSetCookie()) {
        await jar.setCookie(setCookie, url, { ignoreError: true });
    }
    try {
        return (await res.json()) as SasResponse;
    } catch {
        throw new Error(`Respuesta inesperada del segundo factor de Microsoft (${res.status}).`);
    }
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
