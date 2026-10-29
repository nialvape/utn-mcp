/** Una materia del estado académico, con lo que el sistema informa de ella. */
export interface EstadoMateria {
    materia: string;
    estado?: string;
    plan?: string;
    anio?: string;
    nota?: string;
    fecha?: string;
    /** Celdas que no entraron en una columna conocida: no se tira información. */
    extra?: string[];
}

/** Una materia con las correlativas que exige, tal como las publica la autogestión. */
export interface CorrelatividadMateria {
    materia: string;
    /** Texto de la columna de correlativas, tal cual viene: "Puede cursar", "No aprobó X", etc. */
    correlativas: string;
    plan?: string;
    anio?: string;
    extra?: string[];
}

/**
 * Correlatividades de la carrera según la autogestión, separadas como las publica el sistema:
 * `cursar` siempre; `rendir` cuando el sistema la tiene en otra página (Sysacad sí, verificado
 * con cuenta real oct 2026). Es la fuente dinámica de las correlatividades en lugar de datos
 * fijos del repo.
 */
export interface Correlatividades {
    cursar: CorrelatividadMateria[];
    rendir?: CorrelatividadMateria[];
}

export interface NotasParcialesMateria {
    materia: string;
    anio?: string;
    comision?: string;
    aula?: string;
    horarios?: string;
    notas?: string;
    inasistencias?: string;
    obs?: string;
    cursando: boolean;
}

export interface ExamenMateria {
    materia: string;
    fecha?: string;
    nota?: string;
    especialidad?: string;
    plan?: string;
    codigo?: string;
}
