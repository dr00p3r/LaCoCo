#!/usr/bin/env bash
# Matriz de generación bench10 (Pass@1): 5 brazos × 2 backends de modelo.
#   Brazos: no_context | connector | consensus  (agente plano)
#           connector+MCP | consensus+MCP        (agente MCP, hint SUAVE)
#   Modelos: Claude Code / Sonnet (no-1M)  ·  Opencode / opencode-go/deepseek-v4-pro
#
# Todo sobre UN run-id (reusa el retrieval de bench10-mh → contexto pre-inyectado).
# Brazos como invocaciones filtradas (--agent-id / --strategy-id) con --resume, keyed
# por (task,strategy,agent,model). Métricas separadas por --agent-id (aggregate agrupa
# solo por strategy → sin filtro mezclaría plain/mcp y los 2 modelos).
#
# COSTO: solo opencode reporta coste → --max-budget-usd solo en brazos opencode; Claude
# va por Max (sin tope). Rotación de key de opencode si una se agota.
#
# SECRETS: las keys de opencode se pasan por env OC_KEY_1 / OC_KEY_2 (NO viven en este
# archivo). El script las escribe en ~/.local/share/opencode/auth.json (fuera del repo).
#
# Uso:
#   OC_KEY_1=... OC_KEY_2=... nohup bash eval/run-bench10-genmatrix.sh > eval/runs/genmatrix.out 2>&1 &
#   SMOKE=dayjs-1202 OC_KEY_1=... bash eval/run-bench10-genmatrix.sh   # 1 tarea, validación
set -uo pipefail   # NO -e: los brazos son tolerantes (algún fallo de celda no aborta)
cd "$(dirname "$0")/.."

MD="eval/manifests/swe-polybench-10repos"
RID="${RID:-2026-07-11-bench10-mh}"
SPLIT="${SPLIT:-bench10_mh_gen}"
OC_PARALLEL="${OC_PARALLEL:-6}"
CLAUDE_PARALLEL="${CLAUDE_PARALLEL:-3}"   # claude más conservador (contención de sesión)
OC_BUDGET="${OC_BUDGET:-22}"
# deepseek-v4-pro normalmente termina en ~3min, pero ocasionalmente hace loop; 900s de
# timeout de AGENTE le da margen sin doblar coste (el timeout de TEST sigue en el yaml=600s).
OC_TIMEOUT_MS="${OC_TIMEOUT_MS:-900000}"
# Timeout de AGENTE para Claude (no el de tests, que sigue en run.yaml=600s). El brazo MCP
# hace muchas tool-calls y el default de 600s deja algunas consensus a medias; 900s (= opencode)
# le da margen sin cambiar el timeout de tests.
CLAUDE_TIMEOUT_MS="${CLAUDE_TIMEOUT_MS:-900000}"
RUNDIR="eval/runs/$RID"

export LACOCO_EVAL_OPENCODE_MODEL="opencode-go/deepseek-v4-pro"
# Modelo de los brazos Claude: override por env (LACOCO_EVAL_CLAUDE_MODEL=haiku para el
# brazo haiku). model_id forma parte de la clave de celda → --resume no mezcla con sonnet.
export LACOCO_EVAL_CLAUDE_MODEL="${LACOCO_EVAL_CLAUDE_MODEL:-sonnet}"

# --- Brazos Claude sobre API keys aero (proxy Anthropic) --------------------------
# Las keys van SOLO por env al subproceso claude (run-claude-cell.sh rota entre ellas
# ante 401/429/quota). La sesión interactiva ~/.claude NO se toca. Provee las keys por
# env: AERO_KEYS="k1,k2,k3,k4"  (o AERO_KEY_1..AERO_KEY_4). Sin keys => sesión ~/.claude.
if [ -z "${AERO_KEYS:-}" ]; then
  AERO_KEYS=""
  for i in 1 2 3 4; do
    v="AERO_KEY_$i"; [ -n "${!v:-}" ] && AERO_KEYS="${AERO_KEYS:+$AERO_KEYS,}${!v}"
  done
fi
if [ -n "$AERO_KEYS" ]; then
  export LACOCO_ANTHROPIC_KEYS="$AERO_KEYS"
  export ANTHROPIC_BASE_URL_EVAL="${ANTHROPIC_BASE_URL_EVAL:-https://capi.aerolink.lat/}"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  export LACOCO_ANTHROPIC_KEY_STATE="$RUNDIR/.anthropic-key-idx"
  rm -f "$LACOCO_ANTHROPIC_KEY_STATE" 2>/dev/null || true   # arrancar en la key 0
  echo "  aero: $(printf '%s' "$AERO_KEYS" | awk -F, '{print NF}') keys → $ANTHROPIC_BASE_URL_EVAL"
fi

# Filtro opcional de 1 tarea para smoke (SMOKE=<task-id>).
TASK_ARGS=()
[ -n "${SMOKE:-}" ] && TASK_ARGS=(--task-id "$SMOKE")

