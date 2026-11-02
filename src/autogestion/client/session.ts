import type { AutogestionConnector, AutogestionSystem } from "./connector.js";

/**
 * La autogestión del usuario. Todo lo que habla con el sistema recibe esto y no sabe de dónde sale:
 * `LocalAutogestionSession` (STDIO, el usuario de la compu, credenciales del keychain) o la hosteada
 * (HTTP, el usuario entra desde un link y la contraseña no se guarda).
 */
export interface AutogestionSession {
    /**
     * El conector del sistema que usa la regional del usuario, logueado y listo.
     * Rechaza con un error que dice cómo iniciar sesión si todavía no se puede.
     */
    getConnector(): Promise<AutogestionConnector>;
}

/** Los conectores disponibles y cómo armar la sesión de un usuario: lo que recibe `createServer`. */
export interface AutogestionAccess {
    systems: AutogestionSystem[];
    sessionFor(system: AutogestionSystem, regionalId: string): AutogestionSession;
}
