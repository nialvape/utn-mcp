import { existsSync } from "node:fs";

// Se evalúa antes que el resto de los módulos: así las variables del `.env` (como UTN_REGIONAL)
// están definidas desde que arranca el proceso.
if (existsSync(".env")) process.loadEnvFile(".env");
