/**
 * lacoco inspect — Visualizador interactivo del grafo multirrelacional
 *
 * Comandos:
 *   lacoco inspect <root-node>        — Subgrafo BFS alrededor de un nodo
 *   lacoco inspect-query <prompt>     — Pipeline RAG completo → grafo visual
 *
 * Genera un HTML auto-contenido con Cytoscape.js para explorar el grafo.
 * Por defecto embebe la librería (standalone). Usa --cdn para CDN.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { BM25Strategy } from "../retriever/strategies/bm25-strategy.js";
import { BM25DimFilterStrategy } from "../retriever/strategies/bm25-dim-strategy.js";
import { HybridStrategy } from "../retriever/strategies/hybrid-strategy.js";
import { AgenticStrategy } from "../retriever/strategies/agentic-strategy.js";
import { AgenticStandaloneStrategy } from "../retriever/strategies/agentic-standalone-strategy.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { OllamaService } from "../slms/ollama-service.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import type { ContextChunk } from "../retriever/models/strategies/types.js";

// ── Tipos ────────────────────────────────────────────────────────────────────

type Focus = "SYS" | "CPG" | "DTG" | "ALL";
type InspectMode = "default" | "scores" | "tensor";

export interface InspectOptions {
  rootNode: string;
  db: string;
  budget: number;
  focus: Focus;
  output: string;
  cdn: boolean;
}

export interface InspectQueryOptions {
  prompt: string;
  db: string;
  budget: number;
  strategy: string;
  mode: InspectMode;
  output: string;
  cdn: boolean;
  ollama: string;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  filepath: string;
  signature: string;
  dim: string | null;
  sub_type: string | null;
}

interface EdgeRow {
  sourceId: string;
  targetId: string;
  relation: string;
}

interface Stats {
  totalNodes: number;
  totalEdges: number;
  byDim: Record<string, number>;
  byKind: Record<string, number>;
  anchorCount: number;
}

// ── Constantes visuales ──────────────────────────────────────────────────────

const DIM_COLORS: Record<string, string> = {
  SYS: "#e74c3c",
  CPG: "#2ecc71",
  DTG: "#3498db",
};

const DIM_GRAY = "#95a5a6";
const NODE_GRAY = "#aaaaaa";

const KIND_SHAPES: Record<string, string> = {
  CLASS: "rectangle",
  INTERFACE: "hexagon",
  FUNCTION: "ellipse",
  ARROW_FUNCTION: "ellipse",
  METHOD: "ellipse",
  TYPE: "diamond",
  ENUM: "round-rectangle",
  ENUM_MEMBER: "triangle",
  VARIABLE: "rhomboid",
  PROPERTY: "rhomboid",
  ACCESSOR: "tag",
  EXTERNAL_LIB: "star",
};

const SYS_RELS = new Set(["EXTENDS", "IMPLEMENTS", "IMPORTS_EXTERNAL"]);
const CPG_RELS = new Set(["INJECTS", "CALLS", "INSTANTIATES"]);
const DTG_RELS = new Set(["CONSUMES_DATA", "PRODUCES", "MUTATES_STATE"]);

function getEdgeDim(relation: string): string {
  if (SYS_RELS.has(relation)) return "SYS";
  if (CPG_RELS.has(relation)) return "CPG";
  if (DTG_RELS.has(relation)) return "DTG";
  return "unknown";
}

const CYTOSCAPE_VERSION = "3.33.1";
const CYTOSCAPE_CDN = `https://unpkg.com/cytoscape@${CYTOSCAPE_VERSION}/dist/cytoscape.min.js`;

// ──────────────────────────────────────────────────────────────────────────────
// Comando: inspect <root-node>
// ──────────────────────────────────────────────────────────────────────────────

export async function inspect(options: InspectOptions): Promise<void> {
  const db = new LaCoCoDatabase(options.db);
  const rawDb = db.getRawDb();

  const rootIds = findRootNodes(rawDb, options.rootNode);
  if (rootIds.length === 0) {
    console.error(`[inspect] ❌ Nodo "${options.rootNode}" no encontrado en la base de datos.`);
    db.close();
    process.exit(1);
  }

  if (rootIds.length > 1) {
    console.warn(`[inspect] ⚠️  "${options.rootNode}" coincide con ${rootIds.length} nodos. Usando todos como raíz.`);
  }

  console.log(`[inspect] 🔍 Expandiendo BFS desde ${rootIds.length} raíz/raíces (budget=${options.budget}, focus=${options.focus})...`);

  const visited = expandBFS(rawDb, rootIds, options.budget, options.focus);
  const nodes = loadNodes(rawDb, visited);
  const edges = loadEdges(rawDb, visited);
  const anchors = new Map<string, number>(); // sin anchors en modo inspect puro

  const stats = computeStats(nodes, edges, anchors);

  console.log(`[inspect] 📊 Subgrafo: ${stats.totalNodes} nodos, ${stats.totalEdges} aristas`);

  const cytoscapeTag = await getCytoscapeTag(!options.cdn);
  const html = generateHtml({ nodes, edges, anchors, stats, mode: "default", title: `LaCoCo: ${options.rootNode}`, cytoscapeTag });

  fs.writeFileSync(options.output, html, "utf-8");
  console.log(`[inspect] ✅ HTML generado → ${options.output}`);

  db.close();
}

// ──────────────────────────────────────────────────────────────────────────────
// Comando: inspect-query <prompt>
// ──────────────────────────────────────────────────────────────────────────────

export async function inspectQuery(options: InspectQueryOptions): Promise<void> {
  const db = new LaCoCoDatabase(options.db);
  const ollama = new OllamaService(options.ollama);

  // 1. Sanitizar
  const intermediary = new AgentIntermediary1();
  const sanitized = await intermediary.sanitize(options.prompt);

  console.log(`[inspect-query] 📋 route=${sanitized.route} intent=${sanitized.intent} conf=${sanitized.confidence.toFixed(2)}`);

  if (sanitized.route === "LLM_DIRECT") {
    console.error("[inspect-query] ❌ El prompt no requiere RAG (no referencia código del proyecto). Nada que graficar.");
    db.close();
    process.exit(1);
  }

  // 2. Seleccionar estrategia
  const needsLanceDb = ["hybrid", "agentic", "agentic-standalone"].includes(options.strategy);
  let lanceDb: LaCoCoLanceDb | undefined;

  let strategy: RecoveryStrategy;
  if (needsLanceDb) {
    lanceDb = new LaCoCoLanceDb("./lancedb");
    await lanceDb.connect();
    strategy = createStrategy(options.strategy, db, options.ollama, lanceDb);
  } else {
    strategy = createStrategy(options.strategy, db, options.ollama);
  }

  console.log(`[inspect-query] 🎯 Estrategia: ${options.strategy}`);

  // 3. Recuperar chunks
  const chunks = await strategy.retrieve(sanitized);

  if (chunks.length === 0) {
    console.error("[inspect-query] ❌ La estrategia no recuperó ningún chunk. Nada que graficar.");
    db.close();
    process.exit(1);
  }

  console.log(`[inspect-query] 📦 Chunks recuperados: ${chunks.length}`);

  // 4. Extraer anchors
  const anchorScores = new Map<string, number>();
  const anchorIds: string[] = [];
  for (const chunk of chunks) {
    if (!anchorScores.has(chunk.nodeId)) {
      anchorIds.push(chunk.nodeId);
    }
    // Tomar el mejor score si un nodo aparece múltiples veces
    const prev = anchorScores.get(chunk.nodeId) ?? 0;
    anchorScores.set(chunk.nodeId, Math.max(prev, chunk.score));
  }

  console.log(`[inspect-query] 🔗 Anchors únicos: ${anchorIds.length}`);

  // 5. Expandir BFS alrededor de los anchors
  const visited = expandBFS(db.getRawDb(), anchorIds, options.budget, "ALL");
  const nodes = loadNodes(db.getRawDb(), visited);
  const edges = loadEdges(db.getRawDb(), visited);

  const stats = computeStats(nodes, edges, anchorScores);

  console.log(`[inspect-query] 📊 Subgrafo: ${stats.totalNodes} nodos, ${stats.totalEdges} aristas (${stats.anchorCount} anchors)`);

  const cytoscapeTag = await getCytoscapeTag(!options.cdn);
  const html = generateHtml({
    nodes,
    edges,
    anchors: anchorScores,
    stats,
    mode: options.mode,
    title: `LaCoCo: "${options.prompt.slice(0, 60)}"`,
    cytoscapeTag,
  });

  fs.writeFileSync(options.output, html, "utf-8");
  console.log(`[inspect-query] ✅ HTML generado → ${options.output}`);

  db.close();
}

// ──────────────────────────────────────────────────────────────────────────────
// BFS con budget y prioridad por dimensión
// ──────────────────────────────────────────────────────────────────────────────

function expandBFS(
  rawDb: Database.Database,
  rootIds: string[],
  budget: number,
  focus: Focus,
): Set<string> {
  const visited = new Set<string>(rootIds);
  const frontier = new Map<string, { dim: string | null; edgeCount: number }>();

  const stmtNeighbors = rawDb.prepare(`
    SELECT targetId AS neighbor FROM edges WHERE sourceId = ?
    UNION
    SELECT sourceId AS neighbor FROM edges WHERE targetId = ?
  `);

  const stmtDim = rawDb.prepare(
    `SELECT dimension FROM node_metadata WHERE node_id = ?`,
  );

  function getDim(nodeId: string): string | null {
    const row = stmtDim.get(nodeId) as { dimension: string } | undefined;
    return row?.dimension ?? null;
  }

  function addToFrontier(nodeId: string): void {
    const existing = frontier.get(nodeId);
    if (existing) {
      existing.edgeCount++;
    } else {
      frontier.set(nodeId, { dim: getDim(nodeId), edgeCount: 1 });
    }
  }

  // Inicializar frontera con vecinos de las raíces
  for (const rootId of rootIds) {
    const neighbors = stmtNeighbors.all(rootId, rootId) as { neighbor: string }[];
    for (const { neighbor } of neighbors) {
      if (!visited.has(neighbor)) addToFrontier(neighbor);
    }
  }

  // Expandir
  while (visited.size < budget && frontier.size > 0) {
    let bestId = "";
    let bestPriority = -Infinity;

    for (const [id, info] of frontier) {
      const p = focusPriority(info.dim, focus) + Math.min(info.edgeCount, 5) * 0.5;
      if (p > bestPriority) {
        bestPriority = p;
        bestId = id;
      }
    }

    frontier.delete(bestId);
    visited.add(bestId);

    const neighbors = stmtNeighbors.all(bestId, bestId) as { neighbor: string }[];
    for (const { neighbor } of neighbors) {
      if (!visited.has(neighbor)) addToFrontier(neighbor);
    }
  }

  return visited;
}

function focusPriority(dim: string | null, focus: Focus): number {
  if (focus === "ALL") return 1;
  if (dim === focus) return 3;
  // Segunda prioridad: la dimensión "complementaria"
  if (focus === "SYS" && dim === "CPG") return 2;
  if (focus === "CPG" && dim === "SYS") return 2;
  if (focus === "DTG" && dim === "CPG") return 2;
  return 1; // DTG en SYS, CPG en DTG, null, etc.
}

// ──────────────────────────────────────────────────────────────────────────────
// Carga de datos desde SQLite
// ──────────────────────────────────────────────────────────────────────────────

function findRootNodes(rawDb: Database.Database, name: string): string[] {
  const rows = rawDb
    .prepare(`SELECT id FROM nodes WHERE name = ?`)
    .all(name) as { id: string }[];
  return rows.map((r) => r.id);
}

function loadNodes(rawDb: Database.Database, ids: Set<string>): NodeRow[] {
  if (ids.size === 0) return [];
  const placeholders = [...ids].map(() => "?").join(",");
  return rawDb
    .prepare(
      `SELECT n.id, n.kind, n.name, n.filepath, COALESCE(n.signature, '') AS signature,
              m.dimension AS dim, m.sub_type
       FROM nodes n
       LEFT JOIN node_metadata m ON n.id = m.node_id
       WHERE n.id IN (${placeholders})`,
    )
    .all(...ids) as NodeRow[];
}

function loadEdges(rawDb: Database.Database, ids: Set<string>): EdgeRow[] {
  if (ids.size < 2) return [];
  const placeholders = [...ids].map(() => "?").join(",");
  return rawDb
    .prepare(
      `SELECT sourceId, targetId, relation
       FROM edges
       WHERE sourceId IN (${placeholders}) AND targetId IN (${placeholders})`,
    )
    .all(...ids, ...ids) as EdgeRow[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Estadísticas
// ──────────────────────────────────────────────────────────────────────────────

function computeStats(
  nodes: NodeRow[],
  edges: EdgeRow[],
  anchors: Map<string, number>,
): Stats {
  const byDim: Record<string, number> = {};
  const byKind: Record<string, number> = {};

  for (const n of nodes) {
    const dim = n.dim ?? "unknown";
    byDim[dim] = (byDim[dim] ?? 0) + 1;
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  }

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    byDim,
    byKind,
    anchorCount: anchors.size,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Generación de HTML
// ──────────────────────────────────────────────────────────────────────────────

interface HtmlParams {
  nodes: NodeRow[];
  edges: EdgeRow[];
  anchors: Map<string, number>;
  stats: Stats;
  mode: InspectMode;
  title: string;
  cytoscapeTag: string;
}

function generateHtml(params: HtmlParams): string {
  const { nodes, edges, anchors, stats, mode, title, cytoscapeTag } = params;

  const nodeElements = buildNodeElements(nodes, anchors, params.mode);
  const edgeElements = buildEdgeElements(edges);

  const graphData = JSON.stringify([...nodeElements, ...edgeElements]);
  const statsHtml = buildStatsHtml(stats);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
${cytoscapeTag}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #cy { width: 100%; height: calc(100vh - 48px); }
  #toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; background: #f0f0f0; border-bottom: 1px solid #ccc;
    font-size: 13px;
  }
  #toolbar label { font-weight: 600; }
  #toolbar select, #toolbar button {
    padding: 4px 8px; border: 1px solid #bbb; border-radius: 4px;
    background: #fff; cursor: pointer; font-size: 13px;
  }
  #toolbar button:hover { background: #e0e0e0; }
  .spacer { flex: 1; }
  #stats {
    position: fixed; top: 56px; right: 12px; z-index: 10;
    background: rgba(255,255,255,0.94); padding: 10px 14px;
    border: 1px solid #ccc; border-radius: 6px;
    font-family: "SF Mono", "Fira Code", monospace; font-size: 11px;
    max-width: 220px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    line-height: 1.6;
  }
  #stats .stitle { font-weight: 700; color: #333; margin-top: 6px; }
  #stats .stitle:first-child { margin-top: 0; }
  .legend-row { display: flex; align-items: center; margin: 1px 0; }
  .legend-swatch { width: 10px; height: 10px; margin-right: 5px; border-radius: 2px; flex-shrink: 0; }
  .legend-swatch.SYS { background: #e74c3c; }
  .legend-swatch.CPG { background: #2ecc71; }
  .legend-swatch.DTG { background: #3498db; }
  .legend-swatch.unknown { background: #95a5a6; }
  .legend-shape { display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; margin-right: 4px; flex-shrink: 0;
    font-size: 11px; line-height: 1; background: #d5d5d5; border: 1px solid #999; }
  .legend-shape.rect { border-radius: 2px; }
  .legend-shape.hex { clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%); }
  .legend-shape.ellip { border-radius: 50%; }
  .legend-shape.diam { clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); }
  .legend-shape.star { clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%); }
  .legend-shape.rrect { border-radius: 6px; }
  .legend-shape.tria { clip-path: polygon(50% 0%, 100% 100%, 0% 100%); }
  .legend-shape.rhom { clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); }
  .legend-shape.tag { clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 50% 85%, 0% 100%); }
  #tooltip {
    position: fixed; bottom: 12px; left: 12px; z-index: 20;
    background: rgba(0,0,0,0.78); color: #eee; padding: 6px 10px;
    border-radius: 4px; font-family: monospace; font-size: 12px;
    max-width: 420px; pointer-events: none; display: none;
  }
</style>
</head>
<body>

<div id="toolbar">
  <label>Layout:</label>
  <select id="layoutSelect">
    <option value="cose" selected>cose (force)</option>
    <option value="breadthfirst">breadthfirst</option>
    <option value="concentric">concentric</option>
  </select>
  <label>Mode:</label>
  <select id="modeSelect">
    <option value="default"${mode === "default" ? " selected" : ""}>default</option>
    <option value="tensor"${mode === "tensor" ? " selected" : ""}>tensor</option>
    <option value="scores"${mode === "scores" ? " selected" : ""}>scores</option>
  </select>
  <span class="spacer"></span>
  <button id="btnZoomFit">Fit</button>
  <button id="btnPng">Export PNG</button>
  <button id="btnSvg">Export SVG</button>
</div>

<div id="cy"></div>
<div id="stats">${statsHtml}</div>
<div id="tooltip"></div>

<script>
const GRAPH_DATA = ${graphData};

const STYLE_BASE = [
  { selector: "node", style: {
    "background-color": "data(color)",
    "label": "data(label)",
    "shape": "data(shape)",
    "text-valign": "center",
    "text-halign": "center",
    "font-size": "10px",
    "color": "#222",
    "text-wrap": "wrap",
    "text-max-width": "100px",
    "border-width": "data(borderWidth)",
    "border-color": "data(borderColor)",
  }},
  { selector: "edge", style: {
    "width": 1.5,
    "line-color": "data(color)",
    "target-arrow-color": "data(color)",
    "target-arrow-shape": "triangle",
    "curve-style": "bezier",
    "label": "data(label)",
    "font-size": "8px",
    "color": "#444",
    "text-rotation": "autorotate",
  }},
  { selector: "node[anchor = 1]", style: {
    "border-width": 3,
    "border-color": "#000",
    "font-weight": "bold",
  }},
];

const STYLE_TENSOR = [
  { selector: "node", style: {
    "background-color": "data(color)",
  }},
  { selector: "edge", style: {
    "width": 1.5,
    "line-color": "data(color)",
    "target-arrow-color": "data(color)",
    "target-arrow-shape": "triangle",
    "curve-style": "bezier",
    "label": "data(label)",
    "font-size": "8px",
    "color": "#444",
    "text-rotation": "autorotate",
  }},
  { selector: "node[anchor = 1]", style: {
    "border-width": 3,
    "border-color": "#000",
    "font-weight": "bold",
  }},
];

const STYLE_SCORES = [
  { selector: "node", style: {
    "width": "mapData(score, 0, 1, 20, 65)",
    "height": "mapData(score, 0, 1, 20, 65)",
  }},
];

const LAYOUTS = {
  cose: { name: "cose", animate: false, nodeRepulsion: 4000, idealEdgeLength: 80 },
  breadthfirst: { name: "breadthfirst", directed: true, spacingFactor: 1.2 },
  concentric: { name: "concentric", minNodeSpacing: 60, concentric: function(n) {
    return n.data("depth") || 0;
  }, levelWidth: function() { return 1; }},
};

// Init
const cy = cytoscape({
  container: document.getElementById("cy"),
  elements: GRAPH_DATA,
  style: buildStyle("${mode}"),
  layout: LAYOUTS.cose,
  wheelSensitivity: 0.3,
});

// Layout switch
document.getElementById("layoutSelect").addEventListener("change", function() {
  const name = this.value;
  cy.stop(); // stop any running layout
  cy.layout(LAYOUTS[name] || { name: name }).run();
});

// Mode switch
document.getElementById("modeSelect").addEventListener("change", function() {
  const mode = this.value;
  cy.style(buildStyle(mode));
});

// Buttons
document.getElementById("btnZoomFit").addEventListener("click", function() {
  cy.fit(undefined, 30);
});
document.getElementById("btnPng").addEventListener("click", function() {
  const b64 = cy.png({ full: true, scale: 2, bg: "#fff" });
  const a = document.createElement("a");
  a.href = b64;
  a.download = "lacoco-graph.png";
  a.click();
});
document.getElementById("btnSvg").addEventListener("click", function() {
  const svg = cy.svg({ full: true, scale: 1 });
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "lacoco-graph.svg";
  a.click();
  URL.revokeObjectURL(url);
});

// Tooltip on hover
const tooltip = document.getElementById("tooltip");
cy.on("mouseover", "node", function(evt) {
  const n = evt.target;
  const dim = n.data("dim") || "?";
  const kind = n.data("kind") || "?";
  const file = n.data("file") || "";
  const sig = n.data("signature") || "";
  const score = n.data("score");
  const anchor = n.data("anchor");
  let html = "<b>" + esc(n.data("label")) + "</b> [" + kind + " | " + dim + "]";
  if (anchor) html += " <span style='color:#e74c3c'>★anchor</span>";
  if (score > 0) html += " score=" + score.toFixed(3);
  if (sig) html += "<br>" + esc(sig.slice(0, 120));
  if (file) html += "<br><span style='color:#999'>" + esc(file) + "</span>";
  tooltip.innerHTML = html;
  tooltip.style.display = "block";
});
cy.on("mouseout", "node", function() {
  tooltip.style.display = "none";
});
cy.on("mouseover", "edge", function(evt) {
  const e = evt.target;
  const edgeDim = e.data("edgeDim") || "?";
  tooltip.innerHTML = "<b>" + esc(e.data("label")) + "</b> [" + edgeDim + "]";
  tooltip.style.display = "block";
});
cy.on("mouseout", "edge", function() {
  tooltip.style.display = "none";
});

// Assign depth for concentric layout
function assignDepth() {
  // Simple BFS depth from anchors (or roots — nodes with score>0)
  const roots = cy.nodes().filter(function(_ele, i) {
    return this.data("anchor") === 1 || i === 0;
  });
  cy.nodes().forEach(function(n) { n.data("depth", 9999); });
  const visited = {};
  let frontier = [];
  roots.forEach(function(r) {
    r.data("depth", 0);
    visited[r.id()] = true;
    frontier.push(r);
  });
  let depth = 0;
  while (frontier.length > 0) {
    depth++;
    const next = [];
    frontier.forEach(function(n) {
      n.connectedEdges().forEach(function(e) {
        const other = e.source().id() === n.id() ? e.target() : e.source();
        if (!visited[other.id()]) {
          visited[other.id()] = true;
          other.data("depth", depth);
          next.push(other);
        }
      });
    });
    frontier = next;
  }
}
assignDepth();

function buildStyle(mode) {
  var s = STYLE_BASE.slice();
  if (mode === "tensor") s = s.concat(STYLE_TENSOR);
  if (mode === "scores") s = s.concat(STYLE_SCORES);
  return s;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
</script>
</body>
</html>`;
}

// ── Helpers de construcción de elementos Cytoscape ───────────────────────────

function buildNodeElements(
  nodes: NodeRow[],
  anchors: Map<string, number>,
  mode: InspectMode,
): Record<string, unknown>[] {
  return nodes.map((n) => {
    const score = anchors.get(n.id) ?? 0;
    const isAnchor = anchors.has(n.id);
    const dim = n.dim ?? "unknown";
    const color = mode === "tensor"
      ? NODE_GRAY
      : isAnchor
        ? scoreColor(score)
        : NODE_GRAY;
    const shape = KIND_SHAPES[n.kind] ?? "ellipse";

    return {
      data: {
        id: n.id,
        label: n.name,
        color,
        shape,
        score,
        anchor: isAnchor ? 1 : 0,
        dim,
        kind: n.kind,
        file: n.filepath,
        signature: n.signature,
        borderWidth: isAnchor ? 3 : 1,
        borderColor: isAnchor ? "#000" : "#888",
      },
    };
  });
}

function buildEdgeElements(
  edges: EdgeRow[],
): Record<string, unknown>[] {
  return edges.map((e) => {
    const edgeDim = getEdgeDim(e.relation);
    const color = DIM_COLORS[edgeDim] ?? DIM_GRAY;

    return {
      data: {
        id: `${e.sourceId}__${e.relation}__${e.targetId}`,
        source: e.sourceId,
        target: e.targetId,
        label: e.relation,
        color,
        edgeDim,
      },
    };
  });
}

function scoreColor(score: number): string {
  // 0.0 → #27ae60 (verde), 1.0 → #e74c3c (rojo)
  const s = Math.max(0, Math.min(1, score));
  const r = Math.round(39 + 192 * s);
  const g = Math.round(174 - 98 * s);
  const b = Math.round(96 - 36 * s);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ── Stats HTML ───────────────────────────────────────────────────────────────

function buildStatsHtml(stats: Stats): string {
  const kindEntries = Object.entries(stats.byKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const kindLines = kindEntries
    .map(([k, v]) => `<div>${k}: ${v}</div>`)
    .join("");

  let anchorLine = "";
  if (stats.anchorCount > 0) {
    anchorLine = `<div>★ anchors: ${stats.anchorCount}</div>`;
  }

  return `<div class="stitle">📊 Stats</div>
<div>Nodes: ${stats.totalNodes}</div>
<div>Edges: ${stats.totalEdges}</div>
${anchorLine}
<div class="stitle">📐 Tipos de nodo</div>
${kindLines}
<div class="stitle">🔗 Relaciones (color)</div>
<div class="legend-row"><span class="legend-swatch SYS"></span>SYS — ecosistema</div>
<div class="legend-row"><span class="legend-swatch CPG"></span>CPG — control</div>
<div class="legend-row"><span class="legend-swatch DTG"></span>DTG — datos</div>
<div class="legend-row"><span class="legend-swatch unknown"></span>desconocido</div>`;
}

// ── Cytoscape embebido vs CDN ────────────────────────────────────────────────

async function getCytoscapeTag(standalone: boolean): Promise<string> {
  if (!standalone) {
    return `<script src="${CYTOSCAPE_CDN}"></script>`;
  }

  const cacheDir = path.join(os.homedir(), ".cache", "lacoco");
  const cacheFile = path.join(cacheDir, `cytoscape@${CYTOSCAPE_VERSION}.min.js`);

  if (fs.existsSync(cacheFile)) {
    const content = fs.readFileSync(cacheFile, "utf-8");
    return `<script>${content}</script>`;
  }

  console.log(`[inspect] 📥 Descargando Cytoscape.js ${CYTOSCAPE_VERSION} (one-time cache)...`);
  try {
    const response = await fetch(CYTOSCAPE_CDN);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = await response.text();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, content, "utf-8");
    console.log(`[inspect] 💾 Cache guardado → ${cacheFile}`);
    return `<script>${content}</script>`;
  } catch (err) {
    console.warn(`[inspect] ⚠️  No se pudo descargar Cytoscape.js. Usando CDN como fallback.`);
    console.warn(`[inspect]    Error: ${err instanceof Error ? err.message : String(err)}`);
    return `<script src="${CYTOSCAPE_CDN}"></script>`;
  }
}

// ── Factory de estrategias ───────────────────────────────────────────────────

function createStrategy(
  name: string,
  db: LaCoCoDatabase,
  ollamaEndpoint: string,
  lanceDb?: LaCoCoLanceDb,
): RecoveryStrategy {
  switch (name) {
    case "bm25":
      return new BM25Strategy(db);
    case "bm25-dim":
      return new BM25DimFilterStrategy(db);
    case "hybrid":
      if (!lanceDb) throw new Error("LanceDB requerido para hybrid strategy");
      return new HybridStrategy(db, lanceDb);
    case "agentic":
      return new AgenticStrategy(db, ollamaEndpoint);
    case "agentic-standalone":
      return new AgenticStandaloneStrategy(db, ollamaEndpoint);
    default:
      if (lanceDb) return new HybridStrategy(db, lanceDb);
      return new BM25Strategy(db);
  }
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
