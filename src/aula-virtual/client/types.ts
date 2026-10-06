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
    /** id del plugin, no del módulo: es lo que piden las funciones mod_* (p. ej. forumid). */
    instance: number;
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

export interface ForumDiscussion {
    /** id de la discusión; es el que pide mod_forum_get_discussion_posts. */
    discussion: number;
    subject: string;
    message: string;
    userfullname: string;
    created: number;
    timemodified: number;
    numreplies: number;
    pinned: boolean;
    attachment: boolean;
}

export interface ForumPost {
    id: number;
    subject: string;
    message: string;
    author: { fullname: string };
    timecreated: number;
    parentid: number | null;
    isdeleted: boolean;
    attachments: { filename: string; fileurl: string; filesize: number; mimetype?: string }[];
}
