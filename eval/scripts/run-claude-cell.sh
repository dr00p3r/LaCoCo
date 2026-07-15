#!/usr/bin/env bash
# Wrapper de celda para usar Claude Code como agente de generación en el arnés eval.
# El arnés (run-generation.ts) invoca los agentes desde cwd=PROJECT_ROOT y captura
# stdout; opencode se apaña con `--dir`, pero `claude` opera sobre su cwd y recibe el
# prompt por stdin (no tiene `--file`). Este wrapper resuelve esas diferencias:
#   - cd al repo objetivo,
#   - pasa el prompt (archivo) por stdin a `claude -p`,
#   - permisos bypass (headless, sin prompts),
#   - si hay MCP config (formato opencode, vía $LACOCO_MCP_CONFIG), lo convierte al
#     formato de Claude Code (`mcpServers`) y lo pasa con `--mcp-config`.
#
# Uso:  run-claude-cell.sh <repo_path> <model> <prompt_file>
#   $LACOCO_MCP_CONFIG  (opcional) = ruta al opencode.mcp.json de la celda.
set -euo pipefail

REPO="$1"; MODEL="$2"; PROMPT_FILE="$3"
MCP_SRC="${LACOCO_MCP_CONFIG:-}"

if [[ ! -d "$REPO" ]]; then echo "run-claude-cell: repo no existe: $REPO" >&2; exit 2; fi
if [[ ! -f "$PROMPT_FILE" ]]; then echo "run-claude-cell: prompt no existe: $PROMPT_FILE" >&2; exit 2; fi

ARGS=(--print --model "$MODEL" --permission-mode bypassPermissions
      --output-format stream-json --verbose)

# MCP: convertir el config de opencode ({mcp:{lacoco:{command:[...],environment}}}) al
# formato de Claude Code ({mcpServers:{lacoco:{command,args,env}}}).
if [[ -n "$MCP_SRC" && -f "$MCP_SRC" ]]; then
  MCP_DST="$(dirname "$MCP_SRC")/claude.mcp.json"
  node -e '
    const fs = require("fs");
    const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const l = src.mcp.lacoco;
    const [command, ...args] = l.command;
    // Grounding OFF vía `--no-grounding`: el flag `--grounding` de commander es negable,
    // así que options.grounding es true por default y PISA el config/env; sin --no-grounding
    // el servidor exige el Project Semantic Profile (obsoleto para estos repos) y el
    // retrieve tira "profile rebuild". Off = retrieve determinista (igual que el eval).
    if (!args.includes("--no-grounding")) args.push("--no-grounding");
    const out = { mcpServers: { lacoco: { command, args, env: l.environment || {} } } };
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  ' "$MCP_SRC" "$MCP_DST"
  ARGS+=(--mcp-config "$MCP_DST")
fi

# --- Credenciales del eval (API keys aero) ------------------------------------------
# Estas keys SOLO afectan a este subproceso `claude`; la sesión interactiva (~/.claude)
# queda intacta (nunca escribimos config global). Sin $LACOCO_ANTHROPIC_KEYS el wrapper
# se comporta como antes (exec claude con las credenciales de sesión).
if [[ -z "${LACOCO_ANTHROPIC_KEYS:-}" ]]; then
  cd "$REPO"
  exec claude "${ARGS[@]}" < "$PROMPT_FILE"
fi

[[ -n "${ANTHROPIC_BASE_URL_EVAL:-}" ]] && export ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL_EVAL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"

# --bare = auth ESTRICTAMENTE por ANTHROPIC_API_KEY (salta OAuth/keychain de la suscripción,
# hooks, auto-memory y CLAUDE.md auto-discovery). Sin él, un login de suscripción en ~/.claude
# GANA sobre ANTHROPIC_API_KEY y devuelve 429 "session limit". NO salta --mcp-config (flag
# explícito), así que el brazo MCP sigue funcionando. Solo aplica en la ruta con aero keys.
ARGS+=(--bare)

IFS=',' read -r -a KEYS <<< "$LACOCO_ANTHROPIC_KEYS"
N=${#KEYS[@]}
# Índice de key persistido entre celdas: arranca por la última key buena (no re-golpea una
# key muerta en cada celda). $LACOCO_ANTHROPIC_KEY_STATE = ruta al state-file (opcional).
STATE="${LACOCO_ANTHROPIC_KEY_STATE:-}"
IDX=0
if [[ -n "$STATE" && -f "$STATE" ]]; then
  IDX="$(cat "$STATE" 2>/dev/null || echo 0)"; [[ "$IDX" =~ ^[0-9]+$ ]] || IDX=0
fi
AUTH_ERR='unauthor|forbidden|quota|rate.?limit|insufficient|overloaded|invalid.*key|\b(401|402|429|529)\b'

cd "$REPO"
OUT="$(mktemp)"; ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT

rc=1
for (( try=0; try<N; try++ )); do
  k=$(( (IDX + try) % N ))
  export ANTHROPIC_API_KEY="${KEYS[$k]}"
  rc=0
  claude "${ARGS[@]}" < "$PROMPT_FILE" >"$OUT" 2>"$ERR" || rc=$?
  if [[ $rc -eq 0 ]] && ! grep -qiE "$AUTH_ERR" "$OUT" "$ERR"; then
    [[ -n "$STATE" ]] && printf '%s' "$k" > "$STATE" 2>/dev/null || true
    break
  fi
  if grep -qiE "$AUTH_ERR" "$OUT" "$ERR"; then
    echo "run-claude-cell: key #$k auth/quota (rc=$rc); rotando a la siguiente" >&2
    [[ -n "$STATE" ]] && printf '%s' "$(( (k + 1) % N ))" > "$STATE" 2>/dev/null || true
    continue
  fi
  # Error NO de auth (bug del repo, timeout de agente, etc.): no tiene sentido rotar.
  break
done

cat "$OUT"
cat "$ERR" >&2
exit "$rc"
