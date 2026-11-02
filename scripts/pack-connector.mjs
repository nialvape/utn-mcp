// Arma el .tgz de un conector de packages/ para adjuntarlo a un release y muestra su hash.
// Uso: node scripts/pack-connector.mjs sysacad-asp
// El hash y la URL van a CATALOG en src/autogestion/client/catalog.ts; el login instala solo ese archivo exacto.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const id = process.argv[2];
if (!id) {
    console.error("Uso: node scripts/pack-connector.mjs <carpeta de packages/>, por ejemplo sysacad-asp");
    process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages", id);
const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const out = join(root, "build-connectors");
const run = (command, cwd) => execSync(command, { cwd, stdio: "inherit" });

// El conector toma los tipos de las declaraciones compiladas del core.
run("npm run build", root);
rmSync(join(dir, "build"), { recursive: true, force: true });
run("npx tsc -p .", dir);
mkdirSync(out, { recursive: true });
run(`npm pack --pack-destination "${out}"`, dir);

const file = `${name}-${version}.tgz`;
const integrity = `sha512-${createHash("sha512").update(readFileSync(join(out, file))).digest("base64")}`;
const tag = `${id}-v${version}`;
console.log(`
Archivo:   build-connectors/${file}
version:   "${version}"
tarball:   \`\${RELEASES}/${tag}/${file}\`
integrity: "${integrity}"

Para publicarlo:
  gh release create ${tag} build-connectors/${file} --title "${name} ${version}" --notes "Conector ${name} ${version}."
`);
