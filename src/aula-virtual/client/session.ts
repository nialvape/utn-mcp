// para version hosteada y multiples usuarios/sesiones

export interface AulaSession {
    /** Token vigente; si no hay ninguno, obtiene uno. */
    getToken(): Promise<string>;
    /** Descarta el token actual y obtiene uno nuevo. */
    refreshToken(): Promise<string>;
}
