# Propuestas innovadoras para LaCoCo — qué MÁS construir

> Ideación aterrizada, no auditoría. Cada propuesta lista: **idea**, **pieza de código que
> reutiliza** (verificada en el árbol) y **qué caso multi-hop ataca**. Ordenadas por leverage/costo.
> C1 se construye en esta iteración (tras flag); B (anclaje ANN dimensional) ya está construido.
> Estado nube/SLM: la métrica-norte de agente sigue condicionada a nube; todo lo de aquí es
> diseño+build de retrieval, medible en el n=8 svelte con índice local.

## Contexto de diseño (el hueco que abre estas ideas)

El anclaje denso de LaCoCo tenía dos cegueras simétricas, ambas en el canal ANN:

- **Lado query, vocabulario:** `embedding_input` es lenguaje del *issue* ("save falla al persistir"),
  no lenguaje del *código* (`function persist(order: Order)`). El embedding cruza ese hueco a ciegas.
  → **C1 (HyDE)** lo cierra reescribiendo la query como código hipotético.
- **Lado doc, dimensión:** cada fila LanceDB guarda su `dimension` (`SYS/CPG/DTG`), pero el ANN la
  ignoraba. → **Mejora B** (ya construida) sesga el pool ANN por intención→dimensión.

C2–C5 extienden estas dos direcciones (query-side / doc-side / grafo-side / research).

---

## C1 · HyDE-code — EASY — *se construye aquí (tras `LACOCO_HYDE`)*

**Idea.** En lugar de embeber la descripción del bug, el SLM escribe el **fragmento TS hipotético que
probablemente lo arregla o que lanzaría el error**, y se embebe *eso*. Es HyDE (Hypothetical Document
Embeddings) especializado a código: acerca el vector de la query al vector del código objetivo.

**Reutiliza.** El intermediario existente: `hyde-generator.ts` espeja `classifier.ts` (mismo
`LlmClient.chat`, `format` JSON, `temperature:0/seed:42`, `think:false`). `applyHyde` reemplaza
`sanitizer.embedding_input` tras la clasificación (RRF/BM25 intactos: solo se mueve el canal denso).
Inyectado en `run-retrieval.ts` (freeze del sanitizer, A/B) y `pipeline.ts` (prod). Flag off por
defecto → cero regresión. Modelo vía `hyde.model` (hereda `intermediary.model`).

**Ataca.** Los multi-hop "duros" del smoke svelte donde el retrieval plano no llega (memoria
`swe-polybench-fulltext-query-result`: 4/9 tareas quedaron duras tras pasar a query=texto-completo).
HyDE es el siguiente paso natural de esa palanca: de *texto del issue* a *código hipotético*.

**Predicción.** Sube EditSiteHit@10 en tareas donde el issue describe síntoma (error de runtime,
mensaje de rollup) pero el edit-site es una función con vocabulario distinto. Riesgo: SLM débil mete
ruido → por eso off por defecto y A/B flag on/off.

---

## C2 · Indexación de proposiciones / capacidades — MEDIUM — *doc-side, siguiente build*

