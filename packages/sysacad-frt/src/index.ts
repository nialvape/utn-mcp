import type { AutogestionSystem } from "utn-mcp/autogestion";
import { SysacadAspConnector } from "./sysacad-asp.js";

export const ConnectorsSystem = { "sysacad-asp": ["frt"] };

const system: AutogestionSystem = {
    id: "sysacad-asp",
    name: "SYSACAD (ASP clásico, FRT)",
    support: "verified",
    regionales: ConnectorsSystem["sysacad-asp"],
    create: () => new SysacadAspConnector(),
};

export default system;
