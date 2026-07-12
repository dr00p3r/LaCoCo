#!/usr/bin/env bash
# Reproductor del benchmark de 10 repos (>1000★) — la MEDIDA de la tesis (breadth).
# Corre en una terminal NORMAL (sin el límite de ~2 min/proceso del entorno del agente):
#
#   bash eval/scripts/run-bench10.sh 2>&1 | tee /tmp/bench10.log
#
# 10 repos GitHub distintos, todos gold a nivel SÍMBOLO (uniformes):
#   - 5 SWE-PolyBench (símbolo nativo vía modified_nodes):
#       mui/material-ui, sveltejs/svelte, serverless/serverless, prettier/prettier, microsoft/vscode
#   - 5 Multi-SWE-bench (símbolo DERIVADO del diff en enrich-gold-symbols):
#       iamkun/dayjs, anuraghazra/github-readme-stats, axios/axios, expressjs/express, Kong/insomnia
#
# Dos regímenes en dos run-ids (retrieval TRUNCA retrieval.jsonl → un run-id por split):
#   1) MULTI-HOP  (fix toca >=2 símbolos): split bench10_mh. connector/SCR DEBE separar.
#   2) SINGLE-HOP (fix toca 1 símbolo):    split bench10_sh. control, baselines empatan.
# El régimen se decide por # de edited_symbols DESPUÉS de enrich (uniforme entre datasets).
#
# Idempotente. Tramo lento = index (embedding Jina, ~min/repo-instancia). Ajusta los
# límites por repo con las env vars de abajo para balancear poder estadístico vs costo.
set -u
cd "$(dirname "$0")/../.."

MD=eval/manifests/swe-polybench-10repos
RUN_MH=${RUN_MH:-2026-07-11-bench10-mh}
RUN_SH=${RUN_SH:-2026-07-11-bench10-sh}

SP_DATA=eval/data/swe-polybench/instances.tsjs.full.jsonl
MSWE_DATA=eval/data/multi-swe-bench/instances.normalized.jsonl

# Repos SWE-PolyBench (slug) y cuántas instancias por repo importar de cada régimen.
# Elección: mui (46, profundidad) + svelte/serverless/prettier + coder/code-server.
# Se descartó microsoft/vscode (gigante, clone lento) por code-server (mirror ya existe).
SP_REPOS=(mui/material-ui sveltejs/svelte serverless/serverless prettier/prettier coder/code-server)
SP_MH_LIMIT=${SP_MH_LIMIT:-12}  # num_nodes 2-4 (multi-hop); mui tiene 46 → sube profundidad
SP_SH_LIMIT=${SP_SH_LIMIT:-6}   # num_nodes==1 (single-hop)

# Repos Multi-SWE-bench (slug) y tope por repo (el régimen lo decide enrich por símbolos).
# dayjs (56) es la fuente principal de MH: un fix que toca ≥2 funciones = ≥2 símbolos.
MSWE_REPOS=(iamkun/dayjs anuraghazra/github-readme-stats axios/axios expressjs/express Kong/insomnia)
MSWE_LIMIT=${MSWE_LIMIT:-30}

echo "########## 0) FETCH Multi-SWE-bench ##########"
if [ ! -f "$MSWE_DATA" ]; then
  python3 eval/scripts/swe-polybench/fetch_multi_swe_bench.py
else
  echo "  $MSWE_DATA ya existe (borra para re-bajar)."
fi

echo "########## 1) IMPORT (ambos datasets → $MD, --append) ##########"
# Reset idempotente de los manifests GENERADOS (tasks/repos/patches) para no arrastrar
# instancias de corridas previas (p. ej. un repo que se cambió de la lista). run.yaml y
# los SHARED_MANIFESTS los preserva el append-guard; el índice del workdir NO se toca.
rm -f "$MD/tasks.yaml" "$MD/repos.yaml"; rm -rf "$MD/patches"; mkdir -p "$MD/patches"
for slug in "${SP_REPOS[@]}"; do
  npm run eval:import:swe-polybench -- --data-file "$SP_DATA" --repo "$slug" --out-dir "$MD" --only-mixed --limit "$SP_MH_LIMIT" --append 2>&1 | tail -1
  npm run eval:import:swe-polybench -- --data-file "$SP_DATA" --repo "$slug" --out-dir "$MD" --limit "$SP_SH_LIMIT" --append 2>&1 | tail -1
