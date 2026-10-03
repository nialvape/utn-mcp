// Respuestas de Moodle, solo con los campos que usamos.

export interface SiteInfo {
    sitename: string;
    username: string;
    fullname: string;
    userid: number;
    release: string;
    functions: { name: string; version: string }[];
}

export interface Course {
    id: number;
    shortname: string;
    fullname: string;
    visible: number;
    progress?: number | null;
    lastaccess?: number | null;
}
