import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutogestionConnector, AutogestionSystem } from "../src/autogestion/client/connector.js";
import { StoredAutogestion } from "../src/autogestion/client/stored-session.js";
import type { SessionStore } from "../src/shared/store/session-store.js";

/**
 * El wrapper que el modo HTTP le da a las tools tiene que reenviar todos los métodos del conector.
 * En 0.9.3 faltaban `certificados` y `descargarCertificado`, y las tools de certificados contestaban
 * "todavía no tiene conector" aunque el conector sí los tenía.
 */

/** Un store en memoria: solo lo que StoredAutogestion usa. */
function fakeStore(): SessionStore & { saved: string[] } {
    let session: string | null = null;
    const saved: string[] = [];
    return {
        saved,
        loadSession: async () => session,
        saveSession: async (_userId, _platform, data) => {
            session = data;
            saved.push(data);
        },
    } as unknown as SessionStore & { saved: string[] };
}

/** Un conector con todo: certificados incluidos, como el sysacad-asp 0.3.0. */
function fakeConnector(): AutogestionConnector {
    return {
        systemId: "fake",
        login: async () => {},
        estadoAcademico: async () => [],
        correlatividades: async () => ({ cursar: [], rendir: [] }),
        certificados: async () => [{ nombre: "Certificado de Alumno Regular", referencia: "certalreg.asp?id=1-2" }],
        descargarCertificado: async (referencia) => ({
            contentType: "application/pdf",
            bytes: new TextEncoder().encode(`%PDF-fake:${referencia}`),
        }),
        exportSession: () => "cookies-falsas",
        restoreSession: () => {},
    };
}

const system: AutogestionSystem = {
    id: "fake",
    name: "Fake",
    regionales: ["frt"],
    create: () => fakeConnector(),
};

describe("StoredAutogestionSession (modo HTTP)", () => {
    it("reenvía certificados y descargarCertificado del conector, con el mismo guard que el resto", async () => {
        const store = fakeStore();
        const stored = new StoredAutogestion("http://127.0.0.1:3000", store, [system]);
        await store.saveSession(1, "autogestion", JSON.stringify({ systemId: "fake", session: "cookies-falsas" }));
        const savesAlSembrar = store.saved.length;

        const session = stored.forUser(1).sessionFor(system, "frt");
        const connector = await session.getConnector();

        const certs = await connector.certificados!();
        assert.equal(certs[0].referencia, "certalreg.asp?id=1-2");

        const descargado = await connector.descargarCertificado!("certalreg.asp?id=1-2");
        assert.equal(descargado.contentType, "application/pdf");
        assert.ok(new TextDecoder().decode(descargado.bytes).includes("certalreg.asp?id=1-2"));

        // El guard guarda la sesión después de cada pedido: uno por certificados y otro por la descarga.
        assert.equal(store.saved.length - savesAlSembrar, 2);
    });
});
