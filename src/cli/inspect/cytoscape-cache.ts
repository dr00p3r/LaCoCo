import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CYTOSCAPE_VERSION = "3.33.1";
const CYTOSCAPE_CDN = `https://unpkg.com/cytoscape@${CYTOSCAPE_VERSION}/dist/cytoscape.min.js`;

export async function getCytoscapeTag(standalone: boolean): Promise<string> {
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


