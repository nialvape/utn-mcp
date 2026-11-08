import type {
    AutogestionConnector,
    AutogestionCredentials,
    CertificadoAutogestion,
    CertificadoDescargado,
    ConnectorKit,
    Correlatividades,
    EstadoMateria,
    ExamenMateria,
    NotasParcialesMateria,
} from "utn-mcp/autogestion";
import { findLoginForm } from "./login-form.js";
import { parseCorrelatividadesPagina } from "./pages/correlatividades.js";
import { parseEstadoAcademico } from "./pages/estado-academico.js";
import { parseExamenes } from "./pages/examenes.js";
import { normalizarMateria, parseNotasParciales } from "./pages/notas-parciales.js";
import type { AspRegional } from "./regionals.js";

const SYSTEM_NAME = "Sysacad";

/** Límite del formulario: `maxlength="12"` en el campo de la clave de todas las regionales relevadas. */
const DEFAULT_PASSWORD_MAX_LENGTH = 12;

/** Redirecciones que se siguen a mano para no perder las cookies que setea cada salto. */
const MAX_REDIRECTS = 5;

/**
 * Credenciales rechazadas: SysacadWEB avisa con un elemento de clase `textoError` en el cuerpo.
 * El nombre de la clase también aparece en el <style> de todas las páginas, así que se busca después
 * de sacar los bloques <style> (oct 2026: en FRT un login exitoso "rechazaba" por esto).
 */