**Idea.** Simétrico a C1 pero del lado del documento: por cada nodo, el enricher emite 1–3 **enunciados
atómicos de capacidad** en lenguaje natural ("valida que un DTO cumpla el esquema", "persiste una orden
en el repositorio") y se embeben *junto* al código. La query semántica (lenguaje de issue) matchea la
proposición (lenguaje de issue) en vez del código (lenguaje de código).

**Reutiliza.** `semantic-profile/semantic-term-enricher.ts` + `LACOCO_ENRICH_CONCURRENCY` ya recorren
el grafo llamando al SLM por lotes; se añade un segundo prompt "proposición" y una fila LanceDB extra
por nodo (`sub_type: "proposition"`). **Le da razón de ser al Project Semantic Profile**, que hoy "no
paga" en query-grounding (memorias `grounding-ab-svelte-*`): reorientado a recuperación doc-side, el
perfil pasa de metadato de re-ranking a canal de recuperación de primera clase.

**Ataca.** El mismo hueco de vocabulario que C1, pero desde el otro extremo — y **compone** con C1: HyDE
acerca la query al código; las proposiciones acercan el doc al issue. Juntas cierran la brecha por
ambos lados. Especialmente tareas donde el edit-site no comparte *ningún* token con el issue.

**Costo/riesgo.** Un embedding extra por nodo (índice ~1.5–2×); build más lento (mitigable con la
concurrencia ya paralelizada, memoria `grounding-build-speedup`). Medir si el recall extra paga el
tamaño de índice.

---

## C3 · PageRank personalizado como prior — EASY/MEDIUM — *grafo-side, siguiente build*

**Idea.** Generaliza el "voto 1-hop" del ranker de consenso a **centralidad multi-hop**: PageRank
personalizado (PPR) sobre el grafo tipado, con el vector de personalización sesgado hacia los nodos
query-hit + edit-site. Es la receta del repo-map de Aider, pero sobre aristas derivadas del compilador
(no imports de texto). Entra como **otra lista al RRF**, junto a BM25 y ANN.

**Reutiliza.** El grafo tipado y las aristas (`domain/dimensions.ts` `RELATION_TO_DIM`), la maquinaria
RRF de `hybrid-anchor-service.ts`, y los pesos por intención de `intent-weights.ts` (para ponderar
aristas por dimensión en la caminata). **Refuerza —no reemplaza— el consenso**: el consenso vota a
1 hop; PPR propaga esa señal a K hops con decaimiento.

**Ataca.** Multi-hop donde el edit-site está a 2–3 saltos del query-hit (p. ej. el bug se describe en
términos de una API pública pero se arregla en un helper interno que ninguna búsqueda directa toca).
El consenso 1-hop se queda corto ahí; PPR lo alcanza.

**Nota.** Es también el **baseline de Aider** para el doc de posicionamiento — construir C3 mata dos
pájaros: mejora y baseline citable a la vez.

---

## C4 · Multi-hop agéntico por dimensión — MEDIUM/HARD — *apuesta research*

**Idea.** Un lazo agéntico donde el estado de razonamiento decide, por hop, **qué dimensión expandir**
(SYS para contratos, CPG para flujo de llamadas, DTG para flujo de datos) en vez de expandir todo el
vecindario. Las aristas derivadas del compilador hacen el pruning por-hop más fiable que en KGs ruidosos
(donde el multi-hop agéntico se ahoga en falsos vecinos).

**Reutiliza.** El andamiaje de `agentic-strategy.ts` (única estrategia con `LlmClient` en el retriever)
y la tipificación de aristas. El SLM ya sabe qué dimensiones importan (`SanitizerOutput.dimensions`);
aquí las usa como *acciones* de expansión, no solo como pesos.

**Ataca.** Cadenas de razonamiento largas (4+ hops) donde una expansión uniforme explota en ruido. Es
la carta fuerte de LaCoCo frente a RAG plano: el grafo tipado convierte "explora el vecindario" en
"sigue la arista de tipo correcto".

**Costo/riesgo.** Latencia y costo de SLM por hop; necesita nube o SLM capaz para el A/B honesto. Apuesta
de mayor retorno pero mayor incertidumbre; especificada aquí, no construida.

---

## C5 · Parqueadas (con motivo)

- **Resúmenes de comunidad (Leiden).** Clustering del grafo tipado + resumen por comunidad para
  consultas *arquitectónicas* ("¿cómo fluye la autenticación?"). Útil cuando la query no tiene un
  edit-site puntual sino una respuesta de subsistema. Parqueada: el norte actual es edit-site, no
  arquitectura.
- **Aristas bi-temporales.** Timestamp de validez en cada arista → freshness incremental y consultas
  "¿cómo era el call-graph en el commit X?". Parqueada: requiere reingeniería del indexador; alto costo,
  retorno diferido.
- **Chunking cAST (AST-aligned).** Chunks alineados a fronteras del AST en vez de líneas. Parqueada:
  LaCoCo ya indexa por nodo simbólico (no por chunks de texto), así que el retorno marginal es bajo
  aquí; relevante solo si se añade un canal de recuperación por chunks.

---

## Cómo componen (mapa de una frase)

```
        LADO QUERY                         LADO DOC
   (lenguaje de issue →              (lenguaje de código →
    lenguaje de código)               lenguaje de issue)
        C1 HyDE  ───────────  cierran la brecha  ───────────  C2 Proposiciones
                                de vocabulario

        LADO GRAFO (propaga la señal a K hops)
   Mejora B (sesgo dimensional del pool ANN, 1 llamada)
        └─ C3 PPR (centralidad multi-hop, refuerza consenso)
        └─ C4 expansión agéntica por dimensión (research)
```

El **consenso** (`consensus-strategy.ts`) sigue siendo el ranker final; B/C1/C2/C3 mejoran *qué entra
al pool* y *qué señales alimentan el RRF*, no reemplazan el voto estructural. Ver
`docs/posicionamiento-novedad.md` para por qué el consenso es la contribución defendible y qué
baselines aíslan su delta.
