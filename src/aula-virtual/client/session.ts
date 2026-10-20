import type { Regional } from "./regionals.js";

/**
 * El aula y el token de un usuario. Todo lo que habla con el aula recibe esto y no sabe de dónde sale:
 * `LocalSession` (STDIO, el usuario de la compu) o `StoredAulaSession` (HTTP, un usuario del store).
 */
export interface AulaSession {
    getRegional(): Promise<Regional>;
    /** Token vigente; si no hay ninguno, obtiene uno. */
    getToken(): Promise<string>;
    /** Descarta el token actual y obtiene uno nuevo. */
    refreshToken(): Promise<string>;
}