done
for slug in "${MSWE_REPOS[@]}"; do
  npx tsx eval/scripts/import-multi-swe-bench.ts --data-file "$MSWE_DATA" --repo "$slug" --out-dir "$MD" --limit "$MSWE_LIMIT" --append 2>&1 | tail -1
done

# Sube el timeout de clone/install en el bundle: el mirror blobless de repos GIGANTES
# (mui/material-ui, microsoft/vscode) tarda >15 min y el default (900s) lo mata a media
# descarga (SIGTERM → "fetch-pack: unexpected disconnect"). Se re-parchea tras cada
# import porque writeReposManifest regenera repos.yaml desde el canónico (900s).
CLONE_TIMEOUT_MS=${CLONE_TIMEOUT_MS:-2400000}   # 40 min
npx tsx -e 'import{readFileSync,writeFileSync}from"node:fs";import{parseDocument}from"yaml";const d=parseDocument(readFileSync(process.argv[1],"utf8"));d.setIn(["defaults","install","timeout_ms"],Number(process.argv[2]));writeFileSync(process.argv[1],d.toString(),"utf8");console.log("  defaults.install.timeout_ms =",process.argv[2]);' "$MD/repos.yaml" "$CLONE_TIMEOUT_MS"

# Ids de repos a preparar/indexar = todas las entradas de repos.yaml del bundle.
mapfile -t REPO_IDS < <(npx tsx -e 'import{readFileSync}from"node:fs";import{parse}from"yaml";for(const r of (parse(readFileSync(process.argv[1],"utf8")).repositories??[]))console.log(r.id);' "$MD/repos.yaml")
echo "  repos-instancia a preparar/indexar: ${#REPO_IDS[@]}"

PREPARED=()  # ids con checkout .git tras prepare (los que llegan a index/retrieval)
prepare_all () {  # $1=run-id  $2=collect(1 para poblar PREPARED)
  local run="$1" collect="$2" rc ej
  echo "===== PREPARE ($run, ${#REPO_IDS[@]}) $(date +%H:%M:%S) ====="
  for id in "${REPO_IDS[@]}"; do
    npm run eval:prepare -- --manifests-dir "$MD" --run-id "$run" --repo-id "$id" >/dev/null 2>&1
    rc=$?
    if [ -d "eval/workdir/repos-jina/$id/.git" ]; then
      [ "$collect" = "1" ] && PREPARED+=("$id")
    else
      echo "  prepare $id FALLÓ (exit=$rc):"
      ej="eval/runs/$run/logs/prepare/$id/error.json"
      [ -f "$ej" ] && npx tsx -e 'import{readFileSync}from"node:fs";try{console.log("    "+(JSON.parse(readFileSync(process.argv[1],"utf8")).message||"").slice(0,240))}catch{}' "$ej"
    fi
  done
}

echo "########## 2) PREPARE (ambos run-ids; clone-reuse) ##########"
prepare_all "$RUN_MH" 1
prepare_all "$RUN_SH" 0
echo "  preparados OK: ${#PREPARED[@]}/${#REPO_IDS[@]}"

echo "########## 3) ENRICH gold-símbolo (deriva edited_symbols de Multi-SWE-bench) ##########"
# Usa el checkout base del lock de RUN_MH (los checkouts del workdir son compartidos).
npm run eval:enrich:gold-symbols -- --manifests-dir "$MD" --run-id "$RUN_MH" 2>&1 | tail -8

echo "########## 4) BUILD SPLITS bench10_mh/bench10_sh (por # de símbolos) ##########"
npx tsx eval/scripts/build-bench10-splits.ts --manifests-dir "$MD" 2>&1 | tail -20

