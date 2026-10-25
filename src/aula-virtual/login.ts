import { ask, askChoice, askHidden } from "../shared/input.js";
import { logger } from "../shared/logger.js";
import { SqliteStore } from "../shared/store/sqlite-store.js";
import { saveCredentials, type Credentials } from "./client/credentials.js";
import { linkAulaAccount } from "./client/link.js";
import { LocalSession } from "./client/local-session.js";
import { availableRegionals, defaultRegional, type Regional } from "./client/regionals.js";
import type { SecondFactor } from "./client/sso-login.js";

/**
 * `utn-mcp login`: pide la regional, usuario y contraseña una vez, los guarda en el keychain
 * y obtiene el primer token. Después el servidor renueva solo.
 * Con `--http` guarda la sesión en el store y emite el token para el cliente MCP.
 */
export async function runLogin(http: boolean): Promise<void> {
    const regional = await askRegional();
    const prompt = regional.sso?.provider === "microsoft" ? "Mail de Office 365: " : "Usuario de la UTN: ";
    const username = (await ask(prompt)).trim();
    if (!username) throw new Error("Falta el usuario.");
    const password = await askHidden("Contraseña: ");
    const credentials: Credentials = { username, password, regional: regional.id };

    let accessToken: string | null = null;
    if (http) accessToken = await loginToStore(regional, credentials);
    else await new LocalSession().login(regional, credentials, askSecondFactor);

    // Se guardan recién después de comprobar que el aula las aceptó.
    if (await saveCredentials(credentials)) {
        logger.info("Credenciales guardadas en el keychain del sistema.");
    } else {
        logger.warn("No hay keychain disponible: para renovar sin intervención definí UTN_USER, UTN_PASS y UTN_REGIONAL.");
    }

    if (accessToken) {
        logger.info(
            "Listo. Configurá tu cliente MCP con este header; no se vuelve a mostrar:\n\n" +
                `    Authorization: Bearer ${accessToken}\n`,
        );
    } else {
        logger.info("Listo: ya podés usar el servidor MCP.");
    }
}

const SUPPORT_LABEL: Record<Regional["support"], string> = {
    verified: "",
    candidate: " · sin probar todavía",
    unsupported: " · todavía sin soporte",
};

/** Arranca marcada la de UTN_REGIONAL (o FRBA). */
async function askRegional(): Promise<Regional> {
    const regionals = availableRegionals();
    const initial = regionals.findIndex((r) => r.id === defaultRegional().id);
    const labels = regionals.map((r) => r.name + SUPPORT_LABEL[r.support]);
    return regionals[await askChoice("Regional:", labels, Math.max(initial, 0))];
}

/** Contesta por la terminal el segundo factor de Microsoft, si la cuenta lo pide. */
const askSecondFactor: SecondFactor = async (prompt) => {
    if (prompt.step === "choose") {
        const labels = prompt.methods.map((m) => m.label);
        return prompt.methods[await askChoice("Microsoft pide un segundo factor:", labels)].id;
    }
    if (prompt.step === "code") {
        return ask(prompt.retry ? "El código no era correcto. Probá de nuevo: " : `${prompt.method.label}: `);
    }
    const number = prompt.number ? ` y tocá el número ${prompt.number}` : "";
    return ask(`Aprobá el inicio de sesión en el celular (${prompt.method.label})${number}. Después apretá Enter. `);
};

/** Crea el usuario si no existe, guarda su sesión del aula y le emite un token que no vence. */
async function loginToStore(regional: Regional, credentials: Credentials): Promise<string> {
    const store = await SqliteStore.open();
    const { userId } = await linkAulaAccount(store, regional, credentials, askSecondFactor);
    return store.issueToken(userId, { kind: "access", clientId: "local" });
}
