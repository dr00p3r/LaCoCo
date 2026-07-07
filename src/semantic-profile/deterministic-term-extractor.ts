import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Dimension } from "../domain/dimensions.js";
import { normalizeSemanticText } from "./semantic-profile-store.js";
import type { DeterministicTerm, SemanticTermKind } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".css", ".scss", ".sass", ".less",
  ".sql", ".graphql", ".gql", ".yaml", ".yml", ".md",
]);
const SUPPORTED_NAMES = new Set(["Dockerfile", "Makefile", ".env.example"]);
const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next",
  ".turbo", ".cache", ".lacoco",
]);
const MAX_FILES = 50_000;

interface NodeTermRow {
  id: string;
  kind: string;
  name: string;
  filepath: string;
  signature: string | null;
  dimension: Dimension | null;
}

export class DeterministicTermExtractor {
  constructor(
    private readonly db: Database.Database,
    private readonly projectRoot: string,
  ) {}

  extract(): DeterministicTerm[] {
    const terms = new Map<string, DeterministicTerm>();
    const nodes = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.filepath, n.signature, m.dimension
      FROM nodes n
      LEFT JOIN node_metadata m ON m.node_id = n.id
      ORDER BY n.id
    `).all() as NodeTermRow[];
    if (nodes.length === 0) {
      throw new Error("No hay grafo indexado. Ejecuta index_graph antes de profile rebuild.");
    }

    for (const node of nodes) {
      const external = node.kind === "EXTERNAL_LIB" || node.filepath.includes("node_modules");
      const kind: SemanticTermKind = external ? "external-import" : "symbol";
      const relativePath = external ? undefined : this.#relativePath(node.filepath);
      const evidence = [node.id, node.kind, node.signature ?? "", relativePath ?? node.filepath];
      const term = createTerm({
        identity: node.id,
        canonicalTerm: node.name,
        kind,
        nodeId: node.id,
        ...(relativePath ? { path: relativePath } : {}),
        dimensions: node.dimension ? [node.dimension] : [],
        evidence,
      });
      terms.set(term.id, term);
    }

    for (const filePath of this.#walkProjectFiles()) {
      const relativePath = this.#relativePath(filePath);
      const extension = path.extname(filePath);
      const kind: SemanticTermKind = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
        .includes(extension) ? "source-file" : "project-file";
      const term = createTerm({
        identity: relativePath,
        canonicalTerm: path.basename(filePath),
        kind,
        path: relativePath,
        dimensions: [],
        evidence: ["file_path", relativePath],
      });
      terms.set(term.id, term);
    }

    for (const dependency of this.#readDependencies()) {
      const term = createTerm({
        identity: dependency.name,
        canonicalTerm: dependency.name,
        kind: "dependency",
        path: "package.json",
        dimensions: ["SYS"],
        evidence: [dependency.section, dependency.name, dependency.version],
      });
      terms.set(term.id, term);
    }

    return [...terms.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  #walkProjectFiles(): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        const relative = path.relative(this.projectRoot, fullPath);
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name) || relative === path.join("eval", "workdir")) continue;
          visit(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name)) && !SUPPORTED_NAMES.has(entry.name)) continue;
        files.push(fullPath);
        if (files.length > MAX_FILES) {
          throw new Error(`El perfil excede el límite de ${MAX_FILES} archivos soportados`);
        }
      }
    };
    visit(this.projectRoot);
    return files.sort();
  }

  #readDependencies(): Array<{ name: string; version: string; section: string }> {
    const packagePath = path.join(this.projectRoot, "package.json");
    if (!fs.existsSync(packagePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    const result: Array<{ name: string; version: string; section: string }> = [];
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const value = parsed[section];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [name, version] of Object.entries(value)) {
        if (typeof version === "string") result.push({ name, version, section });
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  #relativePath(filePath: string): string {
    const relative = path.relative(this.projectRoot, filePath);
    return relative.length > 0 && !relative.startsWith("..") ? relative : filePath;
  }
}

function createTerm(input: {
  identity: string;
  canonicalTerm: string;
  kind: SemanticTermKind;
  nodeId?: string;
  path?: string;
  dimensions: Dimension[];
  evidence: string[];
}): DeterministicTerm {
  const id = crypto.createHash("sha256")
    .update(`${input.kind}\0${input.identity}`)
    .digest("hex")
    .slice(0, 24);
  const sourceHash = crypto.createHash("sha256")
    .update(JSON.stringify({
      canonicalTerm: input.canonicalTerm,
      kind: input.kind,
      nodeId: input.nodeId,
      path: input.path,
      dimensions: input.dimensions,
      evidence: input.evidence,
    }))
    .digest("hex");
  return {
    id,
    canonicalTerm: input.canonicalTerm,
    normalizedTerm: normalizeSemanticText(input.canonicalTerm),
    kind: input.kind,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.path ? { path: input.path } : {}),
    dimensions: input.dimensions,
    evidence: input.evidence,
    sourceHash,
  };
}
