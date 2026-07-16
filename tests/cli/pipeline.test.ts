import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RetrievalSession,
  runContextExport,
  runRetrieve,
  type CliStreams,
  type RetrieveRuntime,
} from "../../src/cli/index.js";
import { strategyHelp } from "../../src/cli/pipeline.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { RecoveryStrategy } from "../../src/retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";

/**
 * Cobertura de RAMAS de src/cli/pipeline.ts que la batería existente
 * (retrieve-cli / retrieval-session) no toca: ruta LLM_DIRECT, verbose,
 * exportación JSON y su rama de error, render Markdown con chunks vacíos /
 * dimensiones ausentes / query vacía / escapado de fences, cierre de LanceDB
 * con error, runtime por defecto y formatError sobre un valor no-Error.
 *
 * Se usa una LaCoCoDatabase FALSA (sin SQLite real) igual que retrieval-session,
 * y un RetrieveRuntime inyectado, de modo que ningún test toca red ni disco
 * salvo la exportación Markdown (archivo temporal) y el runtime por defecto.
 */

const PROYECTO_FALSO = "/tmp/lacoco-pipeline-proyecto-inexistente";
const temporales: string[] = [];

/** LaCoCoDatabase falsa: solo lo que el pipeline consulta en template v1. */
function dbFalsa(): LaCoCoDatabase {
  return {
    close: vi.fn(),
    getRawDb: () => ({}),
    getNodeSpans: () => new Map(),
  } as unknown as LaCoCoDatabase;
}

function estrategiaFalsa(chunks: RetrievedChunk[]): RecoveryStrategy {
  return { retrieve: async () => chunks };
}

type RetrievedChunk = {
  chunkId: string;
  nodeId: string;
  score: number;
  text: string;
  source: string;
};

const CHUNK_UNO: RetrievedChunk = {
  chunkId: "n1",
  nodeId: "file#OrderService",
  score: 1,
  text: "class OrderService {}",
  source: "hybrid",
};

const SANITIZED_RAG: SanitizerOutput = {
  route: "RAG",
  clean_query: "OrderService",
  embedding_input: "servicio de pedidos",
  dimensions: ["CPG"],
  intent: "understand",
  confidence: 0.9,
};

interface RuntimeConfig {
  sanitize?: () => Promise<SanitizerOutput>;
  createStrategy?: RetrieveRuntime["createStrategy"];
}

/** Runtime inyectable con db falsa; se pueden sobreescribir piezas puntuales. */
function runtimeFalso(cfg: RuntimeConfig = {}): RetrieveRuntime {
  return {
    createDatabase: () => dbFalsa(),
    createOllama: () => ({
      isAvailable: async () => true,
      generate: async () => "",
      chat: async () => "",
      abort: () => undefined,
    }),
    createIntermediary: () => ({
      sanitize: cfg.sanitize ?? (async () => SANITIZED_RAG),
    }),
    createStrategy:
      cfg.createStrategy ?? (async () => ({ strategy: estrategiaFalsa([CHUNK_UNO]) })),
  };
}

function streamsCapturados(): {
  streams: CliStreams;
  leer: () => { stdout: string; stderr: string };
} {
  let stdout = "";
  let stderr = "";
  return {
    streams: {
      stdout: { write: (c: string | Uint8Array) => ((stdout += c.toString()), true) },
      stderr: { write: (c: string | Uint8Array) => ((stderr += c.toString()), true) },
    },
    leer: () => ({ stdout, stderr }),
  };
}

const OPCIONES_BASE = { strategy: "hybrid", verbose: false } as const;

beforeEach(() => {
  // Silenciar el log de conexión de la DB real (solo el test de runtime por defecto).
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temporales.length > 0) rmSync(temporales.pop()!, { recursive: true, force: true });
});

describe("runRetrieve — ramas de flujo", () => {
  it("con verbose emite diagnóstico en stderr y no contamina stdout", async () => {
    // Arrange
    const { streams, leer } = streamsCapturados();

    // Act: verbose=true activa los writeStderr de diagnóstico.
    const code = await runRetrieve(
      "OrderService",
      { strategy: "hybrid", verbose: true },
      streams,
      runtimeFalso(),
      PROYECTO_FALSO,
    );

    // Assert
    expect(code).toBe(0);
    const { stdout, stderr } = leer();
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).toContain("[CLI] retrieve completado");
  });

  it("en ruta LLM_DIRECT devuelve el embedding_input sin recuperar chunks", async () => {
    // Arrange: el clasificador enruta a respuesta directa del LLM.
    const { streams, leer } = streamsCapturados();
    const sanitize = async (): Promise<SanitizerOutput> => ({
      ...SANITIZED_RAG,
      route: "LLM_DIRECT",
      embedding_input: "responde directo",
    });

    // Act
    const code = await runRetrieve(
      "cualquier cosa",
      { ...OPCIONES_BASE },
      streams,
      runtimeFalso({ sanitize }),
      PROYECTO_FALSO,
    );

    // Assert: sin sección de contexto (no hubo retrieval).
    expect(code).toBe(0);
    expect(leer().stdout).toContain("responde directo");
  });
});

