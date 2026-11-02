import type { AutogestionConnector } from "./connector.js";

/**
 * La autogestión del usuario. Todo lo que habla con el sistema recibe esto y no sabe de dónde sale:
 * `LocalAutogestionSession` (STDIO, el usuario de la compu). El modo HTTP todavía no la tiene
 * resuelta: las credenciales por sistema de cada usuario quedan como decisión de diseño abierta.
 */
export interface AutogestionSession {
    /**
     * El conector del sistema que usa la regional del usuario, logueado y listo.
     * Rechaza con LoginRequiredError si faltan las credenciales o con InvalidCredentialsError
     * si el sistema las rechaza.
     */
    getConnector(): Promise<AutogestionConnector>;
}
