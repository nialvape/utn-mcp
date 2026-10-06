# utn-mcp

MCP server that gives an agent access to UTN FRBA's systems. It runs locally over STDIO (`npx utn-mcp`) and will run hosted and multi-user at utnmcp.com.ar. What exists today works well: for something new, copy how `src/aula-virtual/` is built.

## Module layout

```
src/
  index.ts          CLI: picks STDIO, --http or `login`
  http.ts           HTTP entry point
  server.ts         createServer(session): registers each platform's tools
  shared/           what serves more than one platform (http, html, documents, logger, paths, input)
  <platform>/
    tools.ts        MCP tool registration
    client/         talks to the platform: session, login, requests, types of its responses
    format/         builds what the model sees, using the client
    login.ts        that platform's `utn-mcp login` subcommand
```

Each layer has a single job and dependencies go in one direction only: `tools.ts` → `format/` → `client/` → `shared/`.

- **`tools.ts`** exports `register<Platform>Tools(server, session)`. Each tool is a name, a description, a zod schema and a call into `format/`. Logic goes in the other layers.
- **`client/`** knows the platform and nothing else: it doesn't import from MCP or know a model exists. It exposes thin functions over the API (`getCourseSections`, `callWs`, `fetchFile`) and in `types.ts` types only the fields we use. If the client is small, a single `client.ts` is enough.
- **`format/`** decides what the model sees and how much it costs: navigation addresses, truncation, dates, text budgets, pagination.
- Platforms don't import from each other. Whatever they share goes in `shared/`.
- To add a platform: create the folder with this shape and add one line to `server.ts`.

## Session and multi-user

The server will serve many students at once, so authentication state is never global. Every function that touches the platform receives the user's session as its first parameter (`AulaSession`), and `createServer` receives it from outside. `LocalSession` is the local-mode implementation; hosted mode will have its own.

The user's token never leaves the server. The model and the user get URLs that open with the browser session (`userFacingUrl`). Before sending the token to a URL that came from the model, validate that it belongs to the platform (`downloadUrl`).

## Tool design

- **Names**: `<platform>_<action>` in snake_case (`aula_open`, `aula_read_file`).
- **Descriptions**: in Spanish and written for the model. They say when to use the tool, where each parameter comes from (another response, another tool) and which response fields are useful to continue. Every zod `.describe()` includes a concrete example.
- **Stateless navigation**: each response carries the `direccion` of what's inside and the `padre`. The model navigates by passing addresses back; it never has to build them.
- **Summarized indexes, detail on open**: a listing shows just enough to decide whether to go in (`htmlToSnippet`) and the full content is shown when the item is opened.
- **Per-response budget**: anything that can be long is cut with a budget and says how to continue (`siguiente`, `hayMasDiscusiones`).
- **Responses**: compact JSON via `json()` and errors via `failure()`. Every handler is `try { return json(...) } catch (e) { return failure(e) }`.

## Code conventions

- **Response fields** in Spanish and camelCase (`ultimoAcceso`, `nombreCorto`). An empty field is omitted with `|| undefined`, so it takes no space in the JSON. Dates are ISO (`isoDate`).
- **Identifier language**: all code identifiers are in English: variables, functions, types, constants and file names (`getUserCourses`, `viewCourse`, `readAulaFile`, `format/activities.ts`). In `client/` they follow the platform's vocabulary (`courseId`, `cmid`). What the model sees stays in Spanish: response fields, tool parameters and string values (`direccion`, `ultimoAcceso`, the `unidad` "página"). When an object's keys reach the model, they stay in Spanish even inside internal code (`FileRead`).
- **Text for people and for the model** (comments, errors, descriptions, logs) in Rioplatense Spanish with voseo: "corré `utn-mcp login`", "No tenés acceso al módulo".
- **Actionable errors**: the message says what to do next. For example, the valid address formats, the login command or the URL to download the file. Our own errors are classes with a `name` (`MoodleError`, `LoginRequiredError`).
- **Comments**: one-line JSDoc, or a little more, explaining the why or a platform fact ("Con `cmid` Moodle devuelve igual todas las secciones…"). Constants state their unit or their origin.
- **Logs**: always through `logger` from `shared/logger.ts`. It writes to stderr because stdout is the protocol's STDIO channel.
- **Imports**: ESM with the `.js` extension (`./client/client.js`), because of `module: Node16`.
- **Moodle token**: the flow is described as the "launch.php flow" or "web service token". The `moodle_mobile_app` identifier stays as is, because it's the service's real name.
- **pdf.js**: loaded from `vendor/pdfjs/` (generated by `scripts/vendor-pdfjs.mjs`). `pdfjs-dist` is a devDependency and is imported for types only.

## Verify and publish

- There are no tests. Verify with `npx tsc --noEmit` and try it against the real aula with `npm run dev` (requires `npm run login` once).
- When you add or change a tool, update the tools table in `README.md`.
- The version lives in two places: `package.json` and the `version` in `src/server.ts`. They are bumped together.
