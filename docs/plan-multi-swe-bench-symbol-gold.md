# Plan: Multi-SWE-bench con gold a nivel símbolo → benchmark de 10 repos (>1000★)

> **Handoff autocontenido.** Escrito 2026-07-11 (rama `feat/consensus-baselines`). Una sesión
> fresca sin contexto debería poder ejecutarlo leyendo solo este doc + los file:line citados.
> No re-explores lo ya mapeado aquí.

## 0. Objetivo y por qué

La tesis (nota conceptual del usuario) exige **≥10 repos open-source con >1000★**. SWE-PolyBench
—la fuente actual— solo tiene **9 repos TS/JS** (los "21 repos" del paper son across 4 lenguajes).
Para llegar a 10 repos DISTINTOS hay que sumar otro benchmark: **Multi-SWE-bench** (ByteDance),
que aporta repos TS/JS nuevos con `fix_patch` público.

El problema: Multi-SWE-bench usa esquema estilo SWE-bench (**sin `modified_nodes`**), lo que a
primera vista daría gold solo a nivel archivo. **PERO** el arnés ya tiene la maquinaria para derivar
símbolos desde el diff (ver §2), así que Multi-SWE-bench puede tener **gold a nivel símbolo igual que
SWE-PolyBench** → los 10 repos quedan **uniformes** (todos gold fino, todos multi-hop). Ese es el
núcleo de este plan.

**Régimen relevante = multi-hop** (el fix toca ≥2 símbolos conectados; donde `connector`/SCR debe
batir a los baselines). En SWE-PolyBench se filtra por `num_nodes 2-4`; en Multi-SWE-bench (sin
`num_nodes`) el proxy es **"el parche toca ≥2 archivos/funciones fuente"**.

## 1. Estado actual (ya hecho, NO rehacer)

Rama `feat/consensus-baselines`, tests 379/379, typecheck ok. Ya implementado y probado:
- **Reutilización de clones** (`eval/scripts/lib/git.ts`): mirror blobless por URL
  (`prepareMirror`), `git clone --reference <mirror> --filter=blob:none --no-checkout`, fast-path
  (skip fetch si `HEAD==ref`), y fix del bug `git remote update --tags`→129 (un mirror ya trae tags).
  16 tests en `git.test.ts`.
- **Importador** `eval/scripts/import-swe-polybench.ts`: flag **`--data-file`** (apunta a otro jsonl)
  y **guard de `--append`** (NO reescribe `run.yaml`/`strategies.yaml`/`metrics.yaml` si existen).
  `loadEasyInstances` exportado. Tests en `import-swe-polybench.test.ts`.
- **Bundle** `eval/manifests/swe-polybench-multi/`: 55 tareas, splits `benchmulti` (single-hop 22),
  `benchmulti_mh` (multi-hop 16), `benchvalid*`. `include_strategies` en su `run.yaml` incluye las 8
  deterministas (hybrid, ictd, clcr, rpr, consensus, repograph, ppr, connector). Override `.d.ts`
  aplicado a `material-ui-*` (script scratch `patch-mui-tsconfig.mjs`).
- **Análisis previo** `eval/reports/2026-07-10-benchmulti-analisis.md`: en single-hop connector
  empata baselines (gold=ancla); multi-hop es donde separa. 5/14 repos =0 por recall del anclaje.
- **Reproductor** `eval/scripts/run-benchmulti.sh`: corre dos regímenes por run-id separado.

**GOTCHA de entorno:** procesos largos (>2-3 min) se matan (foreground topa 2 min; background se
mata). El `index_vectors` (embedding Jina) tarda min/repo → **el usuario corre el indexado en su
terminal**, no el agente. `run-retrieval` TRUNCA `retrieval.jsonl` al inicio (run-retrieval.ts:663);
`index-repos` SIEMPRE re-indexa (ignora `force_reindex`). Retrieval sí es rápido (~9s/repo×8 estrat).

## 2. Maquinaria de gold que YA existe (clave — reusar, no reinventar)

Todo en `eval/scripts/lib/patch-evidence-gold.ts`:
- **`parseUnifiedDiff(diff)`** (línea 49, exportada) → `DiffFileChange[]` = `{path, addedLines[]}`.
  Hoy solo captura líneas del lado **NUEVO** (los `+`). **Falta el lado VIEJO** (los `-` + contexto)
  — se extiende (ver §3.1).
