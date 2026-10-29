# Sysacad FRT connector

Optional read-only connector for UTN Facultad Regional Tucuman, classic ASP Sysacad at https://sysacad.frt.utn.edu.ar. Not sysacad2 and not other regionals. No registrations, withdrawals or academic changes.

Exports `ConnectorsSystem = { "sysacad-asp": ["frt"] }` and an `AutogestionSystem` descriptor. It supports academic status, prerequisites, current subjects and final-exam history. Parsers belong to this package.

This package is not published. Build and install it from this checkout using the root README. Configure `UTN_MCP_CONNECTORS=utn-mcp-sysacad-frt` and run `utn-mcp login autogestion` from the environment where both packages are installed. The core still works without this package.

Credentials are stored by the core in the OS keychain or supplied as `SYSACAD_ASP_USER` and `SYSACAD_ASP_PASS`. Autogestion only works in local STDIO mode. No real student data is included.
