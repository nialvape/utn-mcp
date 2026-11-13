import { Expiring } from "../../shared/expiring.js";
import type { SessionStore } from "../../shared/store/session-store.js";
import {
    connectorKit,
    InvalidCredentialsError,
    LoginRequiredError,
    type AutogestionConnector,
    type AutogestionCredentials,
    type AutogestionSystem,
} from "./connector.js";
import type { AutogestionAccess, AutogestionSession } from "./session.js";

/** Con qué nombre guarda la autogestión su sesión en el store. */
export const AUTOGESTION_PLATFORM = "autogestion";

/** Cuánto dura un link para entrar, en milisegundos. */
const LINK_TTL_MS = 30 * 60 * 1000;

/** Lo que la autogestión guarda en el store para un usuario: la sesión del sistema, sin la contraseña. */
interface StoredAutogestionData {
    systemId: string;
    session: string;
}

/** Un link abierto para que el usuario entre a su autogestión desde el navegador. */
export interface PendingLink {
    userId: number;
    regionalId: string;
    system: AutogestionSystem;
}

/** Falta entrar a la autogestión: el mensaje trae el link para el usuario. */
export class AutogestionLinkRequiredError extends Error {
    constructor(systemName: string, url: string, reason?: string) {
        super(
            `${reason ? `${reason} ` : ""}Falta iniciar sesión en ${systemName}. Pasale al usuario este link para que entre ` +
                `con su legajo y contraseña de ${systemName} (vence en 30 minutos): ${url} . Cuando te avise que entró, ` +
                "reintentá. La contraseña no pasa por el chat: no se la pidas.",
        );
        this.name = "AutogestionLinkRequiredError";
    }
}

/**
 * La autogestión del modo HTTP, para todos los usuarios del servidor. Igual que el aula: la contraseña se
 * usa una sola vez, en la página del link, y no se guarda; en el store queda cifrada la sesión del
 * sistema (cookies), que el conector exporta. Cuando el sistema la vence, el usuario vuelve a entrar.
 */
export class StoredAutogestion {
    /** Los links viven en memoria: si el servidor se reinicia, el agente pide otro. */
    private readonly links = new Expiring<PendingLink>(LINK_TTL_MS);

    /** Solo los conectores que pueden exportar su sesión: los otros necesitarían guardar la contraseña. */
    readonly systems: AutogestionSystem[];

    constructor(
        private readonly baseUrl: string,
        private readonly store: SessionStore,
        systems: AutogestionSystem[],
    ) {
        this.systems = systems.filter((system) => {
            const connector = system.create(system.regionales[0], connectorKit);
            return typeof connector.exportSession === "function" && typeof connector.restoreSession === "function";
        });
    }

    /** Lo que recibe `createServer` para un usuario. */
    forUser(userId: number): AutogestionAccess {
        return {
            systems: this.systems,
            sessionFor: (system, regionalId) => new StoredAutogestionSession(this, userId, system, regionalId),
        };
    }

    /** El conector del usuario con su sesión guardada, o null si no hay una de ese sistema. */
    async restore(userId: number, system: AutogestionSystem, regionalId: string): Promise<AutogestionConnector | null> {
        const raw = await this.store.loadSession(userId, AUTOGESTION_PLATFORM);
        if (!raw) return null;
        const data = JSON.parse(raw) as StoredAutogestionData;
        if (data.systemId !== system.id) return null;
        const connector = system.create(regionalId, connectorKit);
        connector.restoreSession!(data.session);
        return connector;
    }

    /** Guarda la sesión del conector (cifrada, como todo el store); las cookies pueden cambiar en cada pedido. */
    async save(userId: number, connector: AutogestionConnector): Promise<void> {
        const data: StoredAutogestionData = { systemId: connector.systemId, session: connector.exportSession!() };
        await this.store.saveSession(userId, AUTOGESTION_PLATFORM, JSON.stringify(data));
    }

    /** El store no borra sesiones: una vacía es "no hay". */
    async forget(userId: number): Promise<void> {
        await this.store.saveSession(userId, AUTOGESTION_PLATFORM, "");
    }

    /** Un link para que el usuario entre; los que se abrieron antes siguen valiendo hasta que vencen o se usa uno. */
    openLink(userId: number, system: AutogestionSystem, regionalId: string): string {
        return `${this.baseUrl}/autogestion/${this.links.add({ userId, regionalId, system })}`;
    }

    link(id: string): PendingLink | undefined {
        return this.links.get(id);
    }

    /** Entra con lo que el usuario escribió en la página del link y guarda la sesión; la contraseña se descarta. */
    async complete(id: string, credentials: AutogestionCredentials): Promise<PendingLink> {
        const link = this.link(id);
        if (!link) throw new Error("El link venció o ya se usó. Pedile al agente uno nuevo.");
        const connector = link.system.create(link.regionalId, connectorKit);
        await connector.login(credentials);
        await this.save(link.userId, connector);
        this.links.take(id);
        return link;
    }
}

/** La sesión de un usuario en un request: el conector con la sesión guardada o, si no hay, el link para entrar. */
class StoredAutogestionSession implements AutogestionSession {
    constructor(
        private readonly stored: StoredAutogestion,
        private readonly userId: number,
        private readonly system: AutogestionSystem,
        private readonly regionalId: string,
    ) {}

    async getConnector(): Promise<AutogestionConnector> {
        const connector = await this.stored.restore(this.userId, this.system, this.regionalId);
        if (!connector) throw this.linkRequired();
        // Después de cada pedido se guarda la sesión, por si el sistema rotó las cookies. Si la venció, se
        // descarta y se pide entrar de nuevo: los mensajes del conector hablan del login por CLI, que acá no existe.
        const guard = async <T>(call: () => Promise<T>): Promise<T> => {
            try {
                const result = await call();
                await this.stored.save(this.userId, connector);
                return result;
            } catch (e) {
                if (!(e instanceof InvalidCredentialsError || e instanceof LoginRequiredError)) throw e;
                await this.stored.forget(this.userId);
                throw this.linkRequired(`La sesión de ${this.system.name} venció.`);
            }
        };
        return {
            systemId: connector.systemId,
            login: (credentials) => connector.login(credentials),
            estadoAcademico: () => guard(() => connector.estadoAcademico()),
            correlatividades: () => guard(() => connector.correlatividades()),
            notasParciales: connector.notasParciales && (() => guard(() => connector.notasParciales!())),
            examenes: connector.examenes && (() => guard(() => connector.examenes!())),
            certificados: connector.certificados && (() => guard(() => connector.certificados!())),
            descargarCertificado:
                connector.descargarCertificado &&
                ((referencia: string) => guard(() => connector.descargarCertificado!(referencia))),
        };
    }

    private linkRequired(reason?: string): AutogestionLinkRequiredError {
        return new AutogestionLinkRequiredError(this.system.name, this.stored.openLink(this.userId, this.system, this.regionalId), reason);
    }
}
