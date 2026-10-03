# UTN-MCP — El puente entre tu agente y los sistemas de la Universidad.
Este es el Model Context Protocol server NO OFICIAL de la UTN. Con él podrás pedirle a tu agente de preferencia (ChatGPT, Claude, etc.) que busque informacion o archivos en el aula virtual.

## Features
Actualmente solamente tiene dos tools, aula_get_site_info() y aula_list_courses(). Ya se incorporarán más!

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

## Aviso
Este proyecto no está afiliado ni avalado por la UTN. Usalo bajo tu responsabilidad.
