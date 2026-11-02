import express, { type Express, type RequestHandler, type Response } from "express";
import { RateLimiter } from "../shared/expiring.js";
import { logger } from "../shared/logger.js";
import { escapeHtml, page } from "../shared/pages.js";
import { InvalidCredentialsError } from "./client/connector.js";
import type { PendingLink, StoredAutogestion } from "./client/stored-session.js";

/** Intentos de login por IP cada 15 minutos (en milisegundos): cada uno es un login contra el sistema de la regional. */
const MAX_ATTEMPTS = 10;
const ATTEMPTS_WINDOW_MS = 15 * 60 * 1000;

/**
 * `/autogestion/:id`: la página del link que el agente le pasa al usuario para entrar a su autogestión
 * en modo HTTP. Sin bearer, como `/subir`: el id del link es el secreto y lo abre un navegador.
 */
export function mountAutogestionLink(app: Express, stored: StoredAutogestion, sameOrigin: RequestHandler): void {
    const form = express.urlencoded({ extended: false, limit: "16kb" });
    const limiter = new RateLimiter(MAX_ATTEMPTS, ATTEMPTS_WINDOW_MS);

    app.get("/autogestion/:id", sameOrigin, (req, res) => {
        const link = stored.link(String(req.params.id));
        if (!link) return void expired(res);
        res.type("html").send(linkPage(link));
    });

    app.post("/autogestion/:id", sameOrigin, form, async (req, res) => {
        const id = String(req.params.id);
        const link = stored.link(id);
        if (!link) return void expired(res);
        const retry = (error: string) => void res.type("html").send(linkPage(link, error));
        if (!limiter.allow(req.ip ?? "desconocida")) return retry("Demasiados intentos. Esperá unos minutos y probá de nuevo.");
        const username = String(req.body?.usuario ?? "").trim();
        const password = String(req.body?.contrasena ?? "");
        if (!username || !password) return retry("Completá legajo y contraseña.");
        try {
            await stored.complete(id, { username, password });
        } catch (e) {
            if (e instanceof InvalidCredentialsError) return retry(`${link.system.name} rechazó el legajo o la contraseña.`);
            logger.warn(`Autogestión: ${(e as Error).message}`);
            return retry((e as Error).message);
        }
        res.type("html").send(
            page("Listo", `<p>Entraste a ${escapeHtml(link.system.name)}. Volvé al chat y pedile al agente que reintente.</p>`),
        );
    });
}

function expired(res: Response): void {
    res.status(404).type("html").send(page("Link vencido", "<p>Este link venció o ya se usó. Pedile al agente uno nuevo.</p>"));
}

function linkPage(link: PendingLink, error?: string): string {
    const name = escapeHtml(link.system.name);
    const hint = link.system.usernameHint?.(link.regionalId);
    return page(
        `Entrar a ${link.system.name}`,
        `<p>Tu agente necesita entrar a ${name} para leer tu información académica. Usá el legajo y la contraseña ` +
            `de ${name}, que no siempre son los del aula virtual.</p>` +
            (error ? `<p class=error>${escapeHtml(error)}</p>` : "") +
            '<form method="post">' +
            `<label>Legajo${hint ? ` (${escapeHtml(hint)})` : ""}<input name="usuario" autocomplete="username" autocapitalize="none" required></label>` +
            '<label>Contraseña<input name="contrasena" type="password" autocomplete="current-password" required></label>' +
            '<button type="submit">Entrar</button></form>' +
            "<p class=nota>La contraseña se usa una sola vez para entrar y no se guarda: queda guardada, cifrada, " +
            `solo la sesión de ${name}. Cuando ${name} la vence, te va a pedir que entres de nuevo. ` +
            'El código es abierto: <a href="https://github.com/nialvape/utn-mcp">github.com/nialvape/utn-mcp</a>.</p>',
        "Autogestión",
    );
}
