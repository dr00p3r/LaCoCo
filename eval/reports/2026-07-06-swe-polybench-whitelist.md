# SWE-PolyBench — Paso 1: whitelist TS/JS (C1/C2/C3) y hallazgos de esquema

**Fecha:** 2026-07-06 · **Frente B, paso 1** del plan
`docs/plan-next-session-jina-and-swe-polybench.md`.
**Fuente:** `AmazonScience/SWE-PolyBench_Verified` (config `default`, split `test`),
bajado vía HuggingFace datasets-server con
`eval/scripts/swe-polybench/fetch_metadata.py`.
**Artefactos:** `eval/data/swe-polybench/{instances.tsjs.jsonl,repos.summary.json,repos.whitelist.md}`
(git-ignored).

## Resumen ejecutable

De **382 instancias** del split Verified, **200 son TS/JS** (C1), repartidas en
**9 repos**, **todos con >45k★** (C2 ✅ con holgura). El cuello de botella no es
C1/C2 sino **C3 (modularidad) + fricción de instalación por instancia**.

| repo | inst | código cambiado (js/ts) | ★ | monorepo | test_cmd | mod_nodes | categorías |
|---|---:|---|---:|---:|---:|---:|---|
| mui/material-ui | 70 | js 149 / ts 64 | 98.5k | 69/70 | 70/70 | 70/70 | Bug 50, Feat 19, Refac 1 |
| sveltejs/svelte | 46 | js 7 / ts 72 | 87.4k | 0/46 | 46/46 | 46/46 | Bug 40, Feat 4, Refac 2 |
| serverless/serverless | 33 | js 49 / ts 0 | 46.9k | 0/33 | 33/33 | 33/33 | Bug 22, Feat 11 |
| microsoft/vscode | 23 | js 0 / ts 33 | 187k | 0/23 | 23/23 | 23/23 | Bug 22, Feat 1 |
| prettier/prettier | 17 | js 28 / ts 0 | 52.1k | 0/17 | 17/17 | 17/17 | Bug 15, Feat 2 |
| mrdoob/three.js | 4 | js 6 / ts 1 | 113k | 0/4 | 4/4 | 4/4 | Bug 2, Refac 1, Feat 1 |
| tailwindlabs/tailwindcss | 3 | js 4 / ts 0 | 95.8k | 0/3 | 3/3 | 3/3 | Bug 2, Feat 1 |
| coder/code-server | 3 | ts 14 | 78.2k | 0/3 | 3/3 | 3/3 | Bug 2, Feat 1 |
| angular/angular | 1 | ts 1 | 100k | 1/1 | 1/1 | 1/1 | Bug 1 |

## Hallazgos que **cambian el diseño del Frente B** (a favor)

El plan asumía un esquema estilo SWE-bench y anticipaba dos trabajos grandes. El
esquema real de SWE-PolyBench (`repo, base_commit, patch, test_patch,
problem_statement, F2P, P2P, F2F, test_command, task_category, modified_nodes,
num_func_changes, num_class_changes, is_func_only/class_only/mixed/no_nodes,
Dockerfile, ...`) los resuelve de fábrica:

1. **`test_command` viene por instancia (200/200).** Elimina el riesgo #3 del plan
   ("mapear el runner jest/vitest/mocha por repo a mano"). Distribución observada:
   mocha 103, npm/yarn test genérico 70, jest 3, otro 24. **Pero** el comando es
   **Docker-específico**: 183/200 empiezan con
   `. /usr/local/nvm/nvm.sh && nvm use <ver> && ...` y muchos referencian
   `/testbed/custom-reporter.js`. Node pinneado por instancia:
   `{16.20.2:60, 18.8.0:53, 20.16.0:17, 14.21.3:17, 8.9.1:2}`. → **hay que traducir
   el `test_command` al entorno local** (quitar el prefijo nvm/testbed o replicar el
   `Dockerfile`, presente en todas). Node 8/14 en algunas instancias es fricción real.

