#!/usr/bin/env python3
"""
Frente B — paso 1: bajar metadata de SWE-PolyBench y filtrar los repos TS/JS por
C1 (TS/Node) + C2 (>1000 estrellas) + C3 (modular). Read-only, barato, desbloquea
el diseño de la integracion (ver docs/plan-next-session-jina-and-swe-polybench.md).

Metodo primario: HuggingFace **datasets-server** (HTTP + JSON, solo stdlib).
  - descubre config/split con /splits
  - pagina filas con /rows (length<=100)
No requiere `pip install` de nada; solo acceso a red a:
  - datasets-server.huggingface.co   (metadata del dataset)
  - api.github.com                   (estrellas para C2; opcional)

Uso:
  python3 eval/scripts/swe-polybench/fetch_metadata.py            # default: _Verified
  python3 eval/scripts/swe-polybench/fetch_metadata.py --dataset AmazonScience/SWE-PolyBench_500
  GITHUB_TOKEN=ghp_... python3 eval/scripts/swe-polybench/fetch_metadata.py   # sube el rate limit de estrellas

Salidas (bajo eval/data/swe-polybench/):
  - instances.tsjs.jsonl   : instancias TS/JS (metadata; se recorta el cuerpo de los patches para tamano)
  - repos.summary.json     : agregacion por repo (conteos, lenguajes, estrellas, senales C1/C2/C3)
  - repos.whitelist.md     : tabla legible = el entregable del paso 1
Ademas imprime un resumen a stdout para que quede en la conversacion.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

DS_SERVER = "https://datasets-server.huggingface.co"
DEFAULT_DATASET = "AmazonScience/SWE-PolyBench_Verified"

# C1: SWE-PolyBench etiqueta por instancia; nos quedamos con el ecosistema TS/JS.
TSJS_LANGS = {"typescript", "javascript", "ts", "js", "tsx", "jsx"}
# C2: umbral de popularidad.
STARS_THRESHOLD = 1000

UA = {"User-Agent": "lacoco-eval-swe-polybench/1"}


def http_get_json(url: str, headers: dict | None = None, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def discover_split(dataset: str) -> tuple[str, str]:
    """Devuelve (config, split). Prefiere split 'test', luego el primero."""
    data = http_get_json(f"{DS_SERVER}/splits?dataset={dataset}")
    splits = data.get("splits", [])
    if not splits:
        raise RuntimeError(f"sin splits para {dataset}: {data}")
    for pref in ("test", "verified", "train"):
        for s in splits:
            if s.get("split") == pref:
                return s["config"], s["split"]
    return splits[0]["config"], splits[0]["split"]


def iter_rows(dataset: str, config: str, split: str):
    """Pagina /rows en bloques de 100 (limite del datasets-server)."""
    offset = 0
    total = None
    while True:
        url = (
            f"{DS_SERVER}/rows?dataset={dataset}&config={config}"
            f"&split={split}&offset={offset}&length=100"
        )
        data = http_get_json(url)
        if total is None:
            total = data.get("num_rows_total")
            feats = [f.get("name") for f in data.get("features", [])]
            print(f"[schema] columnas: {feats}", file=sys.stderr)
            print(f"[schema] filas totales: {total}", file=sys.stderr)
        rows = data.get("rows", [])
        if not rows:
            break
        for r in rows:
            yield r.get("row", {})
        offset += len(rows)
        if total is not None and offset >= total:
            break


DIFF_PATH_RE = re.compile(r"^\+\+\+ b/(.+?)\s*$", re.MULTILINE)


def changed_files(patch: str | None) -> list[str]:
    if not patch:
        return []
    return DIFF_PATH_RE.findall(patch)


def pick(row: dict, *names, default=None):
    for n in names:
        if n in row and row[n] is not None:
            return row[n]
    return default


def normalize_lang(row: dict) -> str:
    lang = pick(row, "language", "lang", default="")
    return str(lang).strip()


def fetch_stars(repo: str, token: str | None) -> int | None:
    """repo = 'owner/name'. Devuelve stargazers_count o None si falla/rate-limit."""
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        data = http_get_json(f"https://api.github.com/repos/{repo}", headers=headers)
        return data.get("stargazers_count")
    except urllib.error.HTTPError as e:
        print(f"[stars] {repo}: HTTP {e.code} ({'rate-limit? set GITHUB_TOKEN' if e.code in (403, 429) else e.reason})", file=sys.stderr)
        return None
    except Exception as e:  # noqa: BLE001
        print(f"[stars] {repo}: {e}", file=sys.stderr)
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--out-dir", default="eval/data/swe-polybench")
    ap.add_argument("--no-stars", action="store_true", help="omitir consulta a GitHub API")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[fetch] dataset = {args.dataset}", file=sys.stderr)
    try:
        config, split = discover_split(args.dataset)
    except Exception as e:  # noqa: BLE001
        print(f"ERROR descubriendo split: {e}", file=sys.stderr)
        print("Sugerencia: verifica el nombre del dataset o que el viewer este habilitado.", file=sys.stderr)
        return 2
    print(f"[fetch] config={config} split={split}", file=sys.stderr)

    # Agregacion por repo.
    per_repo = defaultdict(lambda: {
        "instances": 0,
        "langs": defaultdict(int),
        "monorepo_hits": 0,          # instancias cuyo patch toca packages/*
        "top_dirs": defaultdict(int),  # directorio top-level tocado -> conteo (senal de modularidad)
        "task_categories": defaultdict(int),
        "has_test_command": 0,
        "has_modified_nodes": 0,
        "sample_instances": [],      # primeros ids como muestra
    })
    tsjs_written = 0
    total_seen = 0

    inst_path = out_dir / "instances.tsjs.jsonl"
    with inst_path.open("w", encoding="utf-8") as fh:
        for row in iter_rows(args.dataset, config, split):
            total_seen += 1
            lang = normalize_lang(row)
            if lang.lower() not in TSJS_LANGS:
                continue  # C1: solo TS/JS

            repo = str(pick(row, "repo", "repository", default="")).strip()
            iid = str(pick(row, "instance_id", "id", default=""))
            patch = pick(row, "patch", "gold_patch")
            files = changed_files(patch)
            is_monorepo_inst = any(f.startswith("packages/") for f in files)
            # SWE-PolyBench trae los tests como F2P/P2P/F2F (no FAIL_TO_PASS/...).
            f2p = pick(row, "F2P", "FAIL_TO_PASS", "fail_to_pass")
            p2p = pick(row, "P2P", "PASS_TO_PASS", "pass_to_pass")
            f2f = pick(row, "F2F")
            test_command = pick(row, "test_command")
            # modified_nodes: ground truth node-level publicado por SWE-PolyBench (CST).
            modified_nodes = pick(row, "modified_nodes")
            task_category = pick(row, "task_category")

            agg = per_repo[repo]
            agg["instances"] += 1
            agg["langs"][lang] += 1
            if is_monorepo_inst:
                agg["monorepo_hits"] += 1
            for f in files:
                top = f.split("/", 1)[0] if "/" in f else f
                agg["top_dirs"][top] += 1
            if task_category:
                agg["task_categories"][str(task_category)] += 1
            if test_command:
                agg["has_test_command"] += 1
            if modified_nodes:
                agg["has_modified_nodes"] += 1
            if len(agg["sample_instances"]) < 3:
                agg["sample_instances"].append(iid)

            # Guardar metadata TS/JS (recortando cuerpos grandes para mantener el jsonl liviano).
            slim = {
                "instance_id": iid,
                "repo": repo,
                "base_commit": pick(row, "base_commit"),
                "language": lang,
                "task_category": task_category,
                "F2P": f2p,
                "P2P": p2p,
                "F2F": f2f,
                "test_command": test_command,
                "changed_files": files,
                # ground truth node-level ya calculado por el benchmark (para M3-M5).
                "modified_nodes": modified_nodes,
                "num_func_changes": pick(row, "num_func_changes"),
                "num_class_changes": pick(row, "num_class_changes"),
                "num_nodes": pick(row, "num_nodes"),
                "is_func_only": pick(row, "is_func_only"),
                "is_class_only": pick(row, "is_class_only"),
                "is_mixed": pick(row, "is_mixed"),
                "is_no_nodes": pick(row, "is_no_nodes"),
                "is_single_func": pick(row, "is_single_func"),
                "is_single_class": pick(row, "is_single_class"),
                "has_dockerfile": bool(pick(row, "Dockerfile")),
                "pull_number": pick(row, "pull_number"),
                "patch_len": len(patch) if isinstance(patch, str) else 0,
                "test_patch_len": len(pick(row, "test_patch", default="") or ""),
                "problem_statement_len": len(pick(row, "problem_statement", default="") or ""),
            }
            fh.write(json.dumps(slim, ensure_ascii=False) + "\n")
            tsjs_written += 1

    print(f"[fetch] filas totales vistas: {total_seen}; TS/JS: {tsjs_written}; repos TS/JS: {len(per_repo)}", file=sys.stderr)

    # C2: estrellas por repo (unicos, pocos).
    stars: dict[str, int | None] = {}
    if not args.no_stars:
        for repo in sorted(per_repo):
            if "/" in repo:
                stars[repo] = fetch_stars(repo, token)
            else:
                stars[repo] = None

    # Construir summary + whitelist.
    summary = []
    for repo in sorted(per_repo, key=lambda r: -per_repo[r]["instances"]):
        agg = per_repo[repo]
        st = stars.get(repo)
        c1 = True  # ya filtrado a TS/JS
        c2 = (st is not None and st >= STARS_THRESHOLD)
        # C3 (modular): dos senales, no veredicto. El memo del proyecto nota que
        # casi todo SWE-PolyBench es libreria/framework modular. Decision C3 final
        # = manual con estas senales:
        #   - monorepo: patches tocan packages/* (workspace multi-paquete)
        #   - directorios top-level distintos tocados (dispersion de la superficie)
        top_dirs = dict(sorted(agg["top_dirs"].items(), key=lambda kv: -kv[1]))
        c3_monorepo = agg["monorepo_hits"] > 0
        c3_top_dir_spread = len(agg["top_dirs"])
        summary.append({
            "repo": repo,
            "instances": agg["instances"],
            "languages": dict(agg["langs"]),
            "stars": st,
            "monorepo_hits": agg["monorepo_hits"],
            "top_dirs": top_dirs,
            "task_categories": dict(agg["task_categories"]),
            "has_test_command": agg["has_test_command"],
            "has_modified_nodes": agg["has_modified_nodes"],
            "C1_tsjs": c1,
            "C2_stars_gt_1000": c2,
            "C3_monorepo_signal": c3_monorepo,
            "C3_top_dir_spread": c3_top_dir_spread,
            "sample_instances": agg["sample_instances"],
        })

    (out_dir / "repos.summary.json").write_text(
        json.dumps({
            "dataset": args.dataset, "config": config, "split": split,
            "total_rows": total_seen, "tsjs_instances": tsjs_written,
            "stars_threshold": STARS_THRESHOLD, "repos": summary,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Markdown whitelist.
    lines = [
        f"# SWE-PolyBench — repos TS/JS (C1/C2/C3)",
        "",
        f"- Dataset: `{args.dataset}` (config `{config}`, split `{split}`)",
        f"- Filas totales: {total_seen} · instancias TS/JS: {tsjs_written} · repos TS/JS: {len(per_repo)}",
        f"- C1 = TS/JS (pre-filtrado) · C2 = >{STARS_THRESHOLD}★ · C3 = modularidad (monorepo `packages/*` + dispersion de directorios top-level)",
        "",
        "| repo | inst | lenguajes | estrellas | C2 | monorepo | top-dirs | test_cmd | mod_nodes |",
        "|---|---:|---|---:|:--:|---:|---:|---:|---:|",
    ]
    for s in summary:
        langs = ", ".join(f"{k}:{v}" for k, v in s["languages"].items())
        st = "—" if s["stars"] is None else str(s["stars"])
        c2 = "✅" if s["C2_stars_gt_1000"] else ("?" if s["stars"] is None else "❌")
        mono = f"{s['monorepo_hits']}/{s['instances']}"
        lines.append(
            f"| {s['repo']} | {s['instances']} | {langs} | {st} | {c2} | {mono} | "
            f"{s['C3_top_dir_spread']} | {s['has_test_command']}/{s['instances']} | {s['has_modified_nodes']}/{s['instances']} |"
        )
    lines += [
        "",
        "**Señales por repo (top directorios tocados):**",
        "",
    ]
    for s in summary:
        top = ", ".join(f"`{k}`×{v}" for k, v in list(s["top_dirs"].items())[:6])
        cats = ", ".join(f"{k}:{v}" for k, v in s["task_categories"].items())
        lines.append(f"- **{s['repo']}** — dirs: {top}" + (f" · categorias: {cats}" if cats else ""))
    lines += [
        "",
        "**Notas de lectura:**",
        "- C2 `?` = no se pudo leer estrellas (rate-limit sin token). Reintenta con `GITHUB_TOKEN`.",
        "- `monorepo` = instancias cuyo patch toca `packages/*`; `top-dirs` = # de directorios top-level distintos tocados (dispersion).",
        "- `test_cmd` y `mod_nodes` = cobertura de `test_command` y `modified_nodes` (ground truth node-level del benchmark) por instancia.",
        "- C3 es una **señal**, no veredicto: confirmar modularidad a mano. El memo del proyecto acepta 'modular' (no exige microservicios).",
        "- El whitelist final = repos con C1 ✅ + C2 ✅ + C3 aceptado, priorizando alto conteo de instancias y cobertura de test_command/modified_nodes.",
    ]
    (out_dir / "repos.whitelist.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Resumen a stdout (queda en la conversacion cuando se corre con `!`).
    print("\n===== RESUMEN paso-1 (repos TS/JS SWE-PolyBench) =====")
    print(f"dataset={args.dataset} config={config} split={split}")
    print(f"total_rows={total_seen} tsjs_instances={tsjs_written} repos_tsjs={len(per_repo)}")
    print(f"{'repo':40s} {'inst':>5s} {'stars':>8s}  C2 mono topdirs testcmd modnodes")
    for s in summary:
        st = "-" if s["stars"] is None else str(s["stars"])
        c2 = "Y" if s["C2_stars_gt_1000"] else ("?" if s["stars"] is None else "N")
        print(
            f"{s['repo']:40s} {s['instances']:5d} {st:>8s}   {c2} "
            f"{s['monorepo_hits']:4d} {s['C3_top_dir_spread']:7d} "
            f"{s['has_test_command']:6d}/{s['instances']:<3d} {s['has_modified_nodes']:d}/{s['instances']:d}"
        )
    print(f"\nescrito: {inst_path}")
    print(f"escrito: {out_dir/'repos.summary.json'}")
    print(f"escrito: {out_dir/'repos.whitelist.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