- **`enclosingSymbol(node)`** (línea 202, **privada — hay que exportarla**): sube por el AST desde un
  nodo hasta su declaración contenedora y devuelve `{symbol, kind}` en formato node-id del arnés:
  `func` | `Clase` | `Clase.metodo` (constructor colapsa a la clase). Es EXACTAMENTE lo que produce
  `modified_nodes` de SWE-PolyBench.
- **`extractPatchEvidenceTier1(input)`** (línea 154, exportada): deriva `edited_files` desde el
  patch (siempre) y `edited_symbols` desde `modifiedNodes` (opcional). Con `modifiedNodes=null` cae a
  file-level (`resolution.fell_back_to_file_level=true`). Input `PatchEvidenceTier1Input` (109) es
  **genérico, no atado a SWE-PolyBench** (lo dice su doc).
- **`enrichPatchEvidenceWithDefinitions`** (269, exportada, Tier 2) + **`sourceChangesFromPatch`**
  (386): patrón de referencia de cómo caminar el AST con ts-morph sobre líneas cambiadas
  (`project.getSourceFile(abs)` + `forEachChild(visit)` + `node.getStartLineNumber()`). **Tier 2 está
  implementado pero NO se invoca en el pipeline** (solo en tests) — porque SWE-PolyBench ya traía
  símbolos. Es el molde para §3.1.

Métricas (`eval/scripts/lib/metrics.ts`): `EditSiteHit@K` matchea contra `editSiteSymbols` **y**
`editSiteFiles` (match en cualquiera cuenta), `hasEditSite` requiere solo uno no-vacío → **gold
símbolo y gold archivo computan igual**; símbolo solo lo hace más fino. `buildPatchEvidenceGoldInput`
(compute-retrieval-metrics.ts:104) lee `task.gold.patch_evidence` **sin saber de qué dataset viene**.

**Sutileza crítica (base vs patched):** el pipeline indexa el repo en **`base_commit` (pre-fix)**
(`repos.yaml.ref = base_commit`, prepare hace checkout). El gold = símbolos **en el archivo base**.
Por eso, para mapear el diff → símbolo hay que usar las líneas del lado **VIEJO** (los `-` y su
contexto), que caen dentro de la función que el fix modifica en el base. Para hunks de pura adición
(solo `+`, función nueva que no existe en base) no hay símbolo base → cae a file-level (correcto: en
el índice base no hay nada nuevo que recuperar).

## 3. Implementación (orden recomendado)

### 3.1 `deriveEditedSymbolsFromCheckout` — el corazón (~40-60 líneas)
Archivo: `eval/scripts/lib/patch-evidence-gold.ts` (o un sibling `edited-symbols-from-diff.ts`).
1. **Exportar `enclosingSymbol`** (quitar el `function` privado → `export function`).
2. **Extender `parseUnifiedDiff`** (o agregar helper) para capturar líneas del lado **VIEJO**:
   el `HUNK_RE` (línea 41) ya captura `+start`; parsear también `-oldStart` y llevar un `oldCursor`
   que avanza en `-` y contexto. Devolver `removedLines[]` (o `oldSideLines[]` = removidas+contexto)
   además de `addedLines`. Extender el type `DiffFileChange`.
3. Nueva función:
   ```
   deriveEditedSymbolsFromCheckout(
     changes: DiffFileChange[],   // del patch, con oldSideLines
     project: Project,            // ts-morph sobre el checkout BASE
     repoDir: string,
   ): SymbolRef[]
   ```
   Por cada `change` (excluir tests con `sourceChangesFromPatch`), abrir `project.getSourceFile(abs)`,
   y por cada línea vieja: encontrar el nodo más específico que la contiene y llamar
   `enclosingSymbol` → `{file: change.path, symbol, kind}`. Dedup (`dedupeSymbols`, ya existe:123).
   Nodos que no caen en ninguna declaración → omitir (esa parte queda file-level vía `edited_files`).
   Reusar el patrón de walk de `enrichPatchEvidenceWithDefinitions` (281-312).
4. **Construir el `Project` de ts-morph** sobre el checkout: mirar cómo lo hace el extractor de grafo
   (`src/extractor` o `src/graph` — buscar `new Project(`), o crear uno ad-hoc con
   `new Project({ useInMemoryFileSystem:false })` + `addSourceFileAtPath(abs)` por cada changed_file.
   NO importar de `src/graph/*` (regla del arnés: el gold debe ser independiente del sistema bajo
   prueba; hay un test estructural que lo verifica — ver header de patch-evidence-gold.ts).
