# Diseño: semantic profile / lista de aliases para grounding

**Estado:** diseño (no implementado) · **Fecha:** 2026-07-05 · **Objetivo:** reducir M2
(Hallucination Rate) del benchmark de generación mediante grounding sobre símbolos
reales del proyecto.

> Este documento es **solo diseño**. No toca código en ejecución ni el piloto en
> curso. Su propósito es dejar decidido el modelo de datos y el contrato antes de
> implementar, aprovechando la infraestructura que **ya existe**.

## 1. Qué mide M2 y por qué el grounding ataca la causa

`analyze-hallucinations.ts` define M2 así: aplica el patch del agente en un worktree,
resuelve con `ts-morph`/type checker cada call/`new`/acceso a propiedad, y cuenta:

- `invalid_calls`: identificador **sin `Symbol`** en el type checker → alucinación.
- `analyzable_calls`: identificador resoluble → válido.
- `unknown_calls`: dinámico/`any`/index access → excluido del denominador.

`M2 = invalid_calls / (invalid_calls + analyzable_calls)`.

Es decir, **M2 penaliza exactamente los identificadores que el modelo inventa** y que
no existen en el código. El grounding busca reducir ese numerador dándole al pipeline
el vocabulario real del proyecto y obligando a que las referencias procedan de ahí.

## 2. Dos superficies de grounding (evitar confundirlas)

El código actual tiene grounding en la superficie **(A)**; el objetivo de M2 vive en
la superficie **(B)**, que es donde este diseño aporta.

### (A) Grounding de la *consulta* — YA EXISTE

En retrieval, el `QueryGrounder` (`src/semantic-profile/query-grounder.ts`) recupera
hasta 20 candidatos del perfil (exact match sobre `semantic_aliases.normalized_value`
+ `semantic_terms.normalized_term`, combinado con FTS5) y el clasificador SLM valida
que **cada cláusula del `clean_query`** proceda del prompt, de un `canonical_term` o de
uno de sus aliases (`classifier.ts` → `validateGroundedClassification`), con bucle de
reparación si no. Aquí los **aliases son vocabulario de búsqueda multilingüe** (es/en)
y su función es mejorar la *recuperación* del contexto correcto.

**Los aliases NO son símbolos reales del código** — así lo dice ya el `SYSTEM_PROMPT`
del enricher y la instrucción de grounding. Esta distinción es la piedra angular del
diseño de (B).

### (B) Grounding de la *generación* — HUECO QUE CUBRE ESTE DISEÑO

El generador recibe el prompt con la sección `lacoco_context` (los chunks recuperados)
y la instrucción "No inventes símbolos que no aparezcan aquí"
(`prompt-injector.ts`). Pero hoy:

- No hay una **allow-list explícita** de los identificadores reales que el contexto
  recuperado expone (nombres de símbolos, con firma y ruta).
- El generador **no** ve los aliases (correcto), pero tampoco ve una lista curada de
  "estos son los símbolos que puedes referenciar".
- No hay un paso de **verificación post-hoc** que cruce los `invalid_symbols` de M2
  contra el perfil para distinguir "alucinación pura" de "símbolo real pero no
  recuperado" (fallo de retrieval, no del generador).

## 3. Concepto: el "grounding profile" de una celda

Para cada celda de generación `(task, strategy)` definimos un **grounding profile**:
el conjunto de símbolos reales que el generador está autorizado a referenciar, derivado
de los chunks efectivamente inyectados en el prompt más el perfil semántico del repo.

```
grounding_profile(cell) = {
  allowed_symbols: [                    # SUPERFICIE B — identificadores emitibles
    { canonical: string,               # nombre real del símbolo (semantic_terms.canonical_term)
      node_id: string,                 # id del nodo en el grafo (trazabilidad)
      kind: "symbol"|"source-file"|... # semantic_terms.kind
      path: string,                    # ubicación
      signature?: string,             # firma si es callable (de callable-analysis)
      source: "retrieved" | "profile" }# ¿vino del contexto recuperado o del perfil global?
  ],
  search_aliases: [                     # SUPERFICIE A — solo vocabulario de búsqueda
    { term_id, value, language, confidence }   # semantic_aliases (NO emitibles)
  ]
}
```

Reglas duras:

1. `allowed_symbols` se construye **solo** a partir de `semantic_terms` (símbolos que
   existen en el grafo), nunca de `semantic_aliases`.
2. `search_aliases` **nunca** se presentan al generador como identificadores válidos.
   Se usan para retrieval (A) y, opcionalmente, para diagnósticos.
3. `source: "retrieved"` marca los símbolos presentes en los chunks inyectados;
   `source: "profile"` marca símbolos del repo no recuperados. Esta distinción permite,
   en el análisis M2, separar *alucinación* de *fallo de recuperación*.

## 4. Reutilización de infraestructura existente (no reinventar)

| Pieza necesaria | Ya existe en | Reutilizar tal cual / extender |
|---|---|---|
| Términos canónicos + kind + node_id + dimensiones | `semantic_terms` (migration `004_add_semantic_profile.sql`) | Reutilizar como fuente de `allowed_symbols`. |
| Aliases multilingües con confianza | `semantic_aliases` | Reutilizar como `search_aliases` (superficie A). |
| Generación de aliases vía LLM | `semantic-term-enricher.ts` | Reutilizar; no cambia. |
| Búsqueda exact + FTS5, top-20 | `semantic-profile-store.ts` / `query-grounder.ts` | Reutilizar para (A). |
| Validación de vocabulario en clean_query | `classifier.ts` → `validateGroundedClassification` | Reutilizar para (A). |
| Métricas de grounding | `eval/scripts/lib/semantic-profile-metrics.ts` | Extender con métricas de (B) — ver §7. |
| Firmas de callables | `src/extractor/callable-analysis.ts` | Fuente de `signature` en `allowed_symbols`. |

