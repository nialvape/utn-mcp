/**
 * Los colores del sitio del proyecto: papel milimetrado, tinta y un azul de acento. Oscuro salvo que
 * el sistema pida claro. Sin fuentes externas: la página de login recibe contraseñas.
 */
const STYLE = `
:root{--paper:#0a0b0d;--ink:#e9e7e0;--muted:#8b8a84;--line:rgb(233 231 224/.055);--line-faint:rgb(233 231 224/.025);
--line-strong:rgb(233 231 224/.16);--accent:#6b93ff;--err:#f87171;--panel:rgb(20 21 24/.6);color-scheme:dark}
@media(prefers-color-scheme:light){:root{--paper:#f3f2ec;--ink:#121212;--muted:#6d6c66;--line:rgb(18 18 18/.07);
--line-faint:rgb(18 18 18/.035);--line-strong:rgb(18 18 18/.2);--accent:#1f4fd6;--err:#b91c1c;--panel:rgb(255 255 255/.55);color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
background-color:var(--paper);background-image:linear-gradient(var(--line) 1px,transparent 1px),
linear-gradient(90deg,var(--line) 1px,transparent 1px),linear-gradient(var(--line-faint) 1px,transparent 1px),
linear-gradient(90deg,var(--line-faint) 1px,transparent 1px);background-size:80px 80px,80px 80px,16px 16px,16px 16px;
background-position:-1px -1px}
.mono,label,button,.kicker,header{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;align-items:center;gap:.5rem;height:3.5rem;padding:0 1rem;border-bottom:1px solid var(--line);
font-size:13px;letter-spacing:-.01em;background:color-mix(in srgb,var(--paper) 75%,transparent)}
header svg{height:1.5rem;width:auto}
main{max-width:28rem;margin:3rem auto;padding:0 1rem}
.card{position:relative;border:1px solid var(--line-strong);background:var(--panel);padding:1.5rem}
.card::before,.card::after{content:"";position:absolute;width:9px;height:9px;border-color:var(--ink);opacity:.55}
.card::before{top:-1px;left:-1px;border-top:1px solid;border-left:1px solid}
.card::after{bottom:-1px;right:-1px;border-bottom:1px solid;border-right:1px solid}
.kicker{margin:0 0 .5rem;font-size:10px;text-transform:uppercase;letter-spacing:.16em;color:var(--muted)}
h1{margin:0 0 1rem;font-size:1.5rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
p{margin:.75rem 0}
a{color:var(--accent);text-underline-offset:4px}
form{display:flex;flex-direction:column;gap:1rem;margin:1.5rem 0}
label{display:flex;flex-direction:column;gap:.4rem;font-size:10px;text-transform:uppercase;letter-spacing:.16em;color:var(--muted)}
input,select{font:inherit;font-size:15px;letter-spacing:normal;text-transform:none;color:var(--ink);background:transparent;
border:1px solid var(--line-strong);border-radius:0;padding:.65rem .75rem}
input:focus,select:focus{outline:none;border-color:var(--accent)}
select option{background:var(--paper);color:var(--ink)}
input[type=file]{padding:.5rem}
button{font-size:12px;text-transform:uppercase;letter-spacing:.14em;border:0;border-radius:0;padding:.8rem 1rem;
background:var(--ink);color:var(--paper);cursor:pointer;transition:background .15s}
button:hover{background:var(--accent)}
.nota{font-size:13px;color:var(--muted)}
.error{border-left:2px solid var(--err);padding-left:.75rem;color:var(--err)}
.aviso{border:1px solid var(--err);padding:0 1rem;margin:1rem 0}
label.acepto{flex-direction:row;align-items:flex-start;gap:.6rem;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;
text-transform:none;letter-spacing:normal;color:var(--ink)}
input[type=checkbox],input[type=radio]{padding:0;margin:.2rem 0 0;accent-color:var(--accent)}
.numero{margin:1rem 0;font:600 2.5rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center}
ul{padding-left:1.2rem}
::selection{background:var(--accent);color:var(--paper)}
`.replace(/\n/g, "");

/** El emblema del proyecto: el de la UTN con "MCP" en lugar de "UTN". */
const MARK =
    '<svg viewBox="0 0 100 132" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="11">' +
    '<path d="M50 0v100M0 50h100"/><path d="M19 0v19a11 11 0 0 0 11 11h40a11 11 0 0 0 11-11V0"/>' +
    '<path d="M19 100V81a11 11 0 0 1 11-11h40a11 11 0 0 1 11 11v19"/></g>' +
    '<text x="50" y="131" text-anchor="middle" textLength="72" lengthAdjust="spacingAndGlyphs" ' +
    'font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="29" fill="currentColor">MCP</text></svg>';

/**
 * Página mínima con el estilo del sitio del proyecto: se abre desde el celu, así que nada más que lo necesario.
 * `kicker` es la etiqueta chica arriba del título.
 */
export function page(title: string, body: string, kicker = "UTN-MCP"): string {
    return (
        `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · UTN-MCP</title>` +
        `<style>${STYLE}</style></head><body>` +
        `<header>${MARK}utn·mcp</header>` +
        `<main><div class="card"><p class="kicker">${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1>${body}</div></main>` +
        `</body></html>`
    );
}

export const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
