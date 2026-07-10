# React-aware extractor: aristas de composición JSX y diagnóstico corregido de mui 0.20

**Fecha:** 2026-07-10 · **Rama:** `feat/react-aware-extractor` · **Suite:** 348/348 · typecheck verde
**Contexto:** frente vivo tras `bench15` (svelte+prettier+mui). mui salió 0.20 EditSiteHit. La memoria lo
atribuía a un artefacto del gold ("React función vs `Clase.método`"). **Este trabajo refuta ese diagnóstico
con evidencia empírica** y añade a LaCoCo un grafo de composición React (RENDERS/CONSUMES_DATA) que conecta
consumidores con edit-sites a través del idioma HOC de mui.

## 1. Diagnóstico corregido (la memoria estaba equivocada)

Tres hechos empíricos, todos verificables:

- **El gold mui NO es arrow/HOC.** Sobre las **70** instancias mui del dataset completo, el primer nodo CST
  de `modified_nodes` es **solo** `function_declaration` (86) o `class_declaration` (23). **Cero** arrow /
  lexical / variable. El traductor de 3 ramas (`swe-polybench-nodes.ts`) ya cubre el **100%** del gold mui.
  → La "rama traductor arrow" que proponía el plan es **innecesaria** (0 consumidores).
- **Los `.js` parsean JSX sin flag `jsx`.** TypeScript parsea JSX en `.js` por defecto (no hay ambigüedad
  `<T>` como en `.ts`). Probado en los 4 casos (`.js`/`.jsx`/`.tsx`, con/sin `jsx:react`): `JsxElements=3` y
  RENDERS se emiten igual. → El "override `jsx` en el tsconfig del eval" también es **innecesario**.
- **Los nodos del gold se extraen bien.** Sobre el `ListItem.js` **real** al base_commit de material-ui-11451
  (`class ListItem extends React.Component`, edit en `render()`), LaCoCo produce `…/ListItem.js#ListItem.render`.
  El gold matchea a nivel nodo.

**Conclusión:** mui 0.20 **no** es un artefacto de gold ni de parseo. Es un problema de **ranking de
retrieval**: el edit-site (`ListItem.render`) no entra al top-10 para la query del issue. El valor que aporta
el soporte React no es "arreglar el gold" sino **dar al grafo la señal de composición** que permite al
retriever puentear de la query al edit-site.

## 2. El caso canónico: el puente de composición (demostrado en código real)

material-ui-11451: el issue habla de **`MenuItem`** ("MenuItem doesn't respect focusVisibleClassName"), pero
el fix vive en **`ListItem.render`**. En mui, `MenuItem` renderiza `<ListItem>`, importado vía barrel y
consumido como **default export HOC** (`export default withStyles(styles)(ListItem)`). Corriendo el extractor
React-aware sobre los 3 archivos reales (`ListItem.js` + `ListItem/index.js` + `MenuItem.js`):

```
MenuItem#MenuItem   ─[RENDERS]→    ListItem.js#default
ListItem.js#default ─[REFERENCES]→ ListItem.js#ListItem
ListItem.js#ListItem ─[DECLARES]→  ListItem.js#ListItem.render   ← GOLD
```

Sin estas aristas **nada** conecta la query (MenuItem) con el edit-site (ListItem.render). El eslabón
crítico fue mapear el **default export** (`ExportAssignment`) a `filepath#default` en `resolveDeclarationToId`
— sin eso, `<ListItem>` (que resuelve al default HOC) no producía arista y el puente se rompía.

## 3. Cambios de producto (extractor React-aware)

Todo tras el patrón existente (callbacks `insertNode`/`insertEdge`, IDs canónicos `filepath#símbolo`, cero
regex — solo type-guards ts-morph). Relación nueva **`RENDERS`** (grupo CPG en `EdgeRelation` +
`RELATION_TO_DIM` → la aprovecha `consensus` vía `getIntentWeights`). Sin NodeKind nuevo, sin migración de BD.

- `src/extractor/react-predicates.ts` (nuevo): `isPromotableReactLocal` (promueve componentes/hooks NO
  exportados solo en archivos JSX-capable → no inunda backend `.ts`), `unwrapReactWrapper`
  (forwardRef/memo/styled/withStyles), `fileIsJsxCapable` (cache por SourceFile).
- `src/extractor/react-extraction.ts` (nuevo): `extractJsxRelations` → RENDERS por `<Componente/>`
  (salta host intrínsecos minúscula), CONSUMES_DATA por props identificador; resuelve tags con
  `resolveSymbolToId` (maneja aliases de import).
