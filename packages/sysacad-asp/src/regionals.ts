/** Lo que cambia del Sysacad ASP de una regional a otra: es el mismo producto, con otra URL y otras reglas. */
export interface AspRegional {
    /** La página con el formulario de ingreso de alumnos; el POST va al `action` que declara. */
    loginUrl: string;
    /** Qué escribir como usuario, si no es el legajo tal cual. */
    usernameHint?: string;
    /** Largo máximo de la clave: el formulario dice 12, pero hay regionales que truncan antes sin avisar. */
    passwordMaxLength?: number;
}

/**
 * URLs confirmadas con GET al login público (oct 2026). Quedan afuera las que no se pueden automatizar:
 * FRA (reCAPTCHA v2), FRRo (desafío JS "Verificando tu navegador"), FRRa y FRSC (solo HTTP: la clave
 * viajaría en claro) y FRTL (certificado HTTPS inválido). FRBB y FRSF tienen además un Sysacad Web2,
 * que es otro sistema; acá va su ASP clásico.
 */
export const ASP_REGIONALS: Record<string, AspRegional> = {
    frbb: { loginUrl: "https://www.frbb.utn.edu.ar/sysacad/loginalumno.asp", passwordMaxLength: 11 },
    frch: { loginUrl: "https://sysacad.frch.utn.edu.ar/loginalumno.asp" },
    frcon: { loginUrl: "https://ha1.frcon.utn.edu.ar/auto/loginalumno.asp" },
    frd: { loginUrl: "https://autogestion.frd.utn.edu.ar/", usernameHint: "Legajo sin el 23-" },
    frgp: { loginUrl: "https://sysacadweb.frgp.utn.edu.ar/loginAlumno.asp" },
    frh: { loginUrl: "https://autogestionalumno.frh.utn.edu.ar/loginAlumno.asp" },
    frlr: {
        loginUrl: "https://sysacad.frlr.utn.edu.ar/loginAlumno.asp",
        usernameHint: "Legajo sin el 30, 4 caracteres",
        passwordMaxLength: 8,
    },
    frmdp: { loginUrl: "https://autogestion.mdp.utn.edu.ar/loginAlumno.asp" },
    frn: { loginUrl: "https://autogestion.frn.utn.edu.ar/" },
    frp: { loginUrl: "https://sysacad.frp.utn.edu.ar/" },
    frrq: { loginUrl: "https://www3.frrq.utn.edu.ar/sysacadweb/loginalumno.asp" },
    frsf: { loginUrl: "https://sysacad.frsf.utn.edu.ar/" },
    frsfco: {
        loginUrl: "https://sistemas.frsfco.utn.edu.ar/sysacad/loginalumno.asp",
        usernameHint: "Legajo sin facultad ni dígito: 12-4141-2 → 4141",
        passwordMaxLength: 11,
    },
    frsn: { loginUrl: "https://wwwsi.frsn.utn.edu.ar/sysacad/" },
    frsr: { loginUrl: "https://sysacad.frsr.utn.edu.ar:9443/loginalumno.asp" },
    frt: { loginUrl: "https://sysacad.frt.utn.edu.ar/loginAlumno.asp" },
    frtdf: { loginUrl: "https://sysacad.frtdf.utn.edu.ar/loginAlumno.asp" },
    frvt: { loginUrl: "https://sysacad.frvt.utn.edu.ar/autogestion/loginalumno.asp" },
};