5. **Test** (`patch-evidence-gold.test.ts`): fixture con un archivo TS + un diff que modifica una
   función y un método; assert que `edited_symbols` = `{func, Clase.metodo}` con kinds correctos, y
   que una adición pura cae a file-level. NO requiere descargar nada.

### 3.2 Importador `import-multi-swe-bench.ts` (~120 líneas)
Sibling de `import-swe-polybench.ts`. Reusa sus piezas (varias son privadas → **exportarlas** o
copiar: `cleanIssueText`, `areasFromFiles`, `writeReposManifest`, `writeTasksManifest`,
`writePatchSidecars`, `writeRunManifest`; `repoNameFromSlug`/`deriveSourceRoots`/`loadEasyInstances`
YA exportadas). Estructura:
- **Loader**: leer el jsonl de Multi-SWE-bench (ver §4 sobre la descarga). Schema por instancia
  (confirmar al bajar): `{org, repo, number, base_commit, fix_patch, test_patch, problem_statement,
  resolved_issues?}`. `instance_id` = `${org}__${repo}-${number}`; `url` = `https://github.com/
  {org}/{repo}.git`.
- **Filtro multi-hop (proxy)**: incluir instancias cuyo `fix_patch` toca ≥2 archivos fuente
  (`filesInDiff(fix_patch)` menos los de `test_patch`, ≥2). Flag `--only-mixed` análogo.
- **build()**: por instancia → task/repo como en import-swe-polybench.ts:327-386, pero:
  - `gold.patch_evidence` = `extractPatchEvidenceTier1({patch: fix_patch, testPatch: test_patch,
    modifiedNodes: null, changedFiles: filesInDiff(fix_patch), f2p: null})` → arranca file-level.
  - `edited_symbols` se rellena en el paso §3.3 (post-checkout), NO en el import (no hay repo aún).
  - `source_roots` = `deriveSourceRoots(changed_files)`.
  - `deterministic_input.query/embedding_input` = `cleanIssueText(problem_statement)`.
  - `target_tests` desde `test_patch` (opcional).
- Escribir con `--append`/`--out-dir` reusando los writers (el guard de append ya evita clobber).

### 3.3 Enriquecimiento de símbolos post-checkout (nuevo paso o dentro del importador)
Como los símbolos necesitan el repo en `base_commit`, dos opciones:
- **(A, recomendada) Paso post-prepare** `eval/scripts/enrich-gold-symbols.ts`: lee el lock del run
  (`repos.lock.json` → `repoPath` por task), para cada task lee su `swe_polybench.patch_ref`
  (sidecar en `patches/`), corre `deriveEditedSymbolsFromCheckout` y **reescribe `tasks.yaml`**
  poniendo `gold.patch_evidence.edited_symbols` (+ `resolution.fell_back_to_file_level=false` si
  encontró símbolos). Idempotente. Correr tras `eval:prepare`, antes de `eval:retrieval`.
- (B) Dentro del importador, checkout efímero por instancia (más lento, mezcla responsabilidades).
Elegir A. Nota: este paso sirve TAMBIÉN para SWE-PolyBench si alguna vez se quiere gold símbolo sin
depender de `modified_nodes`.

### 3.4 Selección de repos + splits (paso de datos, tras §4)
10 repos, todos >1000★, todos gold-símbolo:
- 5 SWE-PolyBench (símbolo nativo): `sveltejs/svelte, mui/material-ui, serverless/serverless,
  prettier/prettier, microsoft/vscode`.
- 5 Multi-SWE-bench (símbolo derivado): `vuejs/core (48), iamkun/dayjs (56),
  anuraghazra/github-readme-stats (19), axios/axios (4), expressjs/express (4)`. (darkreader/insomnia
  tienen 1-2, muy pocas.) Ajustar según conteos reales al bajar.
Importar ambos regímenes (multi-hop principal + single-hop control) al bundle `swe-polybench-multi`
o a un bundle nuevo `swe-polybench-10repos`. Añadir splits `bench10_mh` / `bench10_sh` con las 8
estrategias. Objetivo: **≥30 multi-hop** (holgado: SWE-PolyBench solo ya tiene 462 disponibles).

