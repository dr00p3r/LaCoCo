export interface ManifestHeader {
  manifest_version: number;
  kind: string;
  updated_at: string;
}

export interface RepositoryDefinition {
  id: string;
  display_name: string;
  url: string;
  ref: string;
  package_manager: string;
  install_command: string;
  test_command: string;
  source_roots: string[];
  tsconfig_candidates: string[];
  [key: string]: unknown;
}

export interface RepositoriesManifest extends ManifestHeader {
  kind: "repositories";
  repositories: RepositoryDefinition[];
  [key: string]: unknown;
}

export interface StrategyDefinition {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  lacoco_strategy: string | null;
  requires_lancedb: boolean;
  requires_ollama: boolean;
  retrieval_enabled: boolean;
  generation_enabled: boolean;
  parameters: Record<string, number>;
  [key: string]: unknown;
}

export interface StrategiesManifest extends ManifestHeader {
  kind: "retrieval_strategies";
  strategies: StrategyDefinition[];
  [key: string]: unknown;
}

export interface AgentDefinition {
  id: string;
  label: string;
  enabled: boolean;
  adapter_kind: string;
  command: string | null;
  invocation: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentsManifest extends ManifestHeader {
  kind: "coding_agents";
  agents: AgentDefinition[];
  [key: string]: unknown;
}

/**
 * Rol de una métrica. Invariante estructural: solo `agent_outcome` y
 * `gold_derived` pueden entrar a `quality_gates.*.required_metrics`. Un
 * `diagnostic` (grafo) o `legacy` (P@5/R@5) que aparezca ahí es un error de
 * manifest — el grafo no define pass/fail.
 */
export type MetricRole = "agent_outcome" | "gold_derived" | "diagnostic" | "legacy";

export interface MetricDefinition {
  id: string;
  name: string;
  dimension: string;
  stage: string;
  formula: string;
  unit: string;
  better: string;
  source: string;
  role?: MetricRole;
  [key: string]: unknown;
}

export interface MetricsManifest extends ManifestHeader {
  kind: "metrics";
  metrics: MetricDefinition[];
  [key: string]: unknown;
}

export interface RunConfigurationManifest extends ManifestHeader {
  kind: "run_configuration";
  run: Record<string, unknown>;
  paths: Record<string, unknown>;
  inputs: Record<string, unknown>;
  phases: Record<string, unknown>;
  splits: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QueryInput {
  query: string;
}

export interface DeterministicInput {
  // Principal, publishable query: natural user intent, MUST NOT contain gold
  // symbols or internal identifiers discovered while annotating.
  retrieval_input: QueryInput;
  // Optional diagnostic upper-bound query (may contain gold symbols). Never a
  // principal result; used only for oracle/debug runs.
  oracle_input: QueryInput | null;
  embedding_input: string;
  intent: string;
  dimensions: string[];
}

/** Granularidad de símbolo direccionable, alineada con el extractor de LaCoCo. */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method";

/**
 * Referencia a un símbolo del gold, repo-relativa. `file` es POSIX relativo al
 * repo; el node-id LaCoCo equivalente es `${file}#${symbol}` (se resuelve a
 * absoluto con `resolveNodeId` en tiempo de métricas).
 */
export interface SymbolRef {
  file: string;
  symbol: string;
  kind: SymbolKind;
}

/**
 * Gold de "contexto útil" derivado AUTOMÁTICAMENTE del patch de referencia
 * (no del grafo de LaCoCo, para evitar circularidad). Ver
 * `lib/patch-evidence-gold.ts`. Todo repo-relativo y portable.
 *
 * Estratos (usados por UsefulContextCoverage y el doctor):
 *  - `edited_files`/`edited_symbols` = edit-site (lo que el patch modifica).
 *    `edited_symbols` puede ser vacío (patch sin nodo mapeable) → el gold cae
 *    a nivel archivo (`resolution.fell_back_to_file_level = true`).
 *  - `touched_tests`  = archivos del test_patch asociados.
 *  - `introduced_refs`/`resolved_definitions` = Tier 2 (imports/calls/types en
 *    líneas añadidas y sus definiciones), resueltos vía ts-morph directo.
 */
export interface PatchEvidenceGold {
  source: "patch";
  edited_files: string[];
  edited_symbols: SymbolRef[];
  touched_tests: string[];
  introduced_refs: SymbolRef[];
  resolved_definitions: SymbolRef[];
  resolution: {
    fell_back_to_file_level: boolean;
    unresolved_refs: string[];
  };
}

export interface TaskGold {
  status: string;
  /**
   * Gold principal de contexto útil (patch-evidence). Opcional para retro-compat
   * con manifests que aún no lo derivan; las métricas de recuperación lo exigen
   * cuando `status === "ready"`.
   */
  patch_evidence?: PatchEvidenceGold;
  // --- Campos legacy (rol DIAGNÓSTICO, ya no definen pass/fail) ---
  // Se conservan para el perfil de distancia/vecindad del grafo (benchmark-doctor)
  // y para reproducibilidad histórica; NO alimentan el resumen de métricas.
  // Repo-relative node id (`<relpath>#<symbol>`) usado como raíz BFS del perfil
  // de grafo. Null cuando no está anotado.
  primary_anchor: string | null;
  // Node ids repo-relativos, resueltos contra el repo en tiempo de métricas.
  relevant_nodes: string[];
  multihop_nodes: string[];
  /**
   * Origen del campo `multihop_nodes` (diagnóstico de grafo):
   *  - "auto"   = derivado por `extractMultihopFromGraph` (BFS-2 sobre el grafo).
   *  - "manual" = anotado a mano.
   *  - "pending"= no derivado ni anotado.
   * Default en manifests historicos: "manual".
   */
  multihop_status?: "auto" | "manual" | "pending";
  annotation_notes: string;
}

export interface TranslationGold {
  status: string;
  relevant_terms: string[];
  annotation_notes: string;
}

export interface TaskDefinition {
  id: string;
  repo_id: string;
  title: string;
  type: string;
  difficulty: string;
  prompt: string;
  deterministic_input: DeterministicInput;
  expected_areas: string[];
  target_tests: string[];
  gold: TaskGold;
  translation_gold: TranslationGold;
  regression?: TaskRegression;
  [key: string]: unknown;
}

export interface TaskRegression {
  base_commit: string;
  broken_patch: string;
  grading_tests: string[];
}

export interface TasksManifest extends ManifestHeader {
  kind: "tasks";
  tasks: TaskDefinition[];
  [key: string]: unknown;
}

export interface EvalManifests {
  repos: RepositoriesManifest;
  strategies: StrategiesManifest;
  agents: AgentsManifest;
  metrics: MetricsManifest;
  run: RunConfigurationManifest;
  tasks: TasksManifest;
}
