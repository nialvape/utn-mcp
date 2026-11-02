/** El formulario de ingreso, listo para postear: a dónde y con qué campos además de legajo y clave. */
export interface LoginForm {
    action: URL;
    fields: [string, string][];
}

/** Atributos de una etiqueta HTML 4.01: con comillas dobles, simples o sin comillas, en cualquier caso. */
function attributes(tag: string): Map<string, string> {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi)) {
        attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
    }
    return attrs;
}

/**
 * El formulario de alumnos de la página de login: el primero con un campo `legajo`. Cambia de una
 * regional a otra (oct 2026): FRH agrega `urlHash`, FRSFco un `csrf_token` y un segundo formulario,
 * FRSF se llama `form1` y postea a `SysAcad/menuAlumno.asp`. Por eso se reenvían todos sus campos
 * y se postea a su `action`, en vez de fijar una ruta. Devuelve null si la página no tiene formulario
 * de login: sirve también para saber si una respuesta es la pantalla de ingreso.
 */
export function findLoginForm(html: string, pageUrl: string): LoginForm | null {
    for (const formMatch of html.matchAll(/(<form\b[^>]*>)([\s\S]*?)<\/form>/gi)) {
        const inputs = [...formMatch[2].matchAll(/<input\b[^>]*>/gi)].map((m) => attributes(m[0]));
        if (!inputs.some((input) => input.get("name")?.toLowerCase() === "legajo")) continue;

        const fields: [string, string][] = [];
        for (const input of inputs) {
            const name = input.get("name");
            const type = input.get("type")?.toLowerCase() ?? "text";
            if (!name || name.toLowerCase() === "legajo" || name.toLowerCase() === "password") continue;
            // Un radio o un checkbox viaja solo si está marcado, como lo mandaría el navegador.
            if ((type === "radio" || type === "checkbox") && !input.has("checked")) continue;
            if (type === "reset" || type === "button" || type === "image") continue;
            fields.push([name, input.get("value") ?? ""]);
        }
        const action = attributes(formMatch[1]).get("action") || pageUrl;
        return { action: new URL(action, pageUrl), fields };
    }
    return null;
}