const LOGIN_ERROR_PATTERN = /class\s*=\s*["']?textoError/i;

/**
 * En algunas regionales la sesión viaja también en la URL: `menuAlumno_FRT.asp?id=30043-986741068`.
 * Acompaña a la cookie ASPSESSIONID, no la reemplaza: sin cookie las páginas internas vuelven al login
 * (verificado con cuenta real de FRT, oct 2026).
 */
const SESSION_ID_PATTERN = /[?&]id=(\d+-\d+)/;

const MAX_CERTIFICADO_BYTES = 20 * 1024 * 1024;

interface Page {
    url: string;
    html: string;
}

/** Lo que guarda `exportSession`: todo menos la contraseña. */
interface StoredSession {
    cookies: [string, string][];
    sessionId: string | null;
    menu: Page;
}

/**
 * Conector del SysacadWEB clásico (ASP), el mismo producto en casi todas las regionales. Las páginas
 * detrás del login no son públicas: en vez de adivinar sus nombres, se siguen los enlaces del menú
 * por su texto, que el menú anuncia con el href ya resuelto.
 */
export class SysacadAspConnector implements AutogestionConnector {
    readonly systemId = "sysacad-asp";

    private credentials: AutogestionCredentials | null = null;
    /** Cookies de la sesión ASP, por nombre: `ASPSESSIONID<8 letras>` cambia de nombre con el proceso de IIS. */
    private readonly cookies = new Map<string, string>();
    private sessionId: string | null = null;
    private menu: Page | null = null;

    constructor(
        private readonly regional: AspRegional,
        private readonly kit: ConnectorKit,
    ) {}

    async login(credentials: AutogestionCredentials): Promise<void> {
        const maxLength = this.regional.passwordMaxLength ?? DEFAULT_PASSWORD_MAX_LENGTH;
        if (credentials.password.length > maxLength) {
            throw new this.kit.HttpError(
                `La contraseña de Sysacad de tu regional tiene ${maxLength} caracteres como máximo y la tuya tiene ` +
                    `${credentials.password.length}: Sysacad la cortaría sin avisar. Revisala con \`utn-mcp login autogestion\`.`,
            );
        }
        this.cookies.clear();
        this.sessionId = null;
        this.menu = null;

        const loginPage = await this.request(new URL(this.regional.loginUrl));
        const form = findLoginForm(loginPage.html, loginPage.url);
        if (!form) {
            throw new this.kit.HttpError(
                `${new URL(loginPage.url).host} no mostró el formulario de ingreso de alumnos: cambió la pantalla de login.`,
            );
        }
        if (form.action.origin !== new URL(loginPage.url).origin) {
            // La clave solo se manda al mismo sitio que sirvió el formulario.
            throw new this.kit.HttpError(`El formulario de Sysacad postea a ${form.action.host}, otro sitio: no se manda la clave.`);
        }
        const body = new URLSearchParams(form.fields);
        body.set("legajo", credentials.username);
        body.set("password", credentials.password);
        const page = await this.request(form.action, body);

        const withoutStyles = page.html.replace(/<style[\s\S]*?<\/style>/gi, "");
        // Un rechazo vuelve a mostrar el formulario, a veces con un `textoError` ("ERROR: ...") y a veces sin nada.
        if (findLoginForm(page.html, page.url) || LOGIN_ERROR_PATTERN.test(withoutStyles)) {
            // Solo un rechazo invalida las credenciales guardadas: tras un timeout siguen sirviendo para el re-login.
            this.credentials = null;
            throw new this.kit.InvalidCredentialsError(SYSTEM_NAME);
        }
        if (/VBScript runtime error/i.test(page.html)) {
            throw new this.kit.HttpError("Sysacad respondió con un error interno (VBScript): probá de nuevo en un rato.");
        }
        this.credentials = credentials;
        this.sessionId = SESSION_ID_PATTERN.exec(page.html)?.[1] ?? null;
        this.menu = page;
    }

    /** Cookies, id y menú: de él salen los enlaces a las páginas internas, así que no hace falta volver a pedirlo. */
    exportSession(): string {
        if (!this.menu) throw new this.kit.LoginRequiredError(SYSTEM_NAME);
        const data: StoredSession = { cookies: [...this.cookies], sessionId: this.sessionId, menu: this.menu };
        return JSON.stringify(data);
    }

    restoreSession(raw: string): void {
        const data = JSON.parse(raw) as StoredSession;
        this.credentials = null;
        this.cookies.clear();
        for (const [name, value] of data.cookies) this.cookies.set(name, value);
        this.sessionId = data.sessionId;
        this.menu = data.menu;
    }

    async estadoAcademico(): Promise<EstadoMateria[]> {
        return this.kit.withRetry(() => this.readEstadoAcademico(), { operation: "sysacad estadoAcademico" });
    }

    async correlatividades(): Promise<Correlatividades> {
        return this.kit.withRetry(() => this.readCorrelatividades(), { operation: "sysacad correlatividades" });
    }

    async notasParciales(): Promise<NotasParcialesMateria[]> {
        return this.kit.withRetry(() => this.readNotasParciales(), { operation: "sysacad notasParciales" });
    }

    async examenes(): Promise<ExamenMateria[]> {
        return this.kit.withRetry(() => this.readExamenes(), { operation: "sysacad examenes" });
    }

    private async readEstadoAcademico(): Promise<EstadoMateria[]> {
        const materias = parseEstadoAcademico(this.kit, await this.fetchEstadoAcademico());
        const cursando = new Set(
            parseNotasParciales(this.kit, await this.fetchNotasParciales())
                .filter((m) => m.cursando)
                .map((m) => normalizarMateria(m.materia)),
        );
        for (const entry of materias) {
            if (cursando.has(normalizarMateria(entry.materia))) entry.estado = "Cursando";
        }
        return materias;
    }

    private async readCorrelatividades(): Promise<Correlatividades> {
        return {
            cursar: parseCorrelatividadesPagina(this.kit, await this.fetchCorrelatividades(), "cursar"),
            rendir: parseCorrelatividadesPagina(this.kit, await this.fetchCorrelatividadesExamen(), "rendir"),
        };
    }

    private async readNotasParciales(): Promise<NotasParcialesMateria[]> {
        return parseNotasParciales(this.kit, await this.fetchNotasParciales());
    }

    private async readExamenes(): Promise<ExamenMateria[]> {
        return parseExamenes(this.kit, await this.fetchExamenes());
    }

    async certificados(): Promise<CertificadoAutogestion[]> {
        return this.kit.withRetry(() => this.readCertificados(), { operation: "sysacad certificados" });
    }

    private async readCertificados(): Promise<CertificadoAutogestion[]> {
        const html = await this.fetchLinkedPage(/descarga\s*de\s*certificados/i, "descarga de certificados");
        const certificados: CertificadoAutogestion[] = [];
        const visible = html.replace(/<!--[\s\S]*?-->/g, "");
        for (const [, href, textoEnlace] of visible.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const nombre = this.kit.htmlToText(textoEnlace);
            if (!nombre || /^\s*javascript:/i.test(href) || /menuAlumno/i.test(href)) continue;
            certificados.push({ nombre, referencia: href });
        }
        return certificados;
    }

    async descargarCertificado(referencia: string): Promise<CertificadoDescargado> {
        return this.kit.withRetry(() => this.readCertificado(referencia), { operation: "sysacad descargarCertificado" });
    }

    private async readCertificado(referencia: string): Promise<CertificadoDescargado> {
        return this.withReLogin(() => this.fetchBinary(referencia));
    }

    private async fetchEstadoAcademico(): Promise<string> {
        return this.fetchLinkedPage(/estado\s*acad/i, "estado académico");
    }

    private async fetchCorrelatividades(): Promise<string> {
        // El menú la anuncia como "Correlatividad para cursar"; primero en orden de menú.
        return this.fetchLinkedPage(/correlatividad\s*para\s*cursar/i, "correlatividades para cursar");
    }

    private async fetchCorrelatividadesExamen(): Promise<string> {
        // Página aparte: "Correlatividad para rendir" (correlatividadExamen.asp).
        return this.fetchLinkedPage(/correlatividad\s*para\s*rendir/i, "correlatividades para rendir");
    }

    private async fetchNotasParciales(): Promise<string> {
        return this.fetchLinkedPage(/notas?\s*de?\s*parcial/i, "notas de parciales");
    }

    private async fetchExamenes(): Promise<string> {
        return this.fetchLinkedPage(/^ex[aá]menes$/i, "exámenes");
    }

    /**
     * Sigue del menú el enlace cuyo texto matchea `linkText`. Si no aparece, el error lista las opciones
     * reales del menú para ajustar. Si la sesión venció, vuelve a loguear una vez y reintenta.
     */
    private async fetchLinkedPage(linkText: RegExp, label: string): Promise<string> {
        if (!this.menu && this.credentials) await this.login(this.credentials);
        return this.withReLogin(async () => {
            if (!this.menu) throw new this.kit.LoginRequiredError(SYSTEM_NAME);
            const href = findMenuLink(this.menu.html, linkText);
            if (!href) {
                const options = [...this.menu.html.matchAll(/<a\s[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
                    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
                    .filter(Boolean);
                throw new this.kit.HttpError(
                    `No encontré "${label}" en el menú de Sysacad. Opciones que muestra: ${options.join(", ")}.`,
                );
            }
            return this.fetchPage(href);
        });
    }

    private async withReLogin<T>(read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (error) {
            if (!(error instanceof this.kit.LoginRequiredError) || !this.credentials) throw error;
            await this.login(this.credentials);
            return read();
        }
    }

    /** GET de una página interna con la sesión; si volvió al login, la sesión venció. */
    private async fetchPage(href: string): Promise<string> {
        const page = await this.request(this.sessionUrl(href));
        if (findLoginForm(page.html, page.url)) {
            this.menu = null;
            this.sessionId = null;
            throw new this.kit.LoginRequiredError(SYSTEM_NAME);
        }
        return page.html;
    }

    private async fetchBinary(href: string, followedDownload = false): Promise<CertificadoDescargado> {
        const page = await this.requestRaw(this.sessionUrl(href), undefined, MAX_CERTIFICADO_BYTES);
        if (!/^text\/html/i.test(page.contentType)) {
            return { contentType: page.contentType, bytes: new Uint8Array(page.buffer) };
        }
        const html = decode(page.contentType, page.buffer);
        if (findLoginForm(html, page.url)) {
            this.menu = null;
            this.sessionId = null;
            throw new this.kit.LoginRequiredError(SYSTEM_NAME);
        }
        if (!followedDownload) {
            const download = findDownloadLink(html);
            if (download) return this.fetchBinary(download, true);
        }
        return { contentType: page.contentType, bytes: new Uint8Array(page.buffer) };
    }

    private sessionUrl(href: string): URL {
        if (!this.menu) throw new this.kit.LoginRequiredError(SYSTEM_NAME);
        const url = new URL(href, this.menu.url);
        if (url.origin !== new URL(this.menu.url).origin) {
            // Un enlace interno legítimo no sale del host; no le mandamos la sesión a otro lado.
            throw new this.kit.HttpError(`Sysacad devolvió un enlace fuera de ${new URL(this.menu.url).host}: no se sigue.`);
        }
        if (this.sessionId && !url.searchParams.get("id")) url.searchParams.set("id", this.sessionId);
        return url;
    }

    private async request(url: URL, body?: URLSearchParams): Promise<Page> {
        const raw = await this.requestRaw(url, body);
        return { url: raw.url, html: decode(raw.contentType, raw.buffer) };
    }

    private async requestRaw(url: URL, body?: URLSearchParams, maxBytes?: number): Promise<{ url: string; contentType: string; buffer: ArrayBuffer }> {
        let current = url;
        let method = body ? "POST" : "GET";
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            let res: Response;
            try {
                res = await fetch(current, {
                    method,
                    body: method === "POST" ? body : undefined,
                    headers: this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {},
                    redirect: "manual",
                    signal: AbortSignal.timeout(30_000),
                });
            } catch (e) {
                throw new this.kit.HttpError(`No se pudo conectar con ${current.host}: ${(e as Error).message}`, undefined, {
                    cause: e,
                });
            }
            for (const cookie of res.headers.getSetCookie()) {
                const [pair] = cookie.split(";");
                const eq = pair.indexOf("=");
                if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                const next = new URL(location, current);
                if (next.origin !== url.origin) {
                    throw new this.kit.HttpError(`Sysacad redirigió a ${next.host}, otro sitio: no se sigue.`);
                }
                current = next;
                method = "GET";
                continue;
            }
            if (!res.ok) {
                throw new this.kit.HttpError(`HTTP ${res.status} en ${current.pathname}`, res.status, {
                    retryAfterMs: this.kit.retryAfterMs(res.headers.get("retry-after")),
                });
            }
            const buffer = maxBytes ? await this.readCapped(res, maxBytes, current.pathname) : await res.arrayBuffer();
            return { url: current.href, contentType: res.headers.get("content-type") ?? "", buffer };
        }
        throw new this.kit.HttpError(`Demasiadas redirecciones desde ${url.pathname}.`);
    }

    private async readCapped(res: Response, maxBytes: number, pathname: string): Promise<ArrayBuffer> {
        const tooBig = () =>
            new this.kit.HttpError(
                `El archivo de ${pathname} pesa más de ${maxBytes / 1024 / 1024} MB: no se descargó. Bajalo directo de Sysacad.`,
            );
        const declared = Number(res.headers.get("content-length"));
        if (declared > maxBytes) {
            await res.body?.cancel();
            throw tooBig();
        }
        if (!res.body) {
            const buffer = await res.arrayBuffer();
            if (buffer.byteLength > maxBytes) throw tooBig();
            return buffer;
        }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxBytes) throw tooBig();
                chunks.push(value);
            }
        } catch (e) {
            await reader.cancel().catch(() => {});
            if (e instanceof this.kit.HttpError) throw e;
            throw new this.kit.HttpError(`No se pudo leer el archivo de ${pathname}: ${(e as Error).message}`, undefined, {
                cause: e,
            });
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return out.buffer;
    }

    private cookieHeader(): string {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
}

/** SysacadWEB sirve HTML 4.01 en iso-8859-1; si alguna regional declara UTF-8, se respeta. */
function decode(contentType: string, buffer: ArrayBuffer): string {
    const utf8 = /charset=utf-?8/i.test(contentType);
    return new TextDecoder(utf8 ? "utf-8" : "iso-8859-1").decode(buffer);
}

function findDownloadLink(html: string): string | null {
    for (const m of html.matchAll(/<a\s[^>]*>/gi)) {
        if (!/\bdownload\s*=/i.test(m[0])) continue;
        const href = /href\s*=\s*"?([^"'\s>]+)"?/i.exec(m[0])?.[1];
        if (href) return href;
    }
    return null;
}

/** href del primer enlace del menú cuyo texto visible matchea. */
function findMenuLink(menuHtml: string, linkText: RegExp): string | null {
    for (const m of menuHtml.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const text = m[2].replace(/<[^>]+>/g, "").trim();
        if (linkText.test(text)) return m[1];
    }
    return null;
}
