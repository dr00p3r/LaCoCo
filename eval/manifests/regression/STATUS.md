# F0 — Estado de los 6 broken_patch

Generado en la sesión del rediseño M1 a regresión. Documenta qué tareas
tienen broken_patch válido y cuáles quedan fuera del piloto.

## Resultado por tarea

| Task | Estado | grading_tests aproximados | Notas |
|---|---|---|---|
| zod-001 | DENTRO | `trim` (1 test) | Patch: quitar la rama `check.kind === "trim"` en `_parse` (línea 900-901). |
| zod-002 | DENTRO | `strict`, `strictcreate`, `constructor key` (3 tests) | Patch: vaciar el cuerpo de la rama `unknownKeys === "strict"` (líneas 2518-2524). |
| inversify-001 | FUERA | — | La validación de `serviceIdentifier` nunca existió en este commit. No hay test que la exija (el test de `toSelf` solo verifica el mensaje, no la instancia). El task es feature request, no bug fix; no hay estado histórico al que revertir. |
| inversify-002 | DENTRO | 2 tests en `throwAtInvalidClassMetadata.spec.ts` | Patch: cambiar `throw new InversifyCoreError(...)` por `throw new Error(...)` en `throwAtInvalidClassMetadata.ts`. Ambos `it('should throw an Error')` fallan en `toBeInstanceOf(InversifyCoreError)`. |
| rxjs-001 | DENTRO | 17 tests en `mergeMap-spec.ts` | Patch: quitar `!active` del `checkComplete` (línea 47: `if (isComplete && !buffer.length) {`). 17 tests fallan por emisión de `complete` prematura. |
| rxjs-002 | FUERA | — | El testScheduler que usan los 16 tests de `delay-spec.ts` enmascara el cambio de scheduler; quitar el scheduler de `timer(due, scheduler)` no rompe ningún test. No hay discriminante. |

## Piloto de regresión

4 tasks: zod-001, zod-002, inversify-002, rxjs-001.

## Artefactos

- `eval/manifests/regression/<task-id>.broken.diff` — 4 diffs (los 2 OUT no se commitean).
- Estos diffs se aplican en `prepare_repos` sobre el `base_commit` (que debe coincidir con `repos.lock.json#commit`).
