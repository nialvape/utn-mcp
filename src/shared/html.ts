const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** HTML de Moodle a texto plano: alcanza para que el modelo lo lea, no es un parser. */
export function htmlToText(html: string | undefined): string {
    if (!html) return "";
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) =>
            e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
        )
        .replace(/[ \t ]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
}

/** Como htmlToText pero recortado: para índices, donde solo hace falta decidir si entrar. */
export function htmlToSnippet(html: string | undefined, max = 200): string {
    const text = htmlToText(html);
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Texto plano del modelo a HTML para Moodle: escapa, y cada línea en blanco separa un párrafo. */
export function textToHtml(text: string): string {
    const escaped = text
        .trim()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    return escaped
        .split(/\n\s*\n/)
        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
        .join("");
}
