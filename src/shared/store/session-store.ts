/**
 * Dónde viven los usuarios del modo HTTP, sus tokens y sus sesiones en cada plataforma. El servidor
 * MCP lee (y guarda la sesión cuando la renueva); los usuarios y tokens los crea otro proceso: el
 * login por OAuth de la versión hosteada o `utn-mcp login --http` en local.
 */
export interface SessionStore {
    /**
     * Id del usuario con ese nombre en esa regional; lo crea si no existe. Con `email`, se lo actualiza.
     * Dos regionales pueden tener el mismo nombre de usuario para personas distintas.
     */
    findOrCreateUser(regional: string, utnUsername: string, email?: string): Promise<number>;

    findUser(userId: number): Promise<StoredUser | null>;

    findUserByEmail(email: string): Promise<StoredUser | null>;

    /**
     * Emite un token para el usuario y devuelve el valor en claro: se muestra una sola vez, en la base
     * queda solo el hash. Sin `ttlSeconds` no vence (el token fijo del modo local).
     */
    issueToken(userId: number, options: { kind: TokenKind; clientId?: string; ttlSeconds?: number }): Promise<string>;

    /** El token si es de ese tipo y está vigente; si no, null. */
    findToken(token: string, kind: TokenKind): Promise<IssuedToken | null>;

    revokeToken(token: string): Promise<void>;

    /** La sesión del usuario en una plataforma, tal como la guardó: cada plataforma decide su forma. */
    loadSession(userId: number, platform: string): Promise<string | null>;

    saveSession(userId: number, platform: string, data: string): Promise<void>;

    /** Cuándo se guardó por última vez la sesión, en segundos desde epoch; null si no hay. */
    sessionUpdatedAt(userId: number, platform: string): Promise<number | null>;

    /** Las regionales que alguien ya usó en este servidor sin que estuvieran verificadas en el catálogo. */
    listVerifiedRegionals(): Promise<string[]>;

    markRegionalVerified(regional: string): Promise<void>;

    /** Clientes OAuth registrados por registro dinámico (RFC 7591). */
    saveClient(client: RegisteredClient): Promise<void>;

    findClient(clientId: string): Promise<RegisteredClient | null>;

    /** Los clientes que todavía tienen un token vigente del usuario: las apps que tiene conectadas. */
    listConnectedClients(userId: number): Promise<ConnectedClient[]>;

    /** Borra todos los tokens del usuario para ese cliente: la app queda desconectada. */
    revokeClient(userId: number, clientId: string): Promise<void>;
}

export interface ConnectedClient {
    clientId: string;
    /** El que mandó la app al registrarse; null para el token fijo de `utn-mcp login --http`. */
    clientName: string | null;
    /** Cuándo se emitió su token más nuevo, en segundos desde epoch: los refresh rotan con el uso. */
    lastTokenAt: number;
}

export interface StoredUser {
    id: number;
    /** El id de su regional (`frba`, `frt`...): su aula y, junto con el nombre, su identidad. */
    regional: string;
    utnUsername: string;
    /** El institucional, el que se usa para decidir el acceso; null en usuarios de antes de guardarlo. */
    email: string | null;
}

/** Un cliente público: no tiene secreto, se autentica con PKCE. */
export interface RegisteredClient {
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
}

/** `access` va en cada request al MCP; `refresh` solo sirve para pedir un `access` nuevo. */
export type TokenKind = "access" | "refresh";

export interface IssuedToken {
    userId: number;
    clientId: string | null;
    /** En segundos desde epoch; null si no vence. */
    expiresAt: number | null;
}