describe("runContextExport — ramas de exportación", () => {
  it("exporta a Markdown con salida JSON cuando json=true", async () => {
    // Arrange
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-pipeline-"));
    temporales.push(dir);
    const output = path.join(dir, "ctx.md");
    const { streams, leer } = streamsCapturados();

    // Act: json=true → rama del writeStdout con el resumen JSON.
    const code = await runContextExport(
      "OrderService",
      { strategy: "hybrid", verbose: false, json: true, output },
      streams,
      runtimeFalso(),
      PROYECTO_FALSO,
    );

    // Assert
    expect(code).toBe(0);
    const resumen = JSON.parse(leer().stdout) as { output: string; query: string; chunks: number };
    expect(resumen.output).toBe(path.resolve(output));
    expect(resumen.query).toBe("OrderService");
    expect(resumen.chunks).toBe(1);
    expect(readFileSync(output, "utf8")).toContain("file#OrderService");
  });

  it("propaga el error de etapa a stderr cuando el pipeline falla", async () => {
    // Arrange: el clasificador lanza → PipelineStageError(stage="intermediario").
    const { streams, leer } = streamsCapturados();
    const sanitize = async (): Promise<SanitizerOutput> => {
      throw new Error("clasificador caído");
    };

    // Act
    const code = await runContextExport(
      "OrderService",
      { strategy: "hybrid", verbose: false, json: false, output: "/tmp/no-se-escribe.md" },
      streams,
      runtimeFalso({ sanitize }),
      PROYECTO_FALSO,
    );

    // Assert
    expect(code).toBe(1);
    expect(leer().stderr).toContain("Error exportando contexto (intermediario)");
    expect(leer().stderr).toContain("clasificador caído");
  });

  it("renderiza Markdown degradado: sin chunks, sin dimensiones, query vacía y fences escapados", async () => {
    // Arrange: sanitized con dimensiones vacías, clean_query vacío y un
    // embedding_input que contiene ``` (fuerza el fence de 4 backticks).
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-pipeline-md-"));
    temporales.push(dir);
    const output = path.join(dir, "vacio.md");
    const { streams } = streamsCapturados();
    const sanitize = async (): Promise<SanitizerOutput> => ({
      route: "RAG",
      clean_query: "",
      embedding_input: "tiene ``` dentro",
      dimensions: [],
      intent: "understand",
      confidence: 0.5,
    });
    // Estrategia sin resultados → chunkSections vacío en el Markdown.
    const createStrategy: RetrieveRuntime["createStrategy"] = async () => ({
      strategy: estrategiaFalsa([]),
    });

    // Act
    const code = await runContextExport(
      "consulta sin resultados",
      { strategy: "hybrid", verbose: false, json: false, output },
      streams,
      runtimeFalso({ sanitize, createStrategy }),
      PROYECTO_FALSO,
    );

    // Assert
    expect(code).toBe(0);
    const md = readFileSync(output, "utf8");
    expect(md).toContain("No se recuperaron chunks para esta consulta.");
    expect(md).toContain("(empty)"); // clean_query vacío
    expect(md).toContain("````"); // fence escalado por el ``` del embedding_input
  });
});

describe("RetrievalSession — cierre y errores", () => {
  it("cierra LanceDB conectado y reporta si close() falla", async () => {
    // Arrange: la estrategia expone un LanceDB conectado cuyo close() lanza.
    const errores: string[] = [];
    const lanceClose = vi.fn(async () => {
      throw new Error("no cerró");
    });
    const createStrategy: RetrieveRuntime["createStrategy"] = async () => ({
      strategy: estrategiaFalsa([CHUNK_UNO]),
      connectedLanceDb: { close: lanceClose } as unknown as never,
    });
    const session = RetrievalSession.open({
      db: "/x/tensor.sqlite",
      lancedb: "/x/lancedb",
      ollamaEndpoint: "http://localhost:11434",
      runtime: runtimeFalso({ createStrategy }),
    });

    // Act: retrieve cachea la estrategia (con lanceDb); close intenta cerrarlo.
    await session.retrieve("OrderService", {
      strategy: "hybrid",
      maxTokens: 4000,
      grounding: false,
      template: "v1",
    });
    await session.close((m) => errores.push(m));

    // Assert
    expect(lanceClose).toHaveBeenCalledTimes(1);
    expect(errores.some((e) => e.includes("Error cerrando LanceDB") && e.includes("no cerró"))).toBe(true);
  });

  it("envuelve un fallo no-Error de la estrategia en formatError (String)", async () => {
    // Arrange: createStrategy lanza un STRING → formatError debe stringificarlo.
    const createStrategy: RetrieveRuntime["createStrategy"] = async () => {
      throw "explosión de estrategia";
    };
    const session = RetrievalSession.open({
      db: "/x/tensor.sqlite",
      lancedb: "/x/lancedb",
      ollamaEndpoint: "http://localhost:11434",
      runtime: runtimeFalso({ createStrategy }),
    });

    // Act / Assert
    await expect(
      session.retrieve("OrderService", {
        strategy: "hybrid",
        maxTokens: 4000,
        grounding: false,
        template: "v1",
      }),
    ).rejects.toThrow("explosión de estrategia");
    await session.close();
  });

  it("open() sin runtime usa el runtime por defecto y cierra sin lanzar", async () => {
    // Arrange: db en archivo temporal para el LaCoCoDatabase real por defecto.
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-pipeline-default-"));
    temporales.push(dir);

    // Act: sin `runtime` → defaultRetrieveRuntime (crea DB/Ollama/intermediario reales).
    const session = RetrievalSession.open({
      db: path.join(dir, "tensor.sqlite"),
      lancedb: path.join(dir, "lancedb"),
      ollamaEndpoint: "http://localhost:11434",
    });

    // Assert: no se toca red; solo abrir y cerrar es seguro.
    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("strategyHelp", () => {
  it("lista las estrategias disponibles", () => {
    const help = strategyHelp();
    expect(help).toContain("hybrid");
    expect(help.length).toBeGreaterThan(0);
  });
});
