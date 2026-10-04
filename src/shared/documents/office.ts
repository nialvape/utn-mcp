import { deTexto, fragmentar, type Documento } from "./index.js";
import { leerEntrada, listarZip } from "./zip.js";

/**
 * docx, pptx y xlsx son zips de XML. Sacar el texto es leer unos pocos XML; no hace falta
 * una librería de Office para eso.
 */

export type FormatoOffice = "docx" | "pptx" | "xlsx";

/** Tope por entrada descomprimida: un XML de texto de más que esto es un zip malicioso o no es un documento. */
const MAX_ENTRADA = 50 * 1024 * 1024;

const MARCAS: Record<FormatoOffice, string> = {
    docx: "word/document.xml",
    pptx: "ppt/presentation.xml",
    xlsx: "xl/workbook.xml",
};

/** XML de las entradas del zip que hacen falta, por ruta. */
type Xmls = Record<string, string>;

/** Mira la lista de entradas del zip sin descomprimir nada. */
export function formatoOffice(bytes: Uint8Array): FormatoOffice | null {
    const nombres = new Set(listarZip(bytes).map((e) => e.nombre));
    return (Object.keys(MARCAS) as FormatoOffice[]).find((f) => nombres.has(MARCAS[f])) ?? null;
}

export function abrirOffice(bytes: Uint8Array, formato: FormatoOffice): Documento {
    const texto = new TextDecoder();
    const zip: Xmls = Object.fromEntries(
        listarZip(bytes)
            .filter((e) => necesaria(formato, e.nombre))
            .map((e) => [e.nombre, texto.decode(leerEntrada(bytes, e, MAX_ENTRADA))]),
    );

    switch (formato) {
        case "docx":
            return deTexto("docx", "fragmento", fragmentar(xmlTexto(leer(zip, "word/document.xml"), "w")).map((texto) => ({ texto })));

        case "pptx":
            return deTexto(
                "pptx",
                "diapositiva",
                Object.keys(zip)
                    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
                    .sort((a, b) => numero(a) - numero(b))
                    .map((p) => ({ texto: xmlTexto(leer(zip, p), "a") || "(diapositiva sin texto)" })),
            );

        case "xlsx":
            return deTexto(
                "xlsx",
                "fragmento",
                hojas(zip).flatMap(({ nombre, texto }) => {
                    const partes = fragmentar(texto);
                    return partes.map((t, i) => ({
                        titulo: partes.length > 1 ? `hoja "${nombre}" (${i + 1}/${partes.length})` : `hoja "${nombre}"`,
                        texto: t,
                    }));
                }),
            );
    }
}

function necesaria(formato: FormatoOffice, nombre: string): boolean {
    switch (formato) {
        case "docx":
            return nombre === "word/document.xml";
        case "pptx":
            return /^ppt\/slides\/slide\d+\.xml$/.test(nombre);
        case "xlsx":
            return nombre === "xl/workbook.xml" || nombre === "xl/sharedStrings.xml" ||
                nombre === "xl/_rels/workbook.xml.rels" || nombre.startsWith("xl/worksheets/");
    }
}

const leer = (zip: Xmls, ruta: string) => zip[ruta] ?? "";
const numero = (ruta: string) => Number(ruta.match(/(\d+)\.xml$/)?.[1]);

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodificar = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
        e[0] !== "#" ? (ENTIDADES[e] ?? m) : String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
    );

/**
 * Texto de un XML de Word (`w`) o PowerPoint (`a`), recorriendo los tags en orden: texto de los nodos
 * de texto, salto de línea al cerrar un párrafo, y las tablas como filas con celdas separadas por " | ".
 */
function xmlTexto(xml: string, ns: "w" | "a"): string {
    let out = "";
    let enTexto = false;
    let enCelda = 0;
    for (const [, cierre, tag, , autocierre, chars] of xml.matchAll(/<(\/?)([\w:]+)((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/g)) {
        if (chars !== undefined) {
            if (enTexto) out += decodificar(chars);
        } else if (tag === `${ns}:t`) {
            enTexto = !cierre && !autocierre;
        } else if (tag === `${ns}:tc` && !autocierre) {
            enCelda += cierre ? -1 : 1;
            if (cierre) out += " | ";
        } else if (tag === `${ns}:tr` && cierre) {
            out += "\n";
        } else if (tag === `${ns}:p` && cierre) {
            out += enCelda ? " " : "\n";
        } else if (tag === `${ns}:tab`) {
            out += " ";
        } else if (tag === `${ns}:br`) {
            out += enCelda ? " " : "\n";
        }
    }
    return out
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").replace(/\s*\|\s*$/, "").trim())
        .filter((l, i, todas) => l !== "|" && (l !== "" || todas[i - 1] !== ""))
        .join("\n")
        .trim();
}

/** Cada hoja como filas de celdas separadas por tabs, en el orden del libro. */
function hojas(zip: Xmls): { nombre: string; texto: string }[] {
    const compartidas = [...leer(zip, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        decodificar([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
    );
    const rels = Object.fromEntries(
        [...leer(zip, "xl/_rels/workbook.xml.rels").matchAll(/<Relationship [^>]*>/g)].map(([tag]) => [
            tag.match(/Id="([^"]+)"/)?.[1],
            tag.match(/Target="([^"]+)"/)?.[1],
        ]),
    );

    return [...leer(zip, "xl/workbook.xml").matchAll(/<sheet [^>]*>/g)].map(([tag]) => {
        const nombre = decodificar(tag.match(/name="([^"]*)"/)?.[1] ?? "");
        const destino = rels[tag.match(/r:id="([^"]+)"/)?.[1] ?? ""] ?? "";
        const ruta = destino.replace(/^\//, "").replace(/^(xl\/)?/, "xl/");
        const filas = [...leer(zip, ruta).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((fila) =>
            [...fila[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
                .map(([, attrs, cuerpo = ""]) => {
                    const tipo = attrs.match(/\bt="(\w+)"/)?.[1];
                    if (tipo === "s") return compartidas[Number(cuerpo.match(/<v>(\d+)<\/v>/)?.[1])] ?? "";
                    if (tipo === "inlineStr") return decodificar(cuerpo.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "");
                    return decodificar(cuerpo.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
                })
                .join("\t")
                .replace(/\t+$/, ""),
        );
        return { nombre, texto: filas.filter(Boolean).join("\n") || "(hoja vacía)" };
    });
}
