import { describe, it, expect } from "vitest";
import { PromptInjector } from "../../src/retriever/utilities/filters/prompt-injector.js";
import type { ContextChunk } from "../../src/retriever/models/strategies/types.js";

describe("PromptInjector", () => {
  const injector = new PromptInjector();

  function chunk(nodeId: string, score: number, text: string, source = "BM25"): ContextChunk {
    return { chunkId: nodeId, nodeId, score, text, source };
  }

  describe("inject", () => {
    it("inyecta chunks en una sección separada del prompt", () => {
      const prompt = "Refactoriza OrderService";
      const chunks = [chunk("OrderService", 0.9, "class OrderService {}")];

      const result = injector.inject(prompt, chunks);
      expect(result).toContain("### Contexto del Proyecto");
      expect(result).toContain("class OrderService {}");
      expect(result).toContain(prompt);
    });

    it("mantiene el prompt original intacto", () => {
      const prompt = "crea un endpoint";
      const chunks = [chunk("A", 0.5, "texto")];

      const result = injector.inject(prompt, chunks);
      expect(result.endsWith(prompt)).toBe(true);
    });

    it("no inyecta nada si chunks está vacío", () => {
      const prompt = "pregunta simple";
      const result = injector.inject(prompt, []);
      expect(result).toBe(prompt);
    });

    it("enumera múltiples chunks con numeración", () => {
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, "class A {}"),
        chunk("B", 0.8, "function b() {}"),
      ];

      const result = injector.inject("refactoriza", chunks);
      expect(result).toContain("[1]");
      expect(result).toContain("[2]");
      expect(result).toContain("class A {}");
      expect(result).toContain("function b() {}");
    });

    it("lanza error si la versión del template no existe", () => {
      expect(() => injector.inject("prompt", [], "v999")).toThrow("desconocido");
    });
  });

  describe("template v2", () => {
    it("renderiza el cuerpo en un fence ts con el rango de líneas", () => {
      const withBody: ContextChunk = {
        ...chunk("dom.ts#set_attribute", 0.9, "function set_attribute() {\n  node.setAttribute();\n}"),
        location: { filepath: "/repo/dom.ts", startLine: 142, endLine: 168, truncated: false },
      };

      const result = injector.inject("arregla set_attribute", [withBody], "v2");
      expect(result).toContain("(L142–L168)");
      expect(result).toContain("```ts");
      expect(result).toContain("node.setAttribute();");
    });

    it("marca los chunks recortados", () => {
      const truncated: ContextChunk = {
        ...chunk("big.ts#huge", 0.9, "// … [50 líneas omitidas] …"),
        location: { filepath: "/repo/big.ts", startLine: 1, endLine: 200, truncated: true },
      };

      const result = injector.inject("q", [truncated], "v2");
      expect(result).toContain("(L1–L200, recortado)");
    });

    it("omite el rango de líneas cuando el chunk no tiene location (fallback firma)", () => {
      const signatureOnly = chunk("iface.ts#Foo", 0.9, "interface Foo");
      const result = injector.inject("q", [signatureOnly], "v2");
      expect(result).toContain("interface Foo");
      expect(result).not.toMatch(/\(L\d+–L\d+/);
    });
  });
});