## 4. Descarga de datos Multi-SWE-bench (el usuario; confirmar layout)
Dataset HF: **`ByteDance-Seed/Multi-SWE-bench`**. **CONFIRMAR el layout** antes de codear el loader:
Multi-SWE-bench suele publicarse como **jsonl por-repo** (archivos tipo `<org>__<repo>_dataset.jsonl`)
en el repo HF, NO como un split navegable — así que `fetch_metadata.py` (que usa datasets-server y el
schema de SWE-PolyBench) **no sirve tal cual**. Opciones: `huggingface_hub.snapshot_download` de los
jsonl TS/JS, o `curl` a las URLs `https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/
resolve/main/<archivo>.jsonl`. Escribir un `fetch_multi_swe_bench.py` mínimo (stdlib+urllib como
fetch_metadata.py) que baje solo los 5-9 repos TS/JS y normalice a un jsonl con los campos que el
importador espera. Repos TS/JS confirmados (paper 2504.02605, Tabla 1): TS = darkreader(2),
mui(174), vuejs/core(48); JS = github-readme-stats(19), axios(4), express(4), dayjs(56),
insomnia(1), svelte(272). mui y svelte SE SOLAPAN con SWE-PolyBench → usar los NUEVOS.

## 5. Correr (el usuario, terminal normal — indexado pesado)
Extender `run-benchmulti.sh` (o uno nuevo) para: fetch → import (§3.4) → `enrich-gold-symbols` →
prepare (clone-reuse) → index (embedding, lento) → retrieval `bench10_mh`+`bench10_sh` (8 estrat) →
metrics + compare. Un run-id por régimen (por el truncado de retrieval.jsonl). Excluir gigantes
asset-heavy (three.js) — vscode es grande pero puro TS, indexable con paciencia.

## 6. Verificación
- `deriveEditedSymbolsFromCheckout`: test de fixture verde (símbolo + fallback file-level). `npm test`
  + typecheck (`tsc --project eval/tsconfig.json --noEmit`) verdes.
- Tras enrich: en tasks.yaml de un repo Multi-SWE-bench, `edited_symbols` no vacío en instancias con
  modificación (no pura adición); `fell_back_to_file_level=false` ahí.
- `eval:check-manifests` valida el bundle con 10 estrategias + splits nuevos.
- Conteo: `bench10_mh` ≥30 tareas `ready` en **10 repos distintos**, todos >1000★.
- Tras la corrida: `EditSiteHit.status==computed` por celda; el guard de validez
  (compute-retrieval-metrics.ts) NO se dispara; en multi-hop connector se separa de hybrid/ppr.

## 7. Decisiones abiertas para el usuario
- Bundle nuevo `swe-polybench-10repos` vs extender `swe-polybench-multi` (recomiendo nuevo: nombre
  claro = la medida de la tesis).
- Cuántas instancias por repo (p.ej. 6-8 multi-hop × 10 = 60-80) — balancear poder vs costo de index.
- ¿Incluir single-hop control? (recomendado: sí, muestra el contraste régimen-dependiente).
- axios/express tienen pocas instancias (4 c/u); si no alcanzan, sustituir por más profundidad en
  vue/dayjs o sumar un 11º repo de SWE-PolyBench (three.js con sparse-checkout, o code-server).

## Archivos a crear/tocar
- CREAR `eval/scripts/lib/edited-symbols-from-diff.ts` (o extender patch-evidence-gold.ts) — §3.1.
- CREAR `eval/scripts/import-multi-swe-bench.ts` — §3.2.
- CREAR `eval/scripts/enrich-gold-symbols.ts` — §3.3.
- CREAR `eval/scripts/swe-polybench/fetch_multi_swe_bench.py` — §4 (o reusar patrón fetch_metadata.py).
- EDITAR `eval/scripts/lib/patch-evidence-gold.ts` — exportar `enclosingSymbol`, extender
  `parseUnifiedDiff` (lado viejo).
- EDITAR `import-swe-polybench.ts` — exportar los writers/helpers que reuse el nuevo importador.
- CREAR splits en el `run.yaml` del bundle elegido; EXTENDER `run-benchmulti.sh`.
- NO tocar: `metrics.ts`, el pipeline (prepare/index/retrieval) — funcionan igual con gold símbolo.
