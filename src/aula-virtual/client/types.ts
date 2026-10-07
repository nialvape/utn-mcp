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
    userid: number;
    pinned: boolean;
    attachment: boolean;
}

export interface ForumPost {
    id: number;
    subject: string;
    /** El asunto que Moodle propone para responderla ("Re: ..."). */
    replysubject: string;
    message: string;
    author: { id: number; fullname: string };
    timecreated: number;
    parentid: number | null;
    isdeleted: boolean;
    capabilities: { reply: boolean; edit: boolean; delete: boolean };
    attachments: { filename: string; fileurl: string; filesize: number; mimetype?: string }[];
}

export interface MoodleFile {
    filename: string;
    filepath?: string | null;
    filesize: number;
    fileurl: string;
    mimetype?: string;
    timemodified?: number | null;
}

/** Un plugin de entrega o de devolución: archivos (`fileareas`) o texto (`editorfields`). */
export interface AssignPlugin {
    type: string;
    name: string;
    fileareas?: { area: string; files?: MoodleFile[] }[];
    editorfields?: { name: string; text: string; format: number }[];
}

export interface AssignSubmission {
    status: "new" | "draft" | "submitted" | "reopened" | string;
    timemodified: number;
    plugins?: AssignPlugin[];
}

export interface AssignSubmissionStatus {
    lastattempt?: {
        submission?: AssignSubmission;
        /** En las entregas grupales la que cuenta es esta, no la individual. */
        teamsubmission?: AssignSubmission;
        locked: boolean;
        graded: boolean;
        canedit: boolean;
        cansubmit: boolean;
        extensionduedate: number | null;
        gradingstatus: string;
    };
    feedback?: {
        gradefordisplay?: string;
        gradeddate?: number;
        plugins?: AssignPlugin[];
    };
}

export interface Assignment {
    id: number;
    cmid: number;
    duedate: number;
    cutoffdate: number;
    allowsubmissionsfromdate: number;
    /** 1: la entrega queda en borrador hasta que se confirma el envío. */
    submissiondrafts: number;
    requiresubmissionstatement: number;
    teamsubmission: number;
    maxattempts: number;
    configs: { plugin: string; subtype: string; name: string; value: string }[];
}

export interface Choice {
    id: number;
    coursemodule: number;
    allowupdate: boolean;
    allowmultiple: boolean;
    timeopen: number;
    timeclose: number;
}

export interface ChoiceOption {
    id: number;
    /** En choice es el texto de la opción; en choicegroup viene en `name`. */
    text?: string;
    name?: string;
    maxanswers?: number;
    countanswers?: number;
    checked?: boolean;
    disabled?: boolean;
}
