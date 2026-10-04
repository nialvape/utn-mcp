# UTN-MCP — El puente entre tu agente y los sistemas de la Universidad.
Este es el Model Context Protocol server NO OFICIAL de la UTN. Con él podrás pedirle a tu agente de preferencia (ChatGPT, Claude, etc.) que busque informacion o archivos en el aula virtual.

## Qué podés pedirle
- *"¿Cuándo es el recuperatorio del primer parcial de Álgebra?"*
- *"¿Qué avisó la profesora de Física esta semana?"*
- *"Resumime la guía de la unidad 3 de Sistemas Operativos."*
- *"Pasame el link para bajar el apunte de calorimetría."*

El agente recorre el aula como lo harías vos: entra al curso, mira los foros y abre los archivos que hagan falta.

## Tools
| Tool | Qué hace |
|---|---|
| `aula_list_courses` | Lista tus cursos. Es el punto de partida. |
| `aula_open` | Entra a un curso, un módulo, un foro o una discusión. Cada respuesta trae las direcciones de lo que hay adentro y de un nivel más arriba, así el agente navega sin perderse. |
| `aula_read_file` | Lee un archivo del aula, por partes cuando es largo. |
| `aula_get_site_info` | Datos de tu usuario en el aula virtual. |

### Archivos que puede leer
- **PDF**: el texto, página por página. Los **escaneados** se mandan como imagen de cada página, y el agente los lee igual.
- **Word (.docx), PowerPoint (.pptx) y Excel (.xlsx)**: el texto, con las tablas fila por fila.
- **Imágenes** (PNG, JPG, GIF) y texto plano.

Los formatos viejos de Office (.doc, .ppt, .pps), los comprimidos (.zip, .rar) y los videos no se leen. En ese caso el agente te pasa el link para que lo bajes.

### Links de descarga
Cada archivo viene con un link del aula virtual que podés abrir en tu navegador. Funciona con tu sesión del aula (si no estás logueado te manda al login) y **nunca incluye tu token**: ese queda siempre en tu computadora.

## Cómo instalar
Necesitás [Node.js](https://nodejs.org) 20 o superior. No hace falta clonar el repo ni instalar nada a mano: `npx` descarga el paquete solo.

### 1. Iniciar sesión
```bash
npx -y utn-mcp login
```
Te pide tu usuario institucional y tu contraseña de la UTN (los mismos de "Usuarios Institucionales" en el aula virtual). Se hace una sola vez: después el servidor renueva la sesión solo.

### 2. Agregarlo a tu cliente

**Claude Code**
```bash
claude mcp add utn -- npx -y utn-mcp
```

**Claude Desktop**: en *Settings → Developer → Edit Config*, agregá dentro de `mcpServers`:
```json
"utn": {
  "command": "npx",
  "args": ["-y", "utn-mcp"]
}
```
En Windows, si no arranca, usá `"command": "cmd"` y `"args": ["/c", "npx", "-y", "utn-mcp"]`. Después reiniciá Claude Desktop por completo.

**Otros clientes (Cursor, VS Code, etc.)**: cualquier cliente MCP que lance servidores por STDIO sirve con el comando `npx -y utn-mcp`.

### Instalación global (opcional)
Si preferís tener el comando `utn-mcp` siempre disponible:
```bash
npm i -g utn-mcp
utn-mcp login
```
y en la config del cliente usás `"command": "utn-mcp"` sin argumentos.

### Modo HTTP (opcional)
```bash
npx -y utn-mcp --http --port 3000
```
Levanta el servidor en `http://127.0.0.1:3000/mcp`, solo accesible desde tu propia máquina. Tenés que dejar la terminal abierta mientras lo uses.

## Dónde se guardan tus datos
Todo queda en tu computadora:
- **Usuario y contraseña**: en el gestor de credenciales del sistema (Windows Credential Manager, Keychain en macOS, Secret Service en Linux).
- **Token del aula virtual y cookies de sesión**: en `%APPDATA%\utn-mcp\session.json` (Windows) o `~/.config/utn-mcp/session.json` (Linux y macOS).

En Linux sin gestor de credenciales (servidores, Docker, WSL) podés definir las variables de entorno `UTN_USER` y `UTN_PASS` en lugar de usar `login`.

## Desarrollo
```bash
git clone https://github.com/nialvape/utn-mcp.git
cd utn-mcp
npm install
npm run login   # una vez
npm run dev     # servidor por STDIO desde src/, con tsx
npm run build   # compila a build/
```

pdf.js no es una dependencia del paquete publicado. Está como `devDependency`, y `npm install` corre el script `prepare`, que copia a `vendor/pdfjs/` solo los archivos que usa el servidor (~4 MB). Así, quien instala `utn-mcp` no baja pdf.js entero ni su canvas nativo opcional (~37 MB). Si instalaste con `--ignore-scripts`, generalo a mano con `npm run prepare`.

## Aviso
Este proyecto no está afiliado ni avalado por la UTN. Usalo bajo tu responsabilidad.
