# LaCoCo

LaCoCo es un reforzador contextual local para proyectos TypeScript. Indexa
estructura, relaciones y embeddings del proyecto; luego recupera contexto
relevante para enriquecer prompts consumidos por agentes de codificacion.

## Requisitos

- Node.js 20 o superior.
- pnpm.
- Ollama local para el clasificador SLM, `agentic`, grounding y perfil
  semantico.
- `qwen3:4b-instruct` como modelo local recomendado para `agent.model`.

## Instalacion

```bash
pnpm install
pnpm run build
```

Para desarrollo:

```bash
pnpm run dev -- --help
```

## Uso basico

```bash
pnpm run dev -- init <ruta-proyecto>
pnpm run dev -- index_graph <ruta-proyecto>/tsconfig.json
pnpm run dev -- index_vectors <ruta-proyecto>/tsconfig.json
pnpm run dev -- retrieve <ruta-proyecto> "consulta o tarea" --strategy hybrid --json
```

El binario compilado queda en `dist/cli/index.js` y expone `lacoco` cuando el
paquete se instala como CLI.

## Estrategias

Estrategias CLI vigentes:

- `hybrid`: BM25 + ANN + Reciprocal Rank Fusion.
- `agentic`: semillas BM25 + planificacion local con Ollama.
- `ictd`: difusion tensorial guiada por intent y dimensiones.
- `clcr`: expansion por capas y cascada cross-layer.
- `rpr`: enumeracion y puntuacion de caminos relacionales.
- `consensus`: consenso estructural por vecindad de anclas.
- `repograph`: baseline de ego-graph plano.
- `ppr`: PageRank personalizado sobre subgrafo inducido.
- `connector`: conectores estructurales entre anclas.

`hybrid` es la estrategia predeterminada. Todas las estrategias salvo `agentic`
requieren LanceDB porque usan el anclaje BM25 + ANN.

## Documentacion

- `AGENTS.md`: contrato operativo para agentes que modifican el repositorio.
- `docs/cli.md`: guia de uso del CLI.
- `docs/mcp.md`: servidor MCP de LaCoCo.
- `docs/retrieval-proposals.md`: diseno y estado de estrategias de retrieval.
- `eval/README.md` y `eval/RUNBOOK.md`: pipeline experimental.

## Verificacion

```bash
pnpm run typecheck
pnpm test
pnpm run build
```
