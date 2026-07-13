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

cd "$REPO"
exec claude "${ARGS[@]}" < "$PROMPT_FILE"
