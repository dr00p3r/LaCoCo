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

## 4. Pendiente / siguiente (decisión abierta)

El mecanismo está demostrado; falta medir el **lift de retrieval** end-to-end: re-indexar los 5 repos mui de
`bench15` con las aristas nuevas y re-correr `consensus`, comparando EditSiteHit/MRR contra el 0.20 baseline.
Requiere clonar+indexar mui (lento/flaky aquí; usar el shallow single-commit fetch documentado). Matiz: el
puente es 3-hop y `consensus` expande 1-hop desde las anclas → el lift depende de que las anclas BM25/ANN
caigan sobre `MenuItem`/`ListItem.js#default`; es la pregunta empírica del benchmark.