echo "########## 5) INDEX (embedding Jina, LENTO — una sola vez, workdir compartido) ##########"
echo "  indexando ${#PREPARED[@]} repo(s) preparados OK"
for id in "${PREPARED[@]}"; do
  if [ -f "eval/workdir/indexes-jina/$id/tensor.sqlite" ] && [ -d "eval/workdir/indexes-jina/$id/lancedb" ]; then
    echo "  [$id] index ya presente, skip"
    continue
  fi
  echo "  [$id] index start $(date +%H:%M:%S)"
  npm run eval:index -- --manifests-dir "$MD" --run-id "$RUN_MH" --repo-id "$id" >/dev/null 2>&1
  echo "  [$id] index exit=$? sqlite=$([ -f eval/workdir/indexes-jina/$id/tensor.sqlite ] && echo y || echo N) lancedb=$([ -d eval/workdir/indexes-jina/$id/lancedb ] && echo y || echo N)"
done

retrieval_phase () {  # $1=run-id  $2=split
  local run="$1" split="$2"
  echo "===== [$split] RETRIEVAL (8 estrategias) $(date +%H:%M:%S) ====="
  npm run eval:retrieval -- --manifests-dir "$MD" --run-id "$run" --split "$split" --sanitizer-variant deterministic 2>&1 | tail -4
  echo "===== [$split] METRICS $(date +%H:%M:%S) ====="
  npm run eval:metrics:retrieval -- --manifests-dir "$MD" --run-id "$run" 2>&1 | tail -3
  npm run eval:compare:strategies -- --manifests-dir "$MD" --run-id "$run" 2>&1 | tail -2
  echo "  -> eval/runs/$run/summary.md"
}

echo "########## 6) RETRIEVAL + METRICS (un run-id por régimen) ##########"
retrieval_phase "$RUN_MH" bench10_mh
retrieval_phase "$RUN_SH" bench10_sh

echo "########## 7) GENERACIÓN Pass@1 (opt-in BENCH10_GEN=1; cuesta \$) ##########"
# Default OFF: el build de retrieval (gratis) queda intacto. Actívalo con:
#   BENCH10_GEN=1 GEN_BUDGET=8 bash eval/scripts/run-bench10.sh
# Corre con el MISMO run-id que el retrieval MH (RUN_MH) para que findRetrievalRecord
# halle el contexto pre-inyectado (connector/hybrid). Prioriza multi-hop.
if [ "${BENCH10_GEN:-0}" = "1" ]; then
  # El servidor MCP (opencode_mcp → lacoco_retrieve) corre desde dist/: build primero.
  echo "  build dist/ (servidor MCP lacoco) ..."
  if npm run build >/dev/null 2>&1; then
    echo "  build OK"
    GEN_BUDGET=${GEN_BUDGET:-8}
    GEN_PARALLEL=${GEN_PARALLEL:-1}
    echo "===== [bench10_mh_gen] GENERATION (run=$RUN_MH, budget=\$$GEN_BUDGET, parallel=$GEN_PARALLEL) $(date +%H:%M:%S) ====="
    npm run eval:generation -- --manifests-dir "$MD" --run-id "$RUN_MH" --split bench10_mh_gen \
      --max-budget-usd "$GEN_BUDGET" --max-parallel-repos "$GEN_PARALLEL" --resume 2>&1 | tail -10
    echo "===== [bench10_mh_gen] METRICS $(date +%H:%M:%S) ====="
    npm run eval:metrics:generation -- --manifests-dir "$MD" --run-id "$RUN_MH" 2>&1 | tail -6
    echo "  -> generación en eval/runs/$RUN_MH/"
  else
    echo "  build FALLÓ → generación ABORTADA (el servidor MCP necesita dist/)."
  fi
else
  echo "  BENCH10_GEN!=1 → generación OMITIDA (solo retrieval)."
fi

echo "===== DONE $(date +%H:%M:%S) ====="
echo "multi-hop : eval/runs/$RUN_MH/summary.md"
echo "single-hop: eval/runs/$RUN_SH/summary.md"
echo "Contrasta la fila 'connector' entre ambos: en bench10_mh debe separarse de hybrid/ppr;"
echo "en bench10_sh debe empatar (efecto régimen-dependiente)."