AUTH="$HOME/.local/share/opencode/auth.json"
KEY_IDX=0
set_oc_key() {  # $1 = valor de la key
  mkdir -p "$(dirname "$AUTH")"
  printf '{"opencode-go":{"type":"api","key":"%s"}}\n' "$1" > "$AUTH"
  chmod 600 "$AUTH" 2>/dev/null || true
}
rotate_oc_key() {
  if [ "$KEY_IDX" -le 1 ] && [ -n "${OC_KEY_2:-}" ]; then
    KEY_IDX=2; set_oc_key "$OC_KEY_2"; echo "  ↻ rotada a OC_KEY_2"; return 0
  fi
  echo "  ⚠ sin más keys de opencode para rotar"; return 1
}
AUTH_ERR='unauthor|forbidden|quota|rate.?limit|insufficient|no such model|invalid.*key|\b(401|402|429)\b'

log() { echo "[$(date +%H:%M:%S)] $*"; }
mkdir -p "$RUNDIR"

log "== build dist (servidor MCP) =="
if ! npm run build > "$RUNDIR/genmatrix-build.log" 2>&1; then
  echo "build FALLÓ (ver $RUNDIR/genmatrix-build.log); abortando"; exit 1
fi

# gen <agent> <parallel> [<strategy>]  — corre un brazo; strategy vacío = todas las del split
gen() {
  local agent="$1" par="$2" strat="${3:-}"
  local sfx="${strat:-all}" ; local logf="$RUNDIR/gen-${agent}-${sfx}.log"
  local extra=()
  [ -n "$strat" ] && extra+=(--strategy-id "$strat")
  log "ARM agent=$agent strategy=${strat:-<all>} par=$par"
  npm run eval:generation -- --manifests-dir "$MD" --run-id "$RID" --split "$SPLIT" \
    --agent-id "$agent" --max-parallel-repos "$par" --timeout-ms "$CLAUDE_TIMEOUT_MS" --resume \
    "${extra[@]}" "${TASK_ARGS[@]}" > "$logf" 2>&1 \
    || echo "  ⚠ $agent/${strat:-all} salió !=0 (revisa $logf)"
}
# gen_oc <agent> [<strategy>] — brazo opencode con budget + rotación de key en fallo auth/quota
gen_oc() {
  local agent="$1" strat="${2:-}" ; local sfx="${strat:-all}" ; local logf="$RUNDIR/gen-${agent}-${sfx}.log"
  local extra=() ; [ -n "$strat" ] && extra+=(--strategy-id "$strat")
  _run_oc() {
    npm run eval:generation -- --manifests-dir "$MD" --run-id "$RID" --split "$SPLIT" \
      --agent-id "$agent" --max-parallel-repos "$OC_PARALLEL" --max-budget-usd "$OC_BUDGET" \
      --timeout-ms "$OC_TIMEOUT_MS" --resume \
      "${extra[@]}" "${TASK_ARGS[@]}" > "$logf" 2>&1 || true
  }
  log "ARM(oc) agent=$agent strategy=${strat:-<all>} budget=$OC_BUDGET"
  _run_oc
  if grep -qiE "$AUTH_ERR" "$logf"; then
    echo "  fallo de auth/quota en $agent/${sfx}; intento rotar"
    if rotate_oc_key; then _run_oc; fi
  fi
}

# ===== 1) CLAUDE / Sonnet (robusto, Max) — plano (3 strat) + MCP suave (connector, consensus) =====
log "=== CLAUDE / Sonnet ==="
gen claude-code "$CLAUDE_PARALLEL"                 # no_context + connector + consensus
export LACOCO_EVAL_MCP_HINT=soft
gen claude-code-mcp "$CLAUDE_PARALLEL" connector
gen claude-code-mcp "$CLAUDE_PARALLEL" consensus
unset LACOCO_EVAL_MCP_HINT

# ===== 2) OPENCODE / deepseek-v4-pro — plano (3 strat) + MCP suave (connector, consensus) =====
# Solo si hay keys de opencode; sin OC_KEY_1 se salta (corren solo los brazos Claude).
if [ -n "${OC_KEY_1:-}" ]; then
  log "=== OPENCODE / deepseek-v4-pro ==="
  # Respalda la auth.json existente (se restaura al final) antes de sobrescribir con las keys del run.
  [ -f "$AUTH" ] && cp "$AUTH" "$AUTH.genmatrix.bak" 2>/dev/null || true
  KEY_IDX=1; set_oc_key "$OC_KEY_1"
  gen_oc opencode                                    # no_context + connector + consensus
  export LACOCO_EVAL_MCP_HINT=soft
  gen_oc opencode_mcp connector
  gen_oc opencode_mcp consensus
  unset LACOCO_EVAL_MCP_HINT
  # Restaura la auth.json original de opencode.
  [ -f "$AUTH.genmatrix.bak" ] && mv "$AUTH.genmatrix.bak" "$AUTH" 2>/dev/null || true
else
  log "=== OPENCODE: saltado (sin OC_KEY_1) — solo brazos Claude ==="
fi

# ===== 3) MÉTRICAS por agente (Pass@1 limpio por brazo/modelo) =====
log "=== métricas por agente ==="
for a in claude-code claude-code-mcp opencode opencode_mcp; do
  npm run eval:metrics:generation -- --manifests-dir "$MD" --run-id "$RID" --agent-id "$a" \
    > "$RUNDIR/genmetrics-$a.log" 2>&1 || echo "  ⚠ métricas $a !=0"
done

log "== DONE =="
echo "Resultados:"
for a in claude-code claude-code-mcp opencode opencode_mcp; do
  echo "  $RUNDIR/generation-summary.$a.md"
done
