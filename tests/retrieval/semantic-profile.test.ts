import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { SemanticProfileBuilder } from "../../src/semantic-profile/semantic-profile-builder.js";
import { SemanticProfileStore } from "../../src/semantic-profile/semantic-profile-store.js";
import { SlmClassifier } from "../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import type { ChatMessage, LlmClient } from "../../src/slms/llm-client.js";
import type { QueryGrounding } from "../../src/semantic-profile/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Project Semantic Profile", () => {
  it("construye aliases bilingües separados del grafo y resuelve una consulta en español", async () => {
    const root = createProject();
    const db = new LaCoCoDatabase(path.join(root, "tensor.sqlite"));
    db.insertNode({
      id: `${root}/tailwind.config.ts#theme`,
      kind: "VARIABLE",
      name: "theme",
      filepath: path.join(root, "tailwind.config.ts"),
      signature: "export const theme = {}",
      isDeprecated: 0,
    });
    db.populateMetadata();

    const result = await new SemanticProfileBuilder(
      db.getRawDb(),
      root,
      createEnrichmentLlm(),
      "test-model",
    ).rebuild();
    const store = new SemanticProfileStore(db.getRawDb());
    const grounding = store.groundQuery("cambia la paleta de colores", 10);

    expect(result.termCount).toBeGreaterThan(1);
    expect(grounding.candidates.some(({ canonicalTerm }) =>
      canonicalTerm === "tailwind.config.ts" || canonicalTerm === "theme"
    )).toBe(true);
    expect(grounding.candidates.flatMap(({ matchedAliases }) => matchedAliases))
      .toContain("paleta de colores");
    const graphNames = db.getRawDb().prepare("SELECT name FROM nodes").all() as Array<{ name: string }>;
    expect(graphNames.map(({ name }) => name)).not.toContain("paleta de colores");
    db.close();
  });

  it("marca el perfil obsoleto cuando cambia la revisión del grafo", async () => {
    const root = createProject();
    const db = new LaCoCoDatabase(path.join(root, "tensor.sqlite"));
    db.insertNode({
      id: `${root}/src/index.ts#main`,
      kind: "FUNCTION",
      name: "main",
      filepath: path.join(root, "src/index.ts"),
      signature: "function main(): void",
      isDeprecated: 0,
    });
    await new SemanticProfileBuilder(db.getRawDb(), root, createEnrichmentLlm(), "test-model").rebuild();
    db.bumpGraphRevision();

    expect(() => new SemanticProfileStore(db.getRawDb()).groundQuery("main"))
      .toThrow("obsoleto");
    expect(db.getSemanticProfileState().status).toBe("stale");
    db.close();
  });

  it("reutiliza enriquecimiento por hash sin volver a llamar al SLM", async () => {
    const root = createProject();
    const db = new LaCoCoDatabase(path.join(root, "tensor.sqlite"));
    db.insertNode({
      id: `${root}/src/index.ts#main`,
      kind: "FUNCTION",
      name: "main",
      filepath: path.join(root, "src/index.ts"),
      signature: "function main(): void",
      isDeprecated: 0,
    });
    await new SemanticProfileBuilder(db.getRawDb(), root, createEnrichmentLlm(), "test-model").rebuild();
    const chat = vi.fn().mockRejectedValue(new Error("no debe invocarse"));
    const cachedOnlyLlm = {
      abort: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      generate: vi.fn().mockResolvedValue(""),
      chat,
    } satisfies LlmClient;

    const second = await new SemanticProfileBuilder(
      db.getRawDb(),
      root,
      cachedOnlyLlm,
      "test-model",
    ).rebuild();

    expect(second.termCount).toBeGreaterThan(0);
    expect(chat).not.toHaveBeenCalled();
    expect(new SemanticProfileStore(db.getRawDb()).getState().status).toBe("ready");
    db.close();
  });

  it("repara una clean_query con términos sin evidencia sin aplicar fallback local", async () => {
    const grounding = createGrounding();
    const invalid = classification('"schema"');
    const valid = classification('"tailwind.config.ts" OR "paleta de colores"');
    const chat = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(invalid))
      .mockResolvedValueOnce(JSON.stringify(valid));
    const llm = { chat } as unknown as LlmClient;

    const detailed = await new SlmClassifier(llm).classifyDetailed(
      "cambia la paleta de colores",
      grounding,
    );

    expect(detailed.output.clean_query).toBe(valid.clean_query);
    expect(detailed.usedTermIds).toEqual(["term-tailwind"]);
    expect(detailed.initialUnsupportedClauses).toEqual(["schema"]);
    expect(detailed.repairCount).toBe(1);
  });
});

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lacoco-profile-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/index.ts"), "export function main() {}\n");
  fs.writeFileSync(path.join(root, "tailwind.config.ts"), "export const theme = {};\n");
  fs.writeFileSync(path.join(root, "global.css"), ":root { --color: red; }\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    dependencies: { tailwindcss: "^4.0.0" },
  }));
  return root;
}

function createEnrichmentLlm(): LlmClient {
  return {
    abort: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue(""),
    chat: vi.fn(async (messages: ChatMessage[]) => {
      const content = messages.at(-1)?.content ?? "";
      const match = content.match(/Entrada:\n(\[[\s\S]*\])\n(?:Salida:|Respuesta)/);
      if (!match) throw new Error("Entrada del enriquecedor no encontrada");
      const input = JSON.parse(match[1]!) as Array<{ id: string; canonical_term: string }>;
      return JSON.stringify({
        terms: input.map((term) => ({
          id: term.id,
          aliases: term.canonical_term.includes("tailwind") || term.canonical_term === "theme"
            ? [
                { value: "paleta de colores", language: "es", confidence: 0.98 },
                { value: "color palette", language: "en", confidence: 0.98 },
              ]
            : [],
          domains: [{
            name: term.canonical_term.includes("tailwind") || term.canonical_term === "theme"
              ? "ui-style"
              : "unknown",
            score: 0.9,
          }],
          description: `Semantic description for ${term.canonical_term}`,
          confidence: 0.9,
        })),
      });
    }),
  };
}

function createGrounding(): QueryGrounding {
  return {
    profileBuildId: "build-1",
    durationMs: 1,
    domains: [{ name: "ui-style", score: 1 }],
    candidates: [{
      termId: "term-tailwind",
      canonicalTerm: "tailwind.config.ts",
      kind: "project-file",
      path: "tailwind.config.ts",
      score: 1,
      matchedAliases: ["paleta de colores"],
      matchReasons: ["exact"],
      aliases: [
        { value: "paleta de colores", language: "es", confidence: 0.98 },
        { value: "color palette", language: "en", confidence: 0.98 },
      ],
      domains: [{ name: "ui-style", score: 1 }],
    }],
  };
}

function classification(cleanQuery: string): Record<string, unknown> {
  return {
    route: "RAG",
    clean_query: cleanQuery,
    embedding_input: "Modificar la paleta visual",
    dimensions: ["SYS", "CPG"],
    intent: "refactor",
    confidence: 0.95,
  };
}
