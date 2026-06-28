---
lacoco_export_version: 1
context_id: "b79ed9fda285e438"
question: "modify the recovery chunks of the strategies based on hybrid to be only 20"
generated_at: "2026-06-27T23:16:30.360Z"
strategy: "agentic"
route: "RAG"
intent: "refactor"
confidence: 1
dimensions: ["CPG"]
chunks: 5
---
# LaCoCo Context Export

## Question

modify the recovery chunks of the strategies based on hybrid to be only 20

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | `b79ed9fda285e438` |
| Generated at | 2026-06-27T23:16:30.360Z |
| Strategy | `agentic` |
| Route | `RAG` |
| Intent | `refactor` |
| Confidence | `1.00` |
| Dimensions | `CPG` |
| SQLite | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/tensor.sqlite` |
| LanceDB | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/lancedb` |

## Clean Query

```text
'modify' OR 'recovery' OR 'chunks' OR 'strategies' OR 'hybrid'
```

## Embedding Input

```text
Modificar los bloques de recuperación para que sean solo 20
```

## Enriched Prompt

```text
### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales, y sobre todo, como ubicación de archivos. 
No inventes símbolos que no aparezcan aquí.

[1] AGENTIC | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid
hybrid: { ... }

---

[2] AGENTIC | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridConfig
export interface HybridConfig {}

---

[3] AGENTIC | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy
export class HybridStrategy extends AbstractAnchoredStrategy

---

[4] AGENTIC | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy::config
private readonly config: HybridConfig;

---

[5] AGENTIC | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid.create
const create = ({ db, lanceDb }) =>

### Fin del Contexto

modify the recovery chunks of the strategies based on hybrid to be only 20
```

## Retrieved Chunks

### 1. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid

- Source: `AGENTIC`
- Score: `1.0000`

```text
hybrid: { ... }
```

### 2. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridConfig

- Source: `AGENTIC`
- Score: `0.8000`

```text
export interface HybridConfig {}
```

### 3. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy

- Source: `AGENTIC`
- Score: `0.6000`

```text
export class HybridStrategy extends AbstractAnchoredStrategy
```

### 4. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy::config

- Source: `AGENTIC`
- Score: `0.4000`

```text
private readonly config: HybridConfig;
```

### 5. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid.create

- Source: `AGENTIC`
- Score: `0.2000`

```text
const create = ({ db, lanceDb }) =>
```
