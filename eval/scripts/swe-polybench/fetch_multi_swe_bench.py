#!/usr/bin/env python3
"""
Baja instancias de **Multi-SWE-bench** (ByteDance) para los repos TS/JS NUEVOS
(los que NO se solapan con SWE-PolyBench) y las NORMALIZA al esquema que consume
`eval/scripts/import-multi-swe-bench.ts`. Read-only, solo stdlib (urllib).

Por qué existe: Multi-SWE-bench se publica como **jsonl por-repo** en el repo HF
(no un split navegable como SWE-PolyBench), así que `fetch_metadata.py`
(datasets-server) no sirve. Este script descubre el árbol del repo HF, baja los
jsonl de los repos objetivo, y emite un único jsonl normalizado.

Esquema normalizado por instancia (lo que espera el importador):
  {instance_id, repo, base_commit, problem_statement, fix_patch, test_patch,
   test_command, number}

CONFIRMAR LAYOUT: al primer fetch, el script LISTA los archivos jsonl del repo HF
y los conteos por repo (para ajustar --repos si los nombres difieren).

Uso:
  python3 eval/scripts/swe-polybench/fetch_multi_swe_bench.py           # 5 repos por defecto
  python3 eval/scripts/swe-polybench/fetch_multi_swe_bench.py --list    # solo listar el árbol jsonl
  python3 eval/scripts/swe-polybench/fetch_multi_swe_bench.py --repos vuejs/core iamkun/dayjs

Salida (por defecto): eval/data/multi-swe-bench/instances.normalized.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

HF = "https://huggingface.co"
DEFAULT_DATASET = "ByteDance-Seed/Multi-SWE-bench"

# Repos JS de Multi-SWE-bench que NO están en SWE-PolyBench (svelte se solapa →
# excluido). Confirmado por --list contra ByteDance-Seed/Multi-SWE-bench (2026-07):
# el mirror trae SOLO estos 5 repos JS nuevos bajo `js/` (no hay `ts/`, ni vuejs/core).
# Todos >1000★. Ajustar según conteos reales.
DEFAULT_REPOS = [
    "iamkun/dayjs",
    "anuraghazra/github-readme-stats",
    "axios/axios",
    "expressjs/express",
    "Kong/insomnia",
]

UA = {"User-Agent": "lacoco-eval-multi-swe-bench/1"}


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get_json(url: str, timeout: int = 60):
    return json.loads(http_get(url, timeout=timeout).decode("utf-8"))


def list_tree(dataset: str) -> list[str]:
    """Lista rutas de archivos del repo HF del dataset (recursivo)."""
    url = f"{HF}/api/datasets/{dataset}/tree/main?recursive=1&expand=1"
    try:
        entries = http_get_json(url)
    except urllib.error.HTTPError as exc:  # pragma: no cover - red
        raise RuntimeError(f"no pude listar el árbol de {dataset}: {exc}") from exc
    return [e["path"] for e in entries if isinstance(e, dict) and e.get("type") == "file"]


def jsonl_files_for_repo(paths: list[str], org: str, repo: str) -> list[str]:
    """Rutas jsonl que corresponden a un repo, por convención de nombre.

    Multi-SWE-bench nombra los datasets como `<org>__<repo>_dataset.jsonl` (a
    veces bajo un dir por lenguaje). Hacemos match tolerante por org y repo.
    """
    org_l, repo_l = org.lower(), repo.lower()
    out = []
    for p in paths:
        if not p.lower().endswith(".jsonl"):
            continue
        base = p.lower().rsplit("/", 1)[-1]
        # match típico: "<org>__<repo>_dataset.jsonl" o cualquier jsonl que
        # contenga ambos tokens.
        if (f"{org_l}__{repo_l}" in base) or (org_l in base and repo_l in base):
            out.append(p)
    return out


def build_problem_statement(inst: dict) -> str:
    """Texto del issue: `problem_statement` si viene, si no title + body."""
    ps = inst.get("problem_statement")
    if isinstance(ps, str) and ps.strip():
        return ps
    title = (inst.get("title") or "").strip()
    body = (inst.get("body") or "").strip()
    if title and body:
        return f"{title}\n\n{body}"
    return title or body


def base_commit_of(inst: dict) -> str:
    base = inst.get("base")
    if isinstance(base, dict):
        sha = base.get("sha") or base.get("ref")
        if isinstance(sha, str) and sha:
            return sha
    # fallbacks por si el esquema difiere
    for key in ("base_commit", "base_sha", "sha"):
        v = inst.get(key)
        if isinstance(v, str) and v:
            return v
    return ""


def normalize(inst: dict, org: str, repo: str) -> dict | None:
    number = inst.get("number") or inst.get("pull_number") or inst.get("pr")
    fix_patch = inst.get("fix_patch") or inst.get("patch") or ""
    if not fix_patch:
        return None
    base_commit = base_commit_of(inst)
    if not base_commit:
        return None
    inst_org = inst.get("org") or org
    inst_repo = inst.get("repo") or repo
    return {
        "instance_id": f"{inst_org}__{inst_repo}-{number}",
        "repo": f"{inst_org}/{inst_repo}",
        "base_commit": base_commit,
        "problem_statement": build_problem_statement(inst),
        "fix_patch": fix_patch,
        "test_patch": inst.get("test_patch") or "",
        "test_command": None,
        "number": number if isinstance(number, int) else None,
    }


def iter_jsonl(raw: bytes):
    for line in raw.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--repos", nargs="*", default=DEFAULT_REPOS,
                        help="slugs org/repo a bajar (default: 5 repos TS/JS nuevos)")
    parser.add_argument("--out", default=None,
                        help="ruta del jsonl normalizado (default eval/data/multi-swe-bench/instances.normalized.jsonl)")
    parser.add_argument("--list", action="store_true",
                        help="solo listar los archivos jsonl del repo HF y salir")
    args = parser.parse_args()

    print(f"[multi-swe-bench] listando árbol de {args.dataset} …", file=sys.stderr)
    paths = list_tree(args.dataset)
    jsonl_paths = [p for p in paths if p.lower().endswith(".jsonl")]
    print(f"[multi-swe-bench] {len(jsonl_paths)} archivo(s) .jsonl en el repo HF:", file=sys.stderr)
    for p in sorted(jsonl_paths):
        print(f"    {p}", file=sys.stderr)
    if args.list:
        return 0

    out_path = Path(args.out) if args.out else (
        Path(__file__).resolve().parents[2] / "data" / "multi-swe-bench" / "instances.normalized.jsonl"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    counts: dict[str, int] = defaultdict(int)
    normalized: list[dict] = []
    for slug in args.repos:
        if "/" not in slug:
            print(f"[warn] repo mal formado (esperaba org/repo): {slug}", file=sys.stderr)
            continue
        org, repo = slug.split("/", 1)
        matches = jsonl_files_for_repo(jsonl_paths, org, repo)
        if not matches:
            print(f"[warn] sin jsonl para {slug} (revisa --list y ajusta --repos)", file=sys.stderr)
            continue
        for rel in matches:
            url = f"{HF}/datasets/{args.dataset}/resolve/main/{rel}"
            print(f"[multi-swe-bench] bajando {rel} …", file=sys.stderr)
            try:
                raw = http_get(url)
            except urllib.error.HTTPError as exc:
                print(f"[warn] no pude bajar {rel}: {exc}", file=sys.stderr)
                continue
            for inst in iter_jsonl(raw):
                norm = normalize(inst, org, repo)
                if norm is None:
                    continue
                normalized.append(norm)
                counts[slug] += 1

    with out_path.open("w", encoding="utf-8") as fh:
        for norm in normalized:
            fh.write(json.dumps(norm, ensure_ascii=False) + "\n")

    print(f"\n[multi-swe-bench] {len(normalized)} instancia(s) normalizada(s) → {out_path}")
    print("[multi-swe-bench] conteo por repo (todos con fix_patch + base_commit):")
    for slug in args.repos:
        print(f"    {slug:40s} {counts.get(slug, 0)}")
    if not normalized:
        print("[multi-swe-bench] NADA descargado — corre con --list y ajusta --repos a los nombres reales.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
