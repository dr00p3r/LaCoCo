#!/usr/bin/env bash
# Reproductor del benchmark benchmulti (SOLO retrieval) — corre en una terminal normal
# (sin el limite de ~2 min/proceso del entorno del agente):
#
#   bash eval/scripts/run-benchmulti.sh 2>&1 | tee /tmp/benchmulti.log
#
# Mide DOS regimenes en dos run-ids separados, con las 8 estrategias deterministas:
#   1) SINGLE-HOP (num_nodes==1): split benchmulti, 22 repos. connector empata baselines
#      por diseno (el gold es el ancla).
#   2) MULTI-HOP  (num_nodes 2-4): split benchmulti_mh, 16 repos. Regimen donde connector
#      (SCR) DEBE separarse (hay que conectar anclas por el grafo).
# Compara eval/runs/<run>/summary.md de ambos.
#
# Idempotente: index-repos re-embebe si se lo pides; borrar un index fuerza su rebuild.
# El tramo lento es index (embedding Jina, ~min/repo). prepare es rapido (clone-reuse).
set -u
cd "$(dirname "$0")/../.."
MD=eval/manifests/swe-polybench-multi

# ---- Regimen SINGLE-HOP ----
RUN_SH=2026-07-10-benchmulti
SH_ALL=(
  material-ui-11451 material-ui-11858 material-ui-12406 material-ui-13690 material-ui-13778
  svelte-510 svelte-728 svelte-906 svelte-907 svelte-1116
  prettier-14400 prettier-12930 prettier-6604 prettier-5025 prettier-4667
  serverless-8159 serverless-7617 serverless-7587 serverless-7374 serverless-6842
  code-server-4923 code-server-6278
)
# Los 15 mui/svelte/prettier ya tienen indice Jina valido; solo indexar los 7 nuevos.
SH_INDEX=(serverless-8159 serverless-7617 serverless-7587 serverless-7374 serverless-6842 code-server-4923 code-server-6278)

# ---- Regimen MULTI-HOP (commits distintos → todos requieren index) ----
RUN_MH=2026-07-10-benchmulti-mh
MH_ALL=(
  material-ui-11987 material-ui-12236 material-ui-12303 material-ui-13534
  svelte-464 svelte-477 svelte-630 svelte-1095
  serverless-7277 serverless-6987 serverless-6869 serverless-6366
  prettier-11637 prettier-9850 prettier-8046 prettier-666
)

run_phase () {  # $1=run-id  $2=split  $3=nombre-array-prepare  $4=nombre-array-index
  local run="$1" split="$2"; local -n prep="$3"; local -n idx="$4"
  echo "===== [$split] PREPARE (${#prep[@]}) $(date +%H:%M:%S) ====="
  for id in "${prep[@]}"; do
    npm run eval:prepare -- --manifests-dir "$MD" --run-id "$run" --repo-id "$id" >/dev/null 2>&1
    echo "  prepare $id exit=$? .git=$([ -d eval/workdir/repos-jina/$id/.git ] && echo ok || echo NO)"
  done
  echo "===== [$split] INDEX (${#idx[@]}, embedding Jina) $(date +%H:%M:%S) ====="
  for id in "${idx[@]}"; do
    echo "  [$id] index start $(date +%H:%M:%S)"
    npm run eval:index -- --manifests-dir "$MD" --run-id "$run" --repo-id "$id" >/dev/null 2>&1
    echo "  [$id] index exit=$? $(date +%H:%M:%S) sqlite=$([ -f eval/workdir/indexes-jina/$id/tensor.sqlite ] && echo y || echo N) lancedb=$([ -d eval/workdir/indexes-jina/$id/lancedb ] && echo y || echo N)"
  done
  echo "===== [$split] RETRIEVAL (8 estrategias) $(date +%H:%M:%S) ====="
  npm run eval:retrieval -- --manifests-dir "$MD" --run-id "$run" --split "$split" --sanitizer-variant deterministic 2>&1 | tail -3
  echo "===== [$split] METRICS $(date +%H:%M:%S) ====="
  npm run eval:metrics:retrieval -- --manifests-dir "$MD" --run-id "$run" 2>&1 | tail -3
  npm run eval:compare:strategies -- --manifests-dir "$MD" --run-id "$run" 2>&1 | tail -2
  echo "  -> eval/runs/$run/summary.md"
}

echo "########## SINGLE-HOP ##########"
run_phase "$RUN_SH" benchmulti SH_ALL SH_INDEX

echo "########## MULTI-HOP ##########"
run_phase "$RUN_MH" benchmulti_mh MH_ALL MH_ALL

echo "===== DONE $(date +%H:%M:%S) ====="
echo "single-hop: eval/runs/$RUN_SH/summary.md"
echo "multi-hop : eval/runs/$RUN_MH/summary.md"
echo "Compara la fila 'connector' entre ambos: en multi-hop debe separarse de hybrid/ppr."
