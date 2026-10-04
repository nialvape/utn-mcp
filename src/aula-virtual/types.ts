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

export interface CourseModuleContent {
    type: "file" | "url" | "content";
    filename: string;
    filepath: string | null;
    filesize: number;
    fileurl: string;
    timemodified: number | null;
    mimetype?: string;
}

export interface CourseModule {
    id: number;
    name: string;
    modname: string;
    url?: string;
    description?: string;
    uservisible: boolean;
    availabilityinfo?: string;
    dates?: { label: string; timestamp: number }[];
    contents?: CourseModuleContent[];
}

export interface CourseSection {
    id: number;
    name: string;
    section: number;
    summary: string;
    uservisible?: boolean;
    modules: CourseModule[];
}
