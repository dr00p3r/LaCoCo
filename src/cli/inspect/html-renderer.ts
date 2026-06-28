import { RELATION_TO_DIM } from "../../domain/dimensions.js";
import type {
  CytoscapeEdgeElement,
  CytoscapeNodeElement,
  InspectEdge,
  InspectMode,
  InspectNode,
  InspectStats,
} from "./types.js";

const DIM_COLORS: Record<string, string> = {
  SYS: "#e74c3c",
  CPG: "#2ecc71",
  DTG: "#3498db",
};
const DIM_GRAY = "#95a5a6";
const NODE_GRAY = "#aaaaaa";
const KIND_SHAPES: Record<string, string> = {
  CLASS: "rectangle", INTERFACE: "hexagon", FUNCTION: "ellipse",
  ARROW_FUNCTION: "ellipse", METHOD: "ellipse", TYPE: "diamond",
  ENUM: "round-rectangle", ENUM_MEMBER: "triangle", VARIABLE: "rhomboid",
  PROPERTY: "rhomboid", ACCESSOR: "tag", EXTERNAL_LIB: "star",
};

function getEdgeDim(relation: string): string {
  return RELATION_TO_DIM[relation] ?? "unknown";
}

export interface HtmlParams {
  nodes: InspectNode[];
  edges: InspectEdge[];
  anchors: Map<string, number>;
  stats: InspectStats;
  mode: InspectMode;
  title: string;
  cytoscapeTag: string;
}

export function generateHtml(params: HtmlParams): string {
  const { nodes, edges, anchors, stats, mode, title, cytoscapeTag } = params;

  const nodeElements = buildNodeElements(nodes, anchors, params.mode);
  const edgeElements = buildEdgeElements(edges);

  const graphData = JSON.stringify([...nodeElements, ...edgeElements]);
  const statsHtml = buildInspectStatsHtml(stats);

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
  nodes: InspectNode[],
  anchors: Map<string, number>,
  mode: InspectMode,
): CytoscapeNodeElement[] {
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
  edges: InspectEdge[],
): CytoscapeEdgeElement[] {
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

// ── InspectStats HTML ───────────────────────────────────────────────────────────────

function buildInspectStatsHtml(stats: InspectStats): string {
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

  return `<div class="stitle">📊 InspectStats</div>
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


function escHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

