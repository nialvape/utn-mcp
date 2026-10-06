# utn-mcp

Servidor MCP que le da a un agente acceso a los sistemas de la UTN FRBA. Corre local por STDIO (`npx utn-mcp`) y va a correr hosteado y multiusuario en utnmcp.com.ar. Lo que hay hoy funciona bien: para algo nuevo, copiá cómo está hecho `src/aula-virtual/`.

## Distribución de módulos

```
src/
  index.ts          CLI: elige STDIO, --http o `login`
  http.ts           entrada HTTP
  server.ts         createServer(session): registra las tools de cada plataforma
  shared/           lo que sirve a más de una plataforma (http, html, documents, logger, paths, input)
  <plataforma>/
    tools.ts        registro de las tools MCP
    client/         habla con la plataforma: sesión, login, requests, tipos de sus respuestas
    format/         arma lo que ve el modelo, usando el cliente
    login.ts        el subcomando `utn-mcp login` de esa plataforma
```

Cada capa tiene un solo trabajo y las dependencias van en una sola dirección: `tools.ts` → `format/` → `client/` → `shared/`.

- **`tools.ts`** exporta `register<Plataforma>Tools(server, session)`. Cada tool es nombre, descripción, schema zod y una llamada a `format/`. La lógica va en las otras capas.
- **`client/`** conoce la plataforma y nada más: no importa de MCP ni sabe que existe un modelo. Expone funciones finas sobre la API (`getCourseSections`, `callWs`, `fetchFile`) y en `types.ts` tipa solo los campos que usamos. Si el cliente es chico, alcanza con un solo `client.ts`.
- **`format/`** decide qué ve el modelo y cuánto le cuesta: direcciones de navegación, recortes, fechas, presupuestos de texto, paginación.
- Las plataformas no se importan entre sí. Lo que compartan va a `shared/`.
- Para agregar una plataforma: creá la carpeta con esta forma y sumá una línea en `server.ts`.

## Sesión y multiusuario

El servidor va a atender a muchos alumnos a la vez, así que el estado de autenticación nunca es global. Cada función que toca la plataforma recibe la sesión del usuario como primer parámetro (`AulaSession`), y `createServer` la recibe de afuera. `LocalSession` es la implementación del modo local; el modo hosteado va a tener la suya.

El token del usuario no sale nunca del servidor. Al modelo y al usuario les llegan URLs que se abren con la sesión del navegador (`urlParaUsuario`). Antes de mandar el token a una URL que vino del modelo, validá que sea de la plataforma (`urlDeDescarga`).

## Diseño de las tools

- **Nombres**: `<plataforma>_<acción>` en snake_case (`aula_open`, `aula_read_file`).
- **Descripciones**: en castellano y escritas para el modelo. Dicen cuándo usar la tool, de dónde sale cada parámetro (otra respuesta, otra tool) y qué campos de la respuesta sirven para seguir. Cada `.describe()` de zod trae un ejemplo concreto.
- **Navegación sin estado**: cada respuesta trae la `direccion` de lo que hay adentro y el `padre`. El modelo navega devolviendo direcciones; nunca tiene que armarlas.
- **Índices resumidos, detalle al abrir**: un listado muestra lo justo para decidir si entrar (`htmlToSnippet`) y el contenido completo se ve al abrir el elemento.
- **Presupuesto por respuesta**: lo que puede ser largo se corta con un presupuesto y avisa cómo seguir (`siguiente`, `hayMasDiscusiones`).
- **Respuestas**: JSON compacto mediante `json()` y errores con `failure()`. Cada handler es `try { return json(...) } catch (e) { return failure(e) }`.

## Convenciones de código

- **Campos de respuesta** en castellano y camelCase (`ultimoAcceso`, `nombreCorto`). Un campo vacío se omite con `|| undefined`, así no ocupa lugar en el JSON. Las fechas van en ISO (`isoDate`).
- **Idioma de los identificadores**: `client/` usa el vocabulario de la plataforma, en inglés (`getUserCourses`, `courseId`); `format/` y `shared/documents` están en castellano (`leerArchivo`, `verCurso`). Seguí el idioma de los archivos vecinos.
- **Texto para personas y para el modelo** (comentarios, errores, descripciones, logs) en castellano rioplatense con voseo: "corré `utn-mcp login`", "No tenés acceso al módulo".
- **Errores accionables**: el mensaje dice qué hacer después. Por ejemplo, los formatos válidos de una dirección, el comando de login o la URL para bajar el archivo. Los errores propios son clases con `name` (`MoodleError`, `LoginRequiredError`).
- **Comentarios**: JSDoc de una línea, o poco más, que explica el porqué o un dato de la plataforma ("Con `cmid` Moodle devuelve igual todas las secciones…"). Las constantes llevan su unidad o su origen.
- **Logs**: siempre con `logger` de `shared/logger.ts`. Escribe a stderr porque stdout es el canal STDIO del protocolo.
- **Imports**: ESM con extensión `.js` (`./client/client.js`), por `module: Node16`.
- **Token de Moodle**: el flujo se describe como "flujo de launch.php" o "token del web service". El identificador `moodle_mobile_app` queda tal cual, porque es el nombre real del servicio.
- **pdf.js**: se carga desde `vendor/pdfjs/` (lo genera `scripts/vendor-pdfjs.mjs`). `pdfjs-dist` es devDependency y se importa solo para tipos.

## Verificar y publicar

- No hay tests. Verificá con `npx tsc --noEmit` y probá contra el aula real con `npm run dev` (hace falta `npm run login` una vez).
- Cuando agregues o cambies una tool, actualizá la tabla de tools del `README.md`.
- La versión está en dos lugares: `package.json` y el `version` de `src/server.ts`. Se suben juntas.
