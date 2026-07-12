#!/usr/bin/env bash
# A/B gen13: no_context vs hook-firmas(v1) vs hook-snippets(v2) vs mcp-on-demand.
# Modelo deepseek-v4-pro, techo ~$8 (repartido por variante; --resume continúa si se corta).
#
# Paraleliza lo SEGURO: re-index (repos ya registrados) y las 3 corridas de retrieval.
# La GENERACIÓN es secuencial entre variantes: comparten los working trees de repos-jina
# y cada celda hace `git reset` del repo → correrlas en paralelo corrompería el árbol.
#
# Uso:  bash eval/run-ab-snippets.sh                 # completo
#       PREP_ONLY=1 bash eval/run-ab-snippets.sh     # solo local/gratis (build+index+retrieval)
#       IDX_JOBS=2 bash eval/run-ab-snippets.sh      # baja el paralelismo de index si hay poca RAM
set -euo pipefail
cd "$(dirname "$0")/.."

export LACOCO_EVAL_MANIFESTS_DIR="eval/manifests/swe-polybench-15"   # aquí viven gen13/genAB/gen13_mcp
export LACOCO_EVAL_OPENCODE_MODEL="opencode-go/deepseek-v4-pro"
export LACOCO_EMBEDDING_MODEL="jinaai/jina-embeddings-v2-base-code"
export LACOCO_EMBEDDING_DIM=768
export LACOCO_EMBEDDING_QUANTIZED=false
# Cap del texto a embeber: prettier tiene nodos con firmas de ~80k chars (object
# literals volcados) que pad-ean el batch de Jina y disparan OOM. Capar a 2000
# acota el pico sin afectar a los nodos normales (avg ~200-800 chars).
export LACOCO_EMBEDDING_MAX_CHARS="${LACOCO_EMBEDDING_MAX_CHARS:-2000}"
# Jina (768d) embebiendo repos grandes (prettier/mui) es MUY pesado en RAM: en
# paralelo el index_vectors se mata por OOM (código 137). Default SECUENCIAL.
# Súbelo solo si tienes RAM de sobra (>32GB) y repos chicos.
IDX_JOBS="${IDX_JOBS:-1}"
GEN_JOBS="${GEN_JOBS:-4}"   # repos en paralelo dentro de cada variante de generación

GEN13_REPOS=(svelte-510 svelte-728 svelte-906 svelte-907 svelte-1116 \
  prettier-14400 prettier-12930 prettier-6604 prettier-5025 prettier-4667 \
  material-ui-11451 material-ui-11858 material-ui-12406)

echo "== 0. Build (dist para el servidor MCP) =="
npm run build

echo "== 1. Re-index de los 13 repos (puebla startLine/endLine — migración 006) =="
# Preparar SOLO los 13 (per-repo y tolerante): el manifiesto trae 15 e incluye
# material-ui-13690/13778 (flatmap-stream despublicado → install irrecuperable);
# prepararlos todos junta hace fallar todo el paso.
for repo in "${GEN13_REPOS[@]}"; do
  npm run --silent eval:prepare -- --run-id ab-snippets --repo-id "$repo" \
    || echo "  ⚠ prepare falló en $repo (revisa eval/runs/ab-snippets/logs/prepare/$repo/); continúo"
done
# Indexar (graph puebla las líneas; vectors re-embebe Jina). SECUENCIAL por RAM.
printf '%s\n' "${GEN13_REPOS[@]}" | xargs -P "$IDX_JOBS" -I{} \
  sh -c 'echo "  -- index {}"; npm run --silent eval:index -- --run-id ab-snippets --repo-id {} \
    || echo "  ⚠ index falló en {} (revisa el log); continúo"'

echo "== 2. Retrieval de las 3 variantes EN PARALELO (local; usa el SLM local → Ollama vivo) =="
# Los prepares (locks) son rápidos y van secuenciales; las 3 retrievals corren en paralelo.
npm run eval:prepare -- --run-id genAB-v1
npm run eval:prepare -- --run-id genAB-v2
npm run eval:prepare -- --run-id genAB-mcp

LACOCO_CONTEXT_TEMPLATE=v1 \
  npm run eval:retrieval -- --run-id genAB-v1 --split genAB > eval/runs/ret-v1.log 2>&1 &
PID_V1=$!
LACOCO_CONTEXT_TEMPLATE=v2 LACOCO_CONTEXT_MAX_TOKENS=12000 \
  npm run eval:retrieval -- --run-id genAB-v2 --split genAB > eval/runs/ret-v2.log 2>&1 &
PID_V2=$!
npm run eval:retrieval -- --run-id genAB-mcp --split gen13_mcp > eval/runs/ret-mcp.log 2>&1 &
PID_MCP=$!
wait $PID_V1 $PID_V2 $PID_MCP
echo "  retrieval OK (logs: eval/runs/ret-{v1,v2,mcp}.log)"

if [[ "${PREP_ONLY:-0}" == "1" ]]; then echo "PREP_ONLY: listo (sin generación)"; exit 0; fi

echo "== 3. Generación (variantes en SERIE; dentro de cada una, repos EN PARALELO) =="
# Las 4 variantes comparten repos-jina → NO se paralelizan entre sí. Pero dentro de
# cada variante los 13 repos son distintos → corren N en paralelo (--max-parallel-repos).
# Variantes 1+2 (no_context + hybrid v1). ~26 celdas.
npm run eval:generation -- --run-id genAB-v1 --split genAB --max-budget-usd 3.5 --max-parallel-repos "$GEN_JOBS" --resume
# Variante 3 (hybrid v2, snippets). Solo hybrid. ~13 celdas.
npm run eval:generation -- --run-id genAB-v2 --split genAB --strategy-id hybrid --max-budget-usd 2.0 --max-parallel-repos "$GEN_JOBS" --resume
# Variante 4 (MCP bajo demanda). ~13 celdas.
npm run eval:generation -- --run-id genAB-mcp --split gen13_mcp --max-budget-usd 2.5 --max-parallel-repos "$GEN_JOBS" --resume

echo "== 4. Métricas =="
for rid in genAB-v1 genAB-v2 genAB-mcp; do npm run eval:metrics:generation -- --run-id "$rid" || true; done
echo "Resultados: eval/runs/{genAB-v1,genAB-v2,genAB-mcp}/generation-summary.md"
