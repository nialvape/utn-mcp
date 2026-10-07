import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import type { ParsedDocument, Part } from "./index.js";
import { grayscalePng } from "./png.js";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * pdf.js no es una dependencia: scripts/vendor-pdfjs.mjs copia a vendor/pdfjs los pocos archivos que
 * usamos. Está a la misma altura desde src/ y desde build/, así que la ruta sirve en dev y publicado.
 */
const VENDOR = new URL("../../../vendor/pdfjs/", import.meta.url);

/** Al arrancar en Node, pdf.js avisa que le falta canvas para renderizar. No renderizamos: son ruido en el log. */
const CANVAS_WARNINGS = /@napi-rs\/canvas|Cannot polyfill/;

let pdfjsLoading: Promise<PdfJs> | undefined;

/** Se carga recién al primer PDF: son 3 MB que el servidor no necesita para arrancar. */
function pdfjs(): Promise<PdfJs> {
    pdfjsLoading ??= (async () => {
        const warn = console.warn;
        console.warn = (...args: unknown[]) => {
            if (!CANVAS_WARNINGS.test(String(args[0]))) warn(...args);
        };
        try {
            return (await import(new URL("pdf.mjs", VENDOR).href)) as PdfJs;
        } finally {
            console.warn = warn;
        }
    })();
    return pdfjsLoading;
}

/** Menos texto que esto en una página la tratamos como escaneada. */
const MIN_TEXT_CHARS = 20;
/** Lado largo de la imagen de una página: el tamaño que Claude procesa sin reescalar. */
const IMAGE_LONG_SIDE = 1568;
/** Muestras por eje y por píxel al reducir la imagen; suaviza los bordes y mejora la lectura. */
const SUPERSAMPLING = 2;
/** Cuánto esperar una imagen ya decodificada antes de seguir sin ella, en milisegundos. */
const IMAGE_WAIT_MS = 10_000;

type Matrix = [number, number, number, number, number, number];

interface PdfImage {
    width: number;
    height: number;
    /** 1: un bit por píxel, 2: RGB, 3: RGBA. */
    kind: number;
    data?: Uint8Array | Uint8ClampedArray;
}

export async function openPdf(bytes: Uint8Array): Promise<ParsedDocument> {
    const lib = await pdfjs();
    const loadingTask = lib.getDocument({
        data: bytes,
        verbosity: 0,
        isOffscreenCanvasSupported: false,
        // Directo a los decodificadores JS de vendor/pdfjs/wasm: en Node los .wasm no cargan igual.
        useWasm: false,
        wasmUrl: new URL("wasm/", VENDOR).href,
    });
    const pdf = await loadingTask.promise;

    return {
        format: "pdf",
        unit: "página",
        total: pdf.numPages,
        part: async (n) => readPage(lib, await pdf.getPage(n)),
        close: () => loadingTask.destroy(),
    };
}

async function readPage(lib: PdfJs, page: PDFPageProxy): Promise<Part> {
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
    }
    text = text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
    if (text.length >= MIN_TEXT_CHARS) return { text };

    const scan = await rasterizeImages(lib, page);
    if (scan) return { title: "escaneada, como imagen", image: scan, mimeType: "image/png" };
    return { text: text || "(página sin texto)" };
}

/**
 * Reconstruye la página dibujando solo sus imágenes, con la posición y rotación con que el PDF
 * las ubica. Una página escaneada es eso: una imagen. Así se evita un renderizador completo, que
 * en Node necesita un canvas nativo.
 */
async function rasterizeImages({ OPS, Util }: PdfJs, page: PDFPageProxy): Promise<Uint8Array | null> {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: IMAGE_LONG_SIDE / Math.max(base.width, base.height) });
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    const canvas = new Uint8Array(width * height).fill(255);

    const ops = await page.getOperatorList();
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    let painted = 0;

    for (let i = 0; i < ops.fnArray.length; i++) {
        const args = ops.argsArray[i];
        switch (ops.fnArray[i]) {
            case OPS.save:
                stack.push(ctm);
                break;
            case OPS.restore:
                ctm = stack.pop() ?? ctm;
                break;
            case OPS.transform:
                ctm = Util.transform(ctm, args) as Matrix;
                break;
            case OPS.paintFormXObjectBegin:
                stack.push(ctm);
                if (args[0]) ctm = Util.transform(ctm, args[0]) as Matrix;
                break;
            case OPS.paintFormXObjectEnd:
                ctm = stack.pop() ?? ctm;
                break;
            case OPS.paintImageXObject:
            case OPS.paintInlineImageXObject: {
                const image = typeof args[0] === "string" ? await imageObject(page, args[0]) : (args[0] as PdfImage);
                if (image?.data && paint(canvas, width, height, image, Util.transform(viewport.transform, ctm) as Matrix)) {
                    painted++;
                }
                break;
            }
        }
    }
    return painted ? grayscalePng(width, height, canvas) : null;
}

/**
 * Las imágenes que se repiten entre páginas (ids "g_...") pdf.js las guarda en `commonObjs`, no en los
 * objetos de la página; su propio renderizador elige así. Buscarlas en `objs` espera para siempre.
 * Con el tope, una imagen que no llega deja la página sin ella en vez de colgar la lectura.
 */
async function imageObject(page: PDFPageProxy, id: string): Promise<PdfImage | null> {
    const store = id.startsWith("g_") ? page.commonObjs : page.objs;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            new Promise<PdfImage>((resolve) => store.get(id, resolve)),
            new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), IMAGE_WAIT_MS))),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Pinta una imagen en el lienzo. La imagen ocupa el cuadrado unitario transformado por `m`; por cada
 * píxel del lienzo se busca el píxel de origen con la transformación inversa, así cualquier rotación
 * o espejado sale bien sin casos especiales.
 */
function paint(canvas: Uint8Array, width: number, height: number, img: PdfImage, m: Matrix): boolean {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) return false;
    const inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];

    const xs = [e, a + e, c + e, a + c + e];
    const ys = [f, b + f, d + f, b + d + f];
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(width, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(height, Math.ceil(Math.max(...ys)));

    const { width: w, height: h, kind } = img;
    const data = img.data!;
    const bytesPerRow = (w + 7) >> 3;
    const channels = kind === 2 ? 3 : 4;
    const gray = (col: number, row: number) => {
        if (kind === 1) return ((data[row * bytesPerRow + (col >> 3)] >> (7 - (col & 7))) & 1) * 255;
        const i = (row * w + col) * channels;
        return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    };

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            let sum = 0;
            let n = 0;
            for (let sy = 0; sy < SUPERSAMPLING; sy++) {
                for (let sx = 0; sx < SUPERSAMPLING; sx++) {
                    const px = x + (sx + 0.5) / SUPERSAMPLING;
                    const py = y + (sy + 0.5) / SUPERSAMPLING;
                    const u = inv[0] * px + inv[2] * py + inv[4];
                    const v = inv[1] * px + inv[3] * py + inv[5];
                    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
                    // En el espacio de la imagen v crece hacia arriba; las filas de datos, hacia abajo.
                    sum += gray(Math.floor(u * w), Math.floor((1 - v) * h));
                    n++;
                }
            }
            if (n) canvas[y * width + x] = sum / n;
        }
    }
    return true;
}
