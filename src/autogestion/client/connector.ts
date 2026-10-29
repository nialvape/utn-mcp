import type { Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";

/**
 * Un sistema de autogestión académica de una regional (Sysacad, SIU Guaraní, etc.).
 * Cada sistema es un conector que implementa esta interfaz; los conectores vienen de paquetes
 * instalados que exportan un `AutogestionSystem` y se declaran en `UTN_MCP_CONNECTORS`: cada
 * regional enchufa su propio parser.
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
            `La regional ${regionalId.toUpperCase()} no tiene un conector de autogestión instalado y configurado. ` +
                "Instalá el conector de tu regional y agregá su paquete a UTN_MCP_CONNECTORS. " +
                "El aula virtual se puede seguir usando sin autogestión.",
        );
        this.name = "UnsupportedRegionalError";
    }
}

/** Qué se sabe del conector: `verified` = alguien entró con una cuenta real; `unverified` = falta esa prueba. */
export type SystemSupport = "verified" | "unverified";

/** Lo que exporta un paquete de conector: qué regionales atiende y cómo crear el conector. */
export interface AutogestionSystem {
    id: string;
    name: string;
    support: SystemSupport;
    regionales: string[];
    create(): AutogestionConnector;
}

/** El sistema de una regional entre los conectores instalados, o null si ninguno la cubre. */
export function systemForRegional(regionalId: string, systems: AutogestionSystem[]): AutogestionSystem | null {
    return systems.find((system) => system.regionales.includes(regionalId)) ?? null;
}

export { HttpError } from "../../shared/http.js";
export { htmlToText } from "../../shared/html.js";
export type { CorrelatividadMateria, Correlatividades, EstadoMateria, ExamenMateria, NotasParcialesMateria } from "./types.js";
