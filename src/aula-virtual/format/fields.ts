import type { MoodleFile } from "../client/types.js";
import { userFacingUrl } from "./files.js";

/** Los timestamps de Moodle (segundos) en ISO; 0 o vacío es "sin fecha". */
export const isoDate = (seconds: number | null | undefined) =>
    seconds ? new Date(seconds * 1000).toISOString() : null;

export function toFile(f: MoodleFile) {
    return {
        nombre: f.filename,
        ruta: f.filepath || undefined,
        tamanio: f.filesize,
        mimetype: f.mimetype,
        modificado: isoDate(f.timemodified),
        // Sirve para pasársela al usuario y también para leerlo con aula_read_file.
        url: userFacingUrl(f.fileurl),
    };
}
