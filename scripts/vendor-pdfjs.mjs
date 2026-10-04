// Copia de pdfjs-dist solo lo que usa el servidor a vendor/pdfjs, que se publica con el paquete.
// pdfjs-dist queda como devDependency: quien instala utn-mcp no baja pdf.js entero ni su
// dependencia opcional de canvas nativo (~37 MB), que no usamos.
// Corre en `prepare`: con cada `npm install` dentro del repo y antes de publicar.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const origen = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const destino = join(raiz, "vendor", "pdfjs");

const ARCHIVOS = [
    "LICENSE",
    "legacy/build/pdf.mjs",
    "legacy/build/pdf.worker.mjs",
    // Decodificadores de imágenes escaneadas (JBIG2, JPEG 2000) en JS: en Node pdf.js no logra
    // cargar las versiones .wasm y cae a estas.
    "wasm/jbig2_nowasm_fallback.js",
    "wasm/openjpeg_nowasm_fallback.js",
    "wasm/LICENSE_PDFJS_JBIG2",
    "wasm/LICENSE_PDFJS_OPENJPEG",
];

rmSync(destino, { recursive: true, force: true });
for (const archivo of ARCHIVOS) {
    const hacia = join(destino, archivo.replace(/^legacy\/build\//, ""));
    mkdirSync(dirname(hacia), { recursive: true });
    copyFileSync(join(origen, archivo), hacia);
}
console.error(`pdf.js copiado a vendor/pdfjs (${ARCHIVOS.length} archivos)`);
