# Conector Sysacad (ASP) de utn-mcp

Conector de solo lectura para el SysacadWEB clásico (ASP), el mismo sistema de autogestión de alumnos en la mayoría de las regionales de la UTN. Da el estado académico, la cursada actual, el historial de finales y las correlatividades para cursar y para rendir. No inscribe, no da de baja ni cambia nada.

No se instala a mano: `utn-mcp login` lo baja de un release del repo cuando tu regional lo usa (ver el README principal).

## Cómo funciona

- **Regionales**: `src/regionals.ts` tiene la URL del login de cada regional y lo que cambia entre ellas: qué va como usuario y el largo máximo de la clave. Todavía no entró nadie con esta versión. En FRT anduvo con cuenta real la anterior, que posteaba directo a `menuAlumno.asp`.
- **Login**: lee el formulario de alumnos de la página de login (el que tiene el campo `legajo`) y postea a su `action` con todos sus campos, más legajo y contraseña. Así cubre los campos ocultos de algunas regionales (`urlHash`, `csrf_token`) sin código por regional.
- **Sesión**: la cookie `ASPSESSIONID…` y, donde aparece, el `?id=` de las URL del menú. Si una página vuelve al login, la sesión venció: se loguea de nuevo una vez y se reintenta.
- **Páginas**: no se fijan rutas. Se siguen los enlaces del menú por su texto ("Estado académico", "Correlatividad para cursar"…), y si uno no aparece, el error lista las opciones que muestra el menú.

Del core importa solo tipos (`utn-mcp/autogestion`, resuelto en `tsconfig.json` a las declaraciones compiladas). Las clases de error y `htmlToText` se las pasa el core en `create`.

## Compilarlo

Desde la raíz del repo: `node scripts/pack-connector.mjs sysacad-asp`. Compila el core (por las declaraciones de tipos), compila el conector y arma el `.tgz`.
