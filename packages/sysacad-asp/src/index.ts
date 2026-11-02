import type { AutogestionSystem } from "utn-mcp/autogestion";
import { SysacadAspConnector } from "./connector.js";
import { ASP_REGIONALS } from "./regionals.js";

const system: AutogestionSystem = {
    id: "sysacad-asp",
    name: "Sysacad",
    regionales: Object.keys(ASP_REGIONALS),
    usernameHint: (regionalId) => ASP_REGIONALS[regionalId]?.usernameHint,
    create(regionalId, kit) {
        const regional = ASP_REGIONALS[regionalId];
        if (!regional) throw new Error(`Sysacad ASP no atiende la regional ${regionalId}.`);
        return new SysacadAspConnector(regional, kit);
    },
};

export default system;
