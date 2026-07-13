#!/usr/bin/env node
// Analiza las celdas de un run de generación con Claude Code (stream-json).
// Por celda: Pass@1 (test_exit_code del generation.jsonl), costo real (total_cost_usd),
// turnos, y conteo de tool-calls (lacoco_retrieve vs Grep/Read/Glob/Bash/Edit/...).
// Uso: node eval/scripts/analyze-claude-cells.mjs <run-id> [<run-id> ...]
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const runIds = process.argv.slice(2);
if (runIds.length === 0) { console.error("uso: analyze-claude-cells.mjs <run-id> [...]"); process.exit(1); }

function loadGen(runId) {
  const p = join(ROOT, "eval/runs", runId, "generation.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Recorre el stream-json de una celda y agrega tool-calls + costo + turnos.
function parseCell(stdoutPath) {
  const out = { tools: {}, lacoco: 0, cost: null, turns: null, denials: 0 };
  if (!existsSync(stdoutPath)) return out;
  const text = readFileSync(stdoutPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant" && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === "tool_use") {
          const name = c.name || "?";
          if (name.includes("lacoco") || name.includes("retrieve")) out.lacoco++;
          const key = name.replace(/^mcp__lacoco__/, "mcp:");
          out.tools[key] = (out.tools[key] || 0) + 1;
        }
      }
    } else if (ev.type === "result") {
      out.cost = ev.total_cost_usd ?? null;
      out.turns = ev.num_turns ?? null;
      out.denials = (ev.permission_denials?.length) ?? 0;
    }
  }
  return out;
}

function findStdout(runId, rec) {
  // artifact_naming: {task_id}/{strategy_id}/{agent_id}/agent.stdout.log
  const base = join(ROOT, "eval/runs", runId, "generation-artifacts", rec.task_id);
  if (!existsSync(base)) return null;
  for (const strat of readdirSync(base)) {
    const sd = join(base, strat);
    for (const agent of readdirSync(sd)) {
      const f = join(sd, agent, "agent.stdout.log");
      if (existsSync(f)) return f;
    }
  }
  return null;
}

for (const runId of runIds) {
  const recs = loadGen(runId);
  console.log(`\n===== ${runId}  (n=${recs.length}) =====`);
  let pass = 0, meas = 0, tout = 0, cost = 0, grepTot = 0, readTot = 0, bashTot = 0, lacocoTot = 0, cells = 0;
  const rows = [];
  for (const r of recs) {
    const tec = r.test_exit_code;
    const err = r.error?.type;
    const inv = r.invalid_reason;
    const passed = tec === 0;
    if (passed) { pass++; meas++; } else if (tec != null) { meas++; }
    if (err === "agent_timeout") tout++;
    const cell = findStdout(runId, r) ? parseCell(findStdout(runId, r)) : { tools: {}, lacoco: 0, cost: null, turns: null };
    const grep = (cell.tools["Grep"] || 0) + (cell.tools["Glob"] || 0);
    const read = cell.tools["Read"] || 0;
    const bash = cell.tools["Bash"] || 0;
    if (cell.cost != null) { cost += cell.cost; cells++; }
    grepTot += grep; readTot += read; bashTot += bash; lacocoTot += cell.lacoco;
    rows.push({
      task: r.task_id,
      test: tec === 0 ? "PASS" : tec != null ? "fail" : (err || inv || "-"),
      lacoco: cell.lacoco, grep, read, bash, turns: cell.turns, cost: cell.cost,
    });
  }
  for (const row of rows) {
    console.log(
      `  ${row.task.padEnd(20)} ${String(row.test).padEnd(22)} ` +
      `lacoco=${row.lacoco} bash=${row.bash} read=${row.read} grep=${row.grep} turns=${row.turns ?? "-"} ` +
      `cost=${row.cost != null ? "$" + row.cost.toFixed(4) : "-"}`,
    );
  }
  console.log(`  ---`);
  console.log(`  Pass@1=${pass}/${meas} medibles (${recs.length} total) · timeouts=${tout}`);
  console.log(`  tool totals: lacoco_retrieve=${lacocoTot} bash=${bashTot} read=${readTot} grep/glob=${grepTot}`);
  console.log(`  costo total (stream-json): $${cost.toFixed(4)} en ${cells} celdas · avg $${cells ? (cost / cells).toFixed(4) : "-"}/celda`);
}