- `variable-extraction.ts`: relaja el guard de export para React locals; enriquece wrappers HOC con las
  aristas del componente interno / REFERENCES al envuelto.
- `node-extraction.ts`: `extractDefaultExportExpressions` cubre `export default withStyles(...)(Foo)`
  (antes: sin nodo) → `filepath#default` + REFERENCES al envuelto.
- `callable-analysis.ts`: `analyzeCallable` llama `extractJsxRelations` (cubre funciones, métodos de clase
  como `render()`, y métodos de object-literal con un solo hook); union ampliada con `FunctionExpression`.
- `utilities.ts` (lockstep crítico): `resolveDeclarationToId` resuelve React locals promovidos (mismo
  predicado que el emisor) **y** el default export (`ExportAssignment` → `filepath#default`).
- Tests: `tests/extractor/react-extraction.test.ts` (9 casos: promoción, no-inundación, forwardRef+RENDERS,
  composición+props, default HOC, `.ts` intacto, puente barrel+HOC estilo mui, RENDERS→CPG).

## 4. Causa raíz definitiva de mui 0.20: `.d.ts` ensombrece el `.js` (medido)

Re-indexando los 5 mui salió la causa **real** (ni gold, ni jsx, ni el extractor): cada componente mui tiene
`Foo.js` (implementación) **y** `Foo.d.ts` (stub de tipos). Con ambos en el `include`, TypeScript resuelve el
módulo al `.d.ts` y **descarta el `.js` del programa**. Resultado en `ListItem`: el índice bench15 tenía
`ListItem.d.ts#ListItemProps` (tipos) pero **NO** `ListItem.js#ListItem.render` — el gold **nunca estuvo en el
grafo**. Solo **53** nodos `.js` en todo `packages/material-ui/src` (cientos de componentes).

**Fix (eval, `repos.yaml` override por mui):** `exclude: ["**/*.d.ts", "**/*.test.js"]` +
`moduleResolution: node` + `jsx: react`. Con eso los `.js` pasan a ser la fuente: nodos `.js` 53→**794-985**,
y los **5/5 gold nodes aparecen en el grafo** (antes 0).

## 5. Resultado medido — mui EditSiteHit@10: 0.20 → 0.80 (4×)

Re-index (graph+vectors, React-aware + exclude-`.d.ts`) de los 5 mui + retrieval `baseline` (run
`2026-07-10-mui-react`, split `mui5`, overfetch=1):

| estrategia | mui ANTES (bench15) | mui AHORA | EditSiteMRR |
|---|---|---|---|
| hybrid    | 0.20 | **0.80** | 0.400 |
| clcr      | 0.20 | **0.80** | 0.362 |
| consensus | 0.20 | **0.80** | 0.395 |

4/5 aciertan (11451, 11858, 12406, 13690); 13778 miss real (gold función `removeContainerStyle` fuera de
top-50). Ranks de símbolo (0-idx): 11858 r0, 13690 r5-7, 11451 r8-9 (símbolo en top-10); 12406 símbolo en
r10-12 → hit por **file-level fallback**. Baseline verificado: el bench15 tenía mui 0.20 en las 3 estrategias
porque el gold no estaba indexado.

**Atribución honesta:** el lift (0.20→0.80) viene **enteramente del fix de indexado (`exclude .d.ts`)**, que
mete el edit-site en el grafo. Las aristas React (RENDERS) son correctas y el grafo de composición se demostró
en código real, **pero NO dan lift de retrieval sobre `hybrid` en estas 5 celdas**: consensus empata a hybrid
en EditSiteHit (0.80) y rankea el gold un pelín **peor** (r9 vs r8, r7 vs r5, r12 vs r10) — su expansión de
grafo demota levemente el ancla semántica fuerte. Consistente con el veredicto de escala
([[ann-dimensional-anchor-verdict]]): el grafo ≈ hybrid; el lever de mui era el indexado, no la estrategia.

## 6. Pendiente
- Ablación limpia (exclude-`.d.ts` con extractor viejo vs nuevo) para aislar 0% del efecto RENDERS — el
  presente run confirma que el lift es del indexado, no de las aristas.
- Puente cross-file (`MenuItem→ListItem`) a `.js`: TS resuelve imports al `.d.ts` aun excluido del `include`,
  así que RENDERS cross-file apunta al stub de tipos, no al `.js`. Habría que evitar que TS vea los `.d.ts`
  (más invasivo) para que la composición conecte al edit-site `.js`.
- Baselines del consenso (RepoGraph + Aider/PPR) — el siguiente de mayor valor para la tesis.
