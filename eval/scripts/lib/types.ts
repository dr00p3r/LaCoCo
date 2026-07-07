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

export interface MetricDefinition {
  id: string;
  name: string;
  dimension: string;
  stage: string;
  formula: string;
  unit: string;
  better: string;
  source: string;
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

export interface TaskGold {
  status: string;
  // Repo-relative node id (`<relpath>#<symbol>`) used as the BFS root for
  // multihop distance checks. Null when not yet annotated.
  primary_anchor: string | null;
  // Node ids are stored repo-relative and resolved against the repo path at
  // validation/metrics time so gold is portable across machines.
  relevant_nodes: string[];
  multihop_nodes: string[];
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
