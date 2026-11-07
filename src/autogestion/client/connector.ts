import { HttpError, retryAfterMs } from "../../shared/http.js";
import { htmlToText } from "../../shared/html.js";
import { isTransientError, withRetry, type RetryPolicy } from "../../shared/retry.js";
import type { Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";

/**
 * Un sistema de autogestión académica (Sysacad, SIU Guaraní, etc.) logueado con un usuario.
 * Cada sistema es un paquete aparte que exporta un `AutogestionSystem`; el core lo instala desde su
 * catálogo y le pide un conector para la regional del usuario.
 */
export interface AutogestionConnector {
    /** Id del sistema, tal como lo declara el paquete que lo provee. */
    readonly systemId: string;
    /** Pide legajo/usuario y contraseña al sistema y deja la sesión lista. */
    login(credentials: AutogestionCredentials): Promise<void>;
    /** Materias del estado académico del alumno logueado, ya parseadas. */
    estadoAcademico(): Promise<EstadoMateria[]>;
    /** Correlatividades de la carrera del alumno logueado, para cursar y, si el sistema las publica, para rendir. */
    correlatividades(): Promise<Correlatividades>;
    /** Cursada actual, si el sistema la publica; no todos los conectores la tienen. */
    notasParciales?(): Promise<NotasParcialesMateria[]>;
    /** Historial de exámenes finales, si el sistema lo publica; no todos los conectores lo tienen. */
    examenes?(): Promise<ExamenMateria[]>;
    /**
     * La sesión del sistema sin la contraseña (cookies, ids de sesión), para guardarla cifrada y retomarla
     * en otro request. Sin esto, el conector sirve solo en local: el modo HTTP no guarda contraseñas.
     */
    exportSession?(): string;
    /**
     * Retoma una sesión de `exportSession`. Sin la contraseña no puede volver a entrar solo: si la sesión
     * venció, las llamadas rechazan con `LoginRequiredError`.
     */
    restoreSession?(data: string): void;
}

/** Credenciales de un sistema de autogestión. En Sysacad `username` es el legajo. */
export interface AutogestionCredentials {
    username: string;
    password: string;
}

export class LoginRequiredError extends Error {
    constructor(systemName: string) {
        super(`Falta iniciar sesión en ${systemName}: corré \`utn-mcp login autogestion\` una vez.`);
        this.name = "LoginRequiredError";
    }
}

export class InvalidCredentialsError extends Error {
    constructor(systemName: string) {
        super(`${systemName} rechazó el usuario o la contraseña. Revisalos con \`utn-mcp login autogestion\`.`);
        this.name = "InvalidCredentialsError";
    }
}

export class UnsupportedRegionalError extends Error {
    constructor(regionalId: string) {
        super(
            `La regional ${regionalId.toUpperCase()} todavía no tiene un conector de autogestión. ` +
                "El aula virtual se puede seguir usando sin autogestión.",
        );
        this.name = "UnsupportedRegionalError";
    }
}

/**
 * Reintentos con backoff para las lecturas del conector (`withRetry` de `shared/retry.ts`), con dos
 * exclusiones propias de la autogestión: las credenciales inválidas y la sesión vencida no se
 * reintentan: la recuperación de sesión ya la hace el conector y, en HTTP, la capa de sesión
 * guardada. Optativo por operación y solo para lecturas idempotentes: el login no lo lleva.
 */
function autogestionWithRetry<T>(operation: () => Promise<T>, policy: RetryPolicy = {}): Promise<T> {
    return withRetry(operation, {
        isTransient: (error) =>
            !(error instanceof LoginRequiredError || error instanceof InvalidCredentialsError) &&
            isTransientError(error),
        ...policy,
    });
}

/**
 * Lo que el core le presta al conector en `create`. El paquete importa del core solo tipos: instalado
 * en otra carpeta, un import en tiempo de ejecución cargaría otra copia de `utn-mcp`, con otras clases
 * de error que el core no reconoce. Por eso los reintentos también entran por acá (`withRetry`), como
 * valor y no como import.
 */
export const connectorKit = {
    HttpError,
    LoginRequiredError,
    InvalidCredentialsError,
    htmlToText,
    retryAfterMs,
    withRetry: autogestionWithRetry,
};

export type ConnectorKit = typeof connectorKit;

/** Lo que exporta un paquete de conector: qué regionales atiende y cómo crear el conector de cada una. */
export interface AutogestionSystem {
    id: string;
    name: string;
    /** Ids de regional como en `regionals.ts` del aula (`frt`, `frd`...). */
    regionales: string[];
    /** Ayuda para el usuario de esa regional, si no es el legajo tal cual: "Legajo sin el 23-". */
    usernameHint?(regionalId: string): string | undefined;
    create(regionalId: string, kit: ConnectorKit): AutogestionConnector;
}

/** El sistema de una regional entre los conectores cargados, o null si ninguno la cubre. */
export function systemForRegional(regionalId: string, systems: AutogestionSystem[]): AutogestionSystem | null {
    return systems.find((system) => system.regionales.includes(regionalId)) ?? null;
}

export type { CorrelatividadMateria, Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";
export type { RetryEvent, RetryPolicy } from "../../shared/retry.js";