2. **`modified_nodes` = ground truth node-level ya calculado con CST (200/200).**
   Elimina la pieza #3 del plan (`gold-patch-nodes.ts` para parsear el gold patch
   con AST). Pasamos de *derivar* a *mapear/validar*. Formato:
   `path->program->class_declaration:Name->method_definition:render`.
   Tipos de nodo hoja (el editado): `function_declaration` 199,
   `method_definition` 188, `class_declaration` 28. → **hay que adaptar node-id**:
   el formato LaCoCo es `<relpath>#<symbol>` (ver `eval/scripts/lib/node-id.ts`),
   el de SWE-PolyBench es una **ruta CST jerárquica**. El mapeo natural:
   hoja `method_definition:render` bajo `class_declaration:ListItem` →
   `<path>#ListItem.render`; `function_declaration:SvgIcon` → `<path>#SvgIcon`.
   Necesita un traductor `modified_nodes → node-id LaCoCo`.

3. **`F2P`/`P2P` son strings con repr de lista Python, no JSON** (comillas simples).
   El loader debe parsear con `ast.literal_eval` (no `json.loads`). F2P/instancia:
   min 1, máx 48, mediana 1 (0 instancias con F2P vacío ✅). P2P puede ser enorme
   (máx 4578) → para el gate local correr **solo los F2P**, no los P2P completos.
   Los IDs de test son `archivo->titulo del test` (ej.
   `.../ListItem.test.js-><ListItem /> prop: focusVisibleClassName should merge...`),
   hay que traducirlos al selector del runner local (`--grep`/`-t`).

4. **32/200 instancias tienen `is_no_nodes=True`** (el fix toca solo config/docs/no
   captura función/clase). Para M3-M5 (localización node-level) **hay que excluirlas
   o marcarlas** — no tienen nodo editable como ground truth. Es el caso borde que
   el plan anotó (símbolos nuevos / cambios no-código).

## Recomendación de whitelist y smoke

**C3 (modularidad):** el memo del proyecto acepta "modular" (no exige
microservicios). Los 9 repos son librerías/frameworks modulares. La señal
`packages/*` sólo marca a material-ui/angular porque los demás usan `src/` — no es
falta de modularidad, es otra convención de carpetas. **Todos pasan C3** bajo el
criterio del memo.

**Whitelist final (C1+C2+C3), priorizada:**
1. **mui/material-ui (70)** — smoke #1. Monorepo real (`packages/*`), TS+JS,
   mocha por instancia, 70/70 con test_command y modified_nodes. Volumen suficiente
   para M1/M2 con señal estadística. Riesgo: Node 14.21.3 en varias instancias.
2. **sveltejs/svelte (46)** — TS mayoritario, `src/`, Node 16.20.2, `npm run test`
   genérico. Segundo repo para diversidad.
3. **microsoft/vscode (23)** — TS puro, alta calidad, `src/`.
4. **serverless/serverless (33)** y **prettier/prettier (17)** — JS puro; útiles
   pero indexación de LaCoCo sobre JS necesita `allowJs` (ver dayjs en repos.yaml).

Cola larga (three.js, tailwind, code-server, angular: 1–4 inst c/u): baja prioridad
por poco volumen; angular=1 no aporta señal.

**Smoke recomendado:** 2–3 instancias `is_func_only=True` + `num_nodes=1` de
**material-ui** (p.ej. `mui__material-ui-11451`, fix de 1 método `ListItem.render`,
1 F2P, changed_files=1). Es el caso más limpio para validar el flujo end-to-end
(checkout base_commit → aplicar test_patch → F2P rojo → agente arregla → F2P verde)
y el traductor `modified_nodes → node-id`.

## Próximos pasos (Frente B, actualizados)

1. **Loader `import-swe-polybench.ts`** — parsear `instances.tsjs.jsonl` (F2P/P2P vía
   equivalente a `ast.literal_eval`), emitir manifest instance-centric.
2. **Traductor `test_command`** — despojar prefijo nvm/`/testbed/`, mapear al Node
   local (o usar el `Dockerfile` de la instancia), correr solo F2P.
3. **Traductor `modified_nodes → node-id`** — ruta CST jerárquica → `<relpath>#<symbol>`
   (con `Clase.metodo` para method_definition). Reemplaza el AST-parsing propuesto.
4. **prepare_repos instance-centric** — `ref=base_commit`, aplicar `test_patch`,
   verificar F2P rojo (sin `applyBrokenPatch`).
5. **Excluir/marcar `is_no_nodes=True`** para M3-M5.

Retrieval/generación/métricas: sin cambios (consumen `relevant_nodes` + `target_tests`).