**Conclusión:** la capa de datos (perfil, términos, aliases) y la superficie (A) están
completas. Lo nuevo es (B): materializar el `grounding_profile` por celda y usarlo para
verificación M2 (y, opcionalmente, para reforzar el prompt).

## 5. Taxonomía de aliases (para la superficie A)

Formalizar qué tipos de alias produce/espera el enricher, para poder auditarlos y medir
su calidad. No requiere cambio de esquema (`semantic_aliases` ya tiene `value`,
`language`, `confidence`); es una convención de anotación:

| Tipo | Ejemplo (canonical → alias) | Uso |
|---|---|---|
| Traducción | `OrderService` → "servicio de órdenes" | consulta en español |
| Sinónimo técnico | `auth` → "authentication", "login" | vocabulario alterno |
| Expansión descriptiva | `save` → "persistir", "escribir en BD" | intención del usuario |
| Acrónimo/abreviatura | `dto` → "data transfer object" | desambiguación |

Regla transversal (ya en el `SYSTEM_PROMPT` del enricher): un alias es **cómo la gente
busca** el símbolo, no un identificador que exista en el código. Por eso quedan fuera de
`allowed_symbols`.

## 6. Flujo propuesto (diseño, sin implementar)

```
BUILD (ya existe):
  profile rebuild → semantic_terms (canónicos) + semantic_aliases (búsqueda)

RETRIEVAL (superficie A, ya existe):
  query → QueryGrounder → candidatos+aliases → SLM clean_query grounded → chunks

NUEVO — materializar grounding_profile por celda:
  chunks inyectados + semantic_terms
    → allowed_symbols (canónicos con node_id/path/signature, source=retrieved|profile)
    → persistir junto a los artefactos de la celda (p. ej. grounding.json)

GENERACIÓN (superficie B):
  Opción B1 (verificación post-hoc, recomendada como primer paso):
    M2 ya lista invalid_symbols. Cruzar cada invalid_symbol contra:
      - allowed_symbols(source=retrieved)  → símbolo estaba en contexto: fallo del modelo
      - allowed_symbols(source=profile)    → existía en el repo pero NO se recuperó:
                                             fallo de retrieval, no alucinación pura
      - ninguno                            → alucinación pura
    Esto NO cambia el prompt ni el generador: es análisis, no intervención.
  Opción B2 (refuerzo de prompt, posterior):
    añadir a la sección de contexto una lista corta y explícita de allowed_symbols
    (nombre + firma) como "símbolos disponibles", manteniendo idéntica la estructura
    entre condiciones para no romper la comparación M1/M2.
```

Se recomienda **empezar por B1**: es puramente analítico, no altera el benchmark en
curso y descompone M2 en "alucinación pura" vs "fallo de recuperación", lo que a su vez
informa si conviene invertir en B2 o en mejorar retrieval.

## 7. Métricas nuevas (extensión de `semantic-profile-metrics.ts`)

- `m2_pure_hallucination_rate`: invalid_symbols que no están en `allowed_symbols` /
  total analizable. (La fracción de M2 realmente atribuible al generador.)
- `m2_retrieval_miss_rate`: invalid_symbols que sí existen en el repo (source=profile)
  pero no se recuperaron / total. (Atribuible a retrieval.)
- `grounding_coverage`: |allowed_symbols(source=retrieved)| / símbolos referenciados
  válidos. (Cuánto de lo que el modelo usó bien vino realmente del contexto.)

## 8. Riesgos y decisiones abiertas

- **Ambigüedad alias → múltiples canónicos.** Un alias puede mapear a varios términos.
  Solo afecta (A); en (B) es irrelevante porque `allowed_symbols` se deriva de
  `semantic_terms`, no de aliases. Documentar la política de desempate en (A) (hoy:
  ranking exact+FTS5).
- **Fuga de aliases como identificadores.** El riesgo central: nunca inyectar
  `search_aliases` en la lista de símbolos emitibles. Test de diseño: `allowed_symbols`
  y `search_aliases` deben construirse desde tablas distintas y no mezclarse jamás.
- **Símbolos de dependencias externas.** `semantic_terms.kind` incluye `dependency` y
  `external-import`. Decidir si el generador puede referenciar símbolos de deps (p. ej.
  `zod`, `rxjs`) que no están en `src` del repo: probablemente sí (son válidos para el
  type checker), pero conviene marcarlos aparte para el análisis M2.
- **Estabilidad del benchmark.** Cualquier variante B2 que cambie el prompt debe
  aplicarse a las 3 (o 5) estrategias por igual y mantener la sección `lacoco_context`
  presente (Opción B del piloto) para no introducir una variable de confusión.

## 9. Fuera de alcance de este ciclo

- Implementación de B1/B2 (esto es solo diseño).
- Feedback loop que ajuste aliases según qué consultas fallan.
- Aliases negativos ("no incluyas estas palabras").
- Ponderación de aliases por uso real.
