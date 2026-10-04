import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import type { Documento, Parte } from "./index.js";
import { pngGris } from "./png.js";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * pdf.js no es una dependencia: scripts/vendor-pdfjs.mjs copia a vendor/pdfjs los pocos archivos que
 * usamos. Está a la misma altura desde src/ y desde build/, así que la ruta sirve en dev y publicado.
 */
const VENDOR = new URL("../../../vendor/pdfjs/", import.meta.url);

/** Al arrancar en Node, pdf.js avisa que le falta canvas para renderizar. No renderizamos: son ruido en el log. */
const AVISOS_DE_CANVAS = /@napi-rs\/canvas|Cannot polyfill/;

let pdfjsCargado: Promise<PdfJs> | undefined;

/** Se carga recién al primer PDF: son 3 MB que el servidor no necesita para arrancar. */
function pdfjs(): Promise<PdfJs> {
    pdfjsCargado ??= (async () => {
        const warn = console.warn;
        console.warn = (...args: unknown[]) => {
            if (!AVISOS_DE_CANVAS.test(String(args[0]))) warn(...args);
        };
        try {
            return (await import(new URL("pdf.mjs", VENDOR).href)) as PdfJs;
        } finally {
            console.warn = warn;
        }
    })();
    return pdfjsCargado;
}

/** Menos texto que esto en una página la tratamos como escaneada. */
const MIN_TEXTO = 20;
/** Lado largo de la imagen de una página: el tamaño que Claude procesa sin reescalar. */
const LADO_IMAGEN = 1568;
/** Muestras por eje y por píxel al reducir la imagen; suaviza los bordes y mejora la lectura. */
const MUESTREO = 2;

type Matriz = [number, number, number, number, number, number];

interface ImagenPdf {
    width: number;
    height: number;
    /** 1: un bit por píxel, 2: RGB, 3: RGBA. */
    kind: number;
    data?: Uint8Array | Uint8ClampedArray;
}

export async function abrirPdf(bytes: Uint8Array): Promise<Documento> {
    const lib = await pdfjs();
    const carga = lib.getDocument({
        data: bytes,
        verbosity: 0,
        isOffscreenCanvasSupported: false,
        // Directo a los decodificadores JS de vendor/pdfjs/wasm: en Node los .wasm no cargan igual.
        useWasm: false,
        wasmUrl: new URL("wasm/", VENDOR).href,
    });
    const pdf = await carga.promise;

    return {
        formato: "pdf",
        unidad: "página",
        total: pdf.numPages,
        parte: async (n) => leerPagina(lib, await pdf.getPage(n)),
        cerrar: () => carga.destroy(),
    };
}

async function leerPagina(lib: PdfJs, pagina: PDFPageProxy): Promise<Parte> {
    const contenido = await pagina.getTextContent();
    let texto = "";
    for (const item of contenido.items) {
        if (!("str" in item)) continue;
        texto += item.str + (item.hasEOL ? "\n" : "");
    }
    texto = texto.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
    if (texto.length >= MIN_TEXTO) return { texto };

    const escaneo = await rasterizarImagenes(lib, pagina);
    if (escaneo) return { titulo: "escaneada, como imagen", imagen: escaneo, mimeType: "image/png" };
    return { texto: texto || "(página sin texto)" };
}

/**
 * Reconstruye la página dibujando solo sus imágenes, con la posición y rotación con que el PDF
 * las ubica. Una página escaneada es eso: una imagen. Así se evita un renderizador completo, que
 * en Node necesita un canvas nativo.
 */
async function rasterizarImagenes({ OPS, Util }: PdfJs, pagina: PDFPageProxy): Promise<Uint8Array | null> {
    const base = pagina.getViewport({ scale: 1 });
    const vista = pagina.getViewport({ scale: LADO_IMAGEN / Math.max(base.width, base.height) });
    const ancho = Math.round(vista.width);
    const alto = Math.round(vista.height);
    const lienzo = new Uint8Array(ancho * alto).fill(255);

    const ops = await pagina.getOperatorList();
    let ctm: Matriz = [1, 0, 0, 1, 0, 0];
    const pila: Matriz[] = [];
    let pintadas = 0;

    for (let i = 0; i < ops.fnArray.length; i++) {
        const args = ops.argsArray[i];
        switch (ops.fnArray[i]) {
            case OPS.save:
                pila.push(ctm);
                break;
            case OPS.restore:
                ctm = pila.pop() ?? ctm;
                break;
            case OPS.transform:
                ctm = Util.transform(ctm, args) as Matriz;
                break;
            case OPS.paintFormXObjectBegin:
                pila.push(ctm);
                if (args[0]) ctm = Util.transform(ctm, args[0]) as Matriz;
                break;
            case OPS.paintFormXObjectEnd:
                ctm = pila.pop() ?? ctm;
                break;
            case OPS.paintImageXObject:
            case OPS.paintInlineImageXObject: {
                const imagen: ImagenPdf =
                    typeof args[0] === "string" ? await new Promise((res) => pagina.objs.get(args[0], res)) : args[0];
                if (imagen?.data && pintar(lienzo, ancho, alto, imagen, Util.transform(vista.transform, ctm) as Matriz)) {
                    pintadas++;
                }
                break;
            }
        }
    }
    return pintadas ? pngGris(ancho, alto, lienzo) : null;
}

/**
 * Pinta una imagen en el lienzo. La imagen ocupa el cuadrado unitario transformado por `m`; por cada
 * píxel del lienzo se busca el píxel de origen con la transformación inversa, así cualquier rotación
 * o espejado sale bien sin casos especiales.
 */
function pintar(lienzo: Uint8Array, ancho: number, alto: number, img: ImagenPdf, m: Matriz): boolean {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) return false;
    const inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];

    const xs = [e, a + e, c + e, a + c + e];
    const ys = [f, b + f, d + f, b + d + f];
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(ancho, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(alto, Math.ceil(Math.max(...ys)));

    const { width: w, height: h, kind } = img;
    const data = img.data!;
    const bytesPorFila = (w + 7) >> 3;
    const canales = kind === 2 ? 3 : 4;
    const gris = (col: number, fila: number) => {
        if (kind === 1) return ((data[fila * bytesPorFila + (col >> 3)] >> (7 - (col & 7))) & 1) * 255;
        const i = (fila * w + col) * canales;
        return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    };

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            let suma = 0;
            let n = 0;
            for (let sy = 0; sy < MUESTREO; sy++) {
                for (let sx = 0; sx < MUESTREO; sx++) {
                    const px = x + (sx + 0.5) / MUESTREO;
                    const py = y + (sy + 0.5) / MUESTREO;
                    const u = inv[0] * px + inv[2] * py + inv[4];
                    const v = inv[1] * px + inv[3] * py + inv[5];
                    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
                    // En el espacio de la imagen v crece hacia arriba; las filas de datos, hacia abajo.
                    suma += gris(Math.floor(u * w), Math.floor((1 - v) * h));
                    n++;
                }
            }
            if (n) lienzo[y * ancho + x] = suma / n;
        }
    }
    return true;
}
