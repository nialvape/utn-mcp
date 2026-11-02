import { connectorKit, LoginRequiredError, type AutogestionConnector, type AutogestionSystem } from "./connector.js";
import { loadAutogestionCredentials } from "./credentials.js";
import type { AutogestionSession } from "./session.js";

/**
 * Sesión del modo local: un solo usuario, el de la compu. Recibe el sistema ya resuelto para la
 * regional (la misma que eligió para el aula) y loguea el conector con las credenciales del
 * keychain o las env vars, una vez por sistema y bajo demanda: el primer uso es el que pide login.
 */
export class LocalAutogestionSession implements AutogestionSession {
    /** Conectores ya logueados, por sistema: un login alcanza para todas las tools. */
    private readonly connectors = new Map<string, Promise<AutogestionConnector>>();

    /** El sistema llega resuelto desde afuera: las plataformas no se conocen entre sí. */
    constructor(
        private readonly system: AutogestionSystem,
        private readonly regionalId: string,
    ) {}

    async getConnector(): Promise<AutogestionConnector> {
        const system = this.system;
        let connector = this.connectors.get(system.id);
        if (!connector) {
            connector = this.login(system.id, system.create(this.regionalId, connectorKit)).catch((error: unknown) => {
                this.connectors.delete(system.id);
                throw error;
            });
            this.connectors.set(system.id, connector);
        }
        return connector;
    }

    private async login(systemId: string, connector: AutogestionConnector): Promise<AutogestionConnector> {
        const credentials = await loadAutogestionCredentials(systemId);
        if (!credentials) throw new LoginRequiredError("la autogestión de tu regional");
        await connector.login(credentials);
        return connector;
    }
}
