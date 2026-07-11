import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { writeTextFileAtomic } from "../state/json-store.js";
import { inspectProject } from "../state/project-registry.js";
import { resolveDbPath } from "../storage-paths.js";
import { runCliCommand } from "./common.js";

interface SkillUpdateOptions {
  json: boolean;
  install?: string;
}

interface SkillInstallOptions {
  agent: string;
  json: boolean;
}

interface CountRow {
  label: string;
  count: number;
}

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  filepath: string;
  signature: string;
  dimension: string | null;
  degree: number;
}

type SupportedSkillAgent = "codex" | "claude" | "opencode";

interface SkillSource {
  projectPath: string;
  dbPath: string;
  outputPath: string;
  skillName: string;
  markdown: string;
  installMarkdown: string;
  stats: { nodes: number; edges: number };
}

interface SkillInstallResult {
  agent: SupportedSkillAgent;
  path: string;
  configPath?: string;
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description("Genera e instala instrucciones para que agentes usen LaCoCo.");

  skill
    .command("update [project]")
    .description("Genera .lacoco/skill.md desde el grafo indexado actual.")
    .option("--install <agents>", "También instala la skill en agentes: codex, claude, opencode, all")
    .option("--json", "Imprime JSON válido", false)
    .action((project: string | undefined, options: SkillUpdateOptions) => {
      runCliCommand(() => updateSkill(project, options));
    });

  skill
    .command("install [project]")
    .description("Instala la skill generada en uno o más agentes.")
    .requiredOption("--agent <agents>", "Agentes destino: codex, claude, opencode, all")
    .option("--json", "Imprime JSON válido", false)
    .action((project: string | undefined, options: SkillInstallOptions) => {
      runCliCommand(() => installSkill(project, options));
    });
}

function updateSkill(project: string | undefined, options: SkillUpdateOptions): void {
  const source = buildSkillSource(project);
  writeTextFileAtomic(source.outputPath, source.markdown);

  const installs = options.install ? installAgents(source, parseAgents(options.install)) : [];
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      output: source.outputPath,
      skillName: source.skillName,
      nodes: source.stats.nodes,
      edges: source.stats.edges,
      installs,
    }, null, 2)}\n`);
    return;
  }
  console.log(`Skill generada: ${source.outputPath}`);
  for (const install of installs) {
    console.log(`Skill instalada (${install.agent}): ${install.path}`);
  }
}

function installSkill(project: string | undefined, options: SkillInstallOptions): void {
  const source = buildSkillSource(project);
  writeTextFileAtomic(source.outputPath, source.markdown);
  const installs = installAgents(source, parseAgents(options.agent));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      output: source.outputPath,
      skillName: source.skillName,
      installs,
    }, null, 2)}\n`);
    return;
  }
  for (const install of installs) {
    console.log(`Skill instalada (${install.agent}): ${install.path}`);
  }
}

function buildSkillSource(project: string | undefined): SkillSource {
  const projectPath = resolveProjectPath(project);
  const dbPath = resolveDbPath(projectPath);
  const outputPath = path.join(path.dirname(dbPath), "skill.md");
  const skillName = createSkillName(projectPath);
  const db = new LaCoCoDatabase(dbPath);
  try {
    const raw = db.getRawDb();
    const stats = db.stats();
    if (stats.nodes === 0) {
      throw new Error("No hay grafo indexado. Ejecuta index_graph antes de skill update.");
    }
    const input = {
      projectPath,
      dbPath,
      skillName,
      stats,
      services: loadServices(raw, projectPath),
      kinds: loadCounts(raw, "SELECT kind AS label, COUNT(*) AS count FROM nodes GROUP BY kind ORDER BY count DESC LIMIT 12"),
      dimensions: loadCounts(raw, `
        SELECT COALESCE(dimension, 'unknown') AS label, COUNT(*) AS count
        FROM nodes n
        LEFT JOIN node_metadata m ON m.node_id = n.id
        GROUP BY COALESCE(dimension, 'unknown')
        ORDER BY count DESC
      `),
      symbols: loadTopSymbols(raw, projectPath),
    };
    return {
      projectPath,
      dbPath,
      outputPath,
      skillName,
      markdown: renderSkillMarkdown(input),
      installMarkdown: renderInstallableSkillMarkdown(input),
      stats,
    };
  } finally {
    db.close();
  }
}

function installAgents(source: SkillSource, agents: SupportedSkillAgent[]): SkillInstallResult[] {
  return agents.map((agent) => installAgent(source, agent));
}

function installAgent(source: SkillSource, agent: SupportedSkillAgent): SkillInstallResult {
  switch (agent) {
    case "codex":
      return installPlainSkill(agent, source, resolveCodexSkillsDir());
    case "claude":
      return installPlainSkill(agent, source, resolveClaudeSkillsDir());
    case "opencode":
      return installOpencodeSkill(source);
  }
}

function installPlainSkill(
  agent: SupportedSkillAgent,
  source: SkillSource,
  skillsDir: string,
): SkillInstallResult {
  const skillDir = path.join(skillsDir, source.skillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  writeTextFileAtomic(skillPath, source.installMarkdown, 0o644);
  return { agent, path: skillPath };
}

function installOpencodeSkill(source: SkillSource): SkillInstallResult {
  const skillsDir = resolveOpencodeSkillsDir();
  const skillDir = path.join(skillsDir, source.skillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  writeTextFileAtomic(skillPath, source.installMarkdown, 0o644);

  const configPath = resolveOpencodeConfigPath();
  upsertOpencodeSkillPath(configPath, skillDir);
  return { agent: "opencode", path: skillPath, configPath };
}

function resolveProjectPath(project?: string): string {
  if (!project) return process.cwd();
  try {
    return inspectProject(project).path;
  } catch {
    return path.resolve(project);
  }
}

function loadCounts(db: Database.Database, sql: string): CountRow[] {
  return db.prepare(sql).all().map((value) => {
    const row = value as { label: unknown; count: unknown };
    return {
      label: String(row.label),
      count: Number(row.count),
    };
  });
}

function loadServices(db: Database.Database, projectPath: string): CountRow[] {
  const rows = db.prepare("SELECT filepath FROM nodes").all() as Array<{ filepath: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const relative = path.relative(projectPath, row.filepath);
    const [first] = relative.split(path.sep);
    const service = first && !first.startsWith("..") ? first : "(external)";
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 12);
}

function loadTopSymbols(db: Database.Database, projectPath: string): SymbolRow[] {
  const rows = db.prepare(`
    SELECT
      n.id,
      n.name,
      n.kind,
      n.filepath,
      COALESCE(n.signature, n.name) AS signature,
      m.dimension,
      (
        SELECT COUNT(*)
        FROM edges e
        WHERE e.sourceId = n.id OR e.targetId = n.id
      ) AS degree
    FROM nodes n
    LEFT JOIN node_metadata m ON m.node_id = n.id
    WHERE n.kind IN ('CLASS', 'INTERFACE', 'TYPE', 'FUNCTION', 'METHOD', 'VARIABLE')
    ORDER BY degree DESC, n.kind, n.name
    LIMIT 40
  `).all() as SymbolRow[];

  return rows.map((row) => ({
    ...row,
    filepath: path.relative(projectPath, row.filepath),
  }));
}

function renderSkillMarkdown(input: {
  projectPath: string;
  dbPath: string;
  skillName: string;
  stats: { nodes: number; edges: number };
  services: CountRow[];
  kinds: CountRow[];
  dimensions: CountRow[];
  symbols: SymbolRow[];
}): string {
  return `# LaCoCo Project Retrieval Skill

Use this skill when a user asks you to understand, modify, debug, refactor, create, or integrate code in this repository.

## Project Snapshot

- Skill name: \`${input.skillName}\`
- Project root: \`${input.projectPath}\`
- SQLite graph: \`${input.dbPath}\`
- Graph size: ${input.stats.nodes} nodes, ${input.stats.edges} edges

Services/directories:
${renderCountList(input.services)}

Node kinds:
${renderCountList(input.kinds)}

Dimensions:
${renderCountList(input.dimensions)}

## Retrieval Contract

You decide whether retrieval is needed. If the task depends on repository code, call LaCoCo. If the task is generic conversation, do not call LaCoCo.

When calling LaCoCo, send this JSON through stdin:

\`\`\`json
{
  "schemaVersion": 1,
  "originalPrompt": "The user's original prompt, unchanged",
  "clean_query": "\\"SymbolA\\" OR \\"file-name\\" OR \\"domain term\\"",
  "embedding_input": "Short semantic description of what must be retrieved",
  "intent": "understand",
  "dimensions": ["CPG"],
  "confidence": 0.9,
  "strategy": "hybrid",
  "chunks": 20,
  "maxTokens": 4000
}
\`\`\`

Command:

\`\`\`bash
printf '%s' '<json>' | lacoco retrieve "${input.projectPath}" --json
\`\`\`

Use the returned \`contextBlock\` as repository evidence before editing files. Do not invent symbols that are absent from the retrieved context unless you inspect the files directly.

## Query Rules

- \`clean_query\`: SQLite FTS5 query, usually quoted symbols or paths joined with \`OR\`.
- \`embedding_input\`: natural-language retrieval intent preserving important symbols.
- \`intent\`: one of \`understand\`, \`refactor\`, \`create\`, \`debug\`, \`integrate\`, \`unknown\`.
- \`dimensions\`: use \`SYS\` for contracts/modules/dependencies, \`CPG\` for execution/calls/classes, \`DTG\` for data/types/DTO/state.
- Prefer \`hybrid\` for most tasks; use \`consensus\` when relevant code may be structurally related but lexically distant.

## Important Symbols

${renderSymbolList(input.symbols)}
`;
}

function renderInstallableSkillMarkdown(input: {
  projectPath: string;
  dbPath: string;
  skillName: string;
  stats: { nodes: number; edges: number };
  services: CountRow[];
  kinds: CountRow[];
  dimensions: CountRow[];
  symbols: SymbolRow[];
}): string {
  return `---
name: ${input.skillName}
description: Use this skill when working in ${input.projectPath} and the user asks to understand, modify, debug, refactor, create, or integrate repository code. Before taking code action, retrieve LaCoCo context with a structured query.
---

# LaCoCo Retrieval Skill

This skill is for repository \`${input.projectPath}\`.

Mandatory workflow for repository-specific tasks:

1. Decide whether the user's request depends on repository code. If it does, use LaCoCo before editing files or giving code-specific conclusions.
2. Build a structured retrieval JSON from the user's original prompt. Preserve the original prompt unchanged in \`originalPrompt\`.
3. Choose \`clean_query\` as a focused SQLite FTS5 query using quoted symbols, file names, route names, DTO names, service names, or domain terms joined with \`OR\`.
4. Choose \`embedding_input\` as a short natural-language description of what evidence is needed.
5. Choose \`intent\` from \`understand\`, \`refactor\`, \`create\`, \`debug\`, \`integrate\`, \`unknown\`.
6. Choose \`dimensions\`: \`SYS\` for modules/contracts/dependencies, \`CPG\` for classes/calls/execution, \`DTG\` for DTOs/data/state.
7. Send the JSON to LaCoCo through stdin:

\`\`\`bash
printf '%s' '<json>' | lacoco retrieve "${input.projectPath}" --json
\`\`\`

8. Read the returned \`contextBlock\`. Use it as repository evidence before modifying files or finalizing an answer. If the retrieved context is insufficient, inspect files directly or run another narrower LaCoCo query.

Input JSON shape:

\`\`\`json
{
  "schemaVersion": 1,
  "originalPrompt": "The user's original prompt, unchanged",
  "clean_query": "\\"SymbolA\\" OR \\"file-name\\" OR \\"domain term\\"",
  "embedding_input": "Short semantic description of what must be retrieved",
  "intent": "understand",
  "dimensions": ["CPG"],
  "confidence": 0.9,
  "strategy": "hybrid",
  "chunks": 20,
  "maxTokens": 4000
}
\`\`\`

Project snapshot:

- SQLite graph: \`${input.dbPath}\`
- Graph size: ${input.stats.nodes} nodes, ${input.stats.edges} edges

Services/directories:
${renderCountList(input.services)}

Node kinds:
${renderCountList(input.kinds)}

Dimensions:
${renderCountList(input.dimensions)}

Important symbols:
${renderSymbolList(input.symbols)}
`;
}

function renderCountList(rows: CountRow[]): string {
  if (rows.length === 0) return "- (none)";
  return rows.map((row) => `- ${row.label}: ${row.count}`).join("\n");
}

function renderSymbolList(rows: SymbolRow[]): string {
  if (rows.length === 0) return "- (none)";
  return rows.map((row) => {
    const dim = row.dimension ?? "unknown";
    const signature = row.signature.replace(/\s+/g, " ").slice(0, 180);
    return `- ${row.name} [${row.kind}/${dim}] \`${row.filepath}\` :: ${signature}`;
  }).join("\n");
}

function parseAgents(raw: string): SupportedSkillAgent[] {
  const values = raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const expanded = values.includes("all") ? ["codex", "claude", "opencode"] : values;
  if (expanded.length === 0) throw new Error("Debes indicar al menos un agente");

  const seen = new Set<SupportedSkillAgent>();
  for (const value of expanded) {
    if (!isSupportedSkillAgent(value)) {
      throw new Error(`Agente no soportado: ${value}. Usa codex, claude, opencode o all.`);
    }
    seen.add(value);
  }
  return [...seen];
}

function isSupportedSkillAgent(value: string): value is SupportedSkillAgent {
  return value === "codex" || value === "claude" || value === "opencode";
}

function createSkillName(projectPath: string): string {
  const basename = path.basename(projectPath) || "project";
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `lacoco-${slug || "project"}`;
}

function resolveCodexSkillsDir(): string {
  return process.env.LACOCO_CODEX_SKILLS_DIR
    ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "skills");
}

function resolveClaudeSkillsDir(): string {
  return process.env.LACOCO_CLAUDE_SKILLS_DIR
    ?? path.join(process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude"), "skills");
}

function resolveOpencodeConfigDir(): string {
  return process.env.LACOCO_OPENCODE_CONFIG_DIR
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode");
}

function resolveOpencodeSkillsDir(): string {
  return process.env.LACOCO_OPENCODE_SKILLS_DIR
    ?? path.join(resolveOpencodeConfigDir(), "skills");
}

function resolveOpencodeConfigPath(): string {
  return process.env.LACOCO_OPENCODE_CONFIG_PATH
    ?? path.join(resolveOpencodeConfigDir(), "opencode.jsonc");
}

function upsertOpencodeSkillPath(configPath: string, skillDir: string): void {
  const config = readOpencodeConfig(configPath);
  const skills = isRecord(config.skills) ? config.skills : {};
  const paths = Array.isArray(skills.paths)
    ? skills.paths.filter((value): value is string => typeof value === "string")
    : [];
  const normalizedSkillDir = path.resolve(skillDir);
  if (!paths.map((value) => path.resolve(value)).includes(normalizedSkillDir)) {
    paths.push(normalizedSkillDir);
  }
  config.skills = {
    ...skills,
    paths,
  };
  writeTextFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

function readOpencodeConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return { $schema: "https://opencode.ai/config.json" };
  const content = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(stripJsonComments(content)) as unknown;
  if (!isRecord(parsed)) throw new Error(`Configuración opencode inválida: ${configPath}`);
  return parsed;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
