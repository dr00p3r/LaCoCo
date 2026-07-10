# LaCoCo CLI — Guía de uso

LaCoCo es un reforzador contextual local para proyectos TypeScript. Indexa la estructura del proyecto en un grafo (SQLite) y embeddings semanticos (LanceDB), luego recupera contexto relevante para enriquecer prompts de agentes de codificacion.

## Instalacion

```bash
npm install
npm run build
```

El binario `lacoco` queda en `dist/cli/index.js`. Para desarrollo usar `npm run dev -- <comando>`.

## Registro de proyectos

Cada proyecto TypeScript debe registrarse antes de indexar o recuperar. El registro persiste rutas de almacenamiento (SQLite y LanceDB) por proyecto.

```bash
lacoco init [project-path]
lacoco status [project]
lacoco project list
lacoco project inspect <project>
lacoco project remove <project>
```

- `init` registra el proyecto actual (o la ruta dada) y le asigna un ID unico.
- `status` muestra paths de almacenamiento, estado de indexacion y watcher.
- `project inspect` busca por nombre, ID o ruta.

## Indexacion

Dos pasos independientes que crean las bases de datos que consumen las estrategias de retrieval.

### Grafo estructural (SQLite + FTS5)

```bash
lacoco index_graph <ruta-tsconfig-o-proyecto>
```

Extrae el AST con ts-morph y persiste nodos, aristas y metadatos dimensionales (SYS/CPG/DTG) en SQLite. Activa FTS5 para busqueda BM25. Si recibe un directorio, descubre proyectos JavaScript/TypeScript bajo ese arbol (`tsconfig*.json`) e ignora servicios no soportados, por ejemplo Spring Boot.

Opciones:
- `-d, --db <path>` — ruta de salida (defecto: `paths.data/tensor.sqlite` del proyecto)
- `-v, --verbose` — progreso detallado

### Vectores semanticos (LanceDB)

```bash
lacoco index_vectors <ruta-tsconfig-o-proyecto>
```

Genera embeddings con `all-MiniLM-L6-v2` (384 dimensiones) y los persiste en LanceDB con indice HNSW. Igual que `index_graph`, puede recibir un repositorio multi-servicio y procesar todos los `tsconfig*.json` utiles encontrados.

Opciones:
- `--lancedb <path>` — directorio de salida (defecto: `paths.data/lancedb` del proyecto)
- `-v, --verbose` — progreso detallado

Ambos comandos registran automaticamente el proyecto y guardan las rutas de almacenamiento en el registro.

### Project Semantic Profile

```bash
lacoco profile rebuild [project] --json
lacoco profile ground [project] "<consulta>" --json
lacoco profile status [project] --verify --json
```

`profile rebuild` consume el grafo y un inventario acotado del proyecto,
genera alias bilingues y dominios mediante Ollama y promueve el resultado
atomicamente. `profile ground` inspecciona candidatos sin ejecutar el
clasificador ni retrieval. Reindexar el grafo deja el perfil `stale`.

## Retrieval

Recupera contexto relevante del proyecto indexado usando una de seis estrategias
(`hybrid`, `agentic`, `ictd`, `clcr`, `rpr`, `consensus`).

### Pipeline RAG completo

```bash
lacoco retrieve [project] "<consulta>" --strategy hybrid
```

Ejecuta el pipeline de recuperacion: intermediario SLM -> estrategia ->
agregacion -> inyeccion. Devuelve el prompt enriquecido para que lo consuma un
agente externo mediante hooks; no genera una respuesta final.

Opciones:
- `-s, --strategy <name>` — estrategia (defecto: `strategy.default` de config)
- `--chunks <number>` — máximo de chunks producido por la estrategia
- `--max-tokens <number>` — presupuesto del agregador (defecto: 4000)
- `--ollama <url>` — endpoint de Ollama (defecto: `agent.endpoint` de config)
- `--grounding` / `--no-grounding` — activa o desactiva el perfil semantico
- `--json` — devuelve un unico documento JSON estructurado para hooks
- `-v, --verbose` — diagnostico del pipeline en stderr

Para consumir el contexto desde un hook de agente:

```bash
lacoco retrieve extractor "<consulta>" --strategy hybrid --json \
  | jq -r '.enrichedPrompt'
```

El contrato JSON usa `schemaVersion: 2` e incluye clasificacion, grounding, chunks,
parametros efectivos de estrategia, `maxTokens`, almacenamiento y prompt enriquecido. Los diagnosticos se escriben en stderr,
por lo que stdout permanece parseable. En errores retorna `ok: false` y
mantiene un exit code distinto de cero.

### Exportar contexto a Markdown

```bash
lacoco context export [project] "<consulta>" --output contexto.md --strategy hybrid
```

Exporta los chunks recuperados como archivo Markdown con front-matter YAML identificable por pregunta.

Opciones:
- `-o, --output <path>` — archivo de salida (requerido)
- `-s, --strategy <name>` — estrategia
- `--chunks <number>` — máximo de chunks producido por la estrategia
- `--max-tokens <number>` — presupuesto del agregador (defecto: 4000)
- `--ollama <url>` — endpoint de Ollama
- `--grounding` / `--no-grounding` — controla el grounding semantico
- `--json` — imprime metadatos JSON
- `-v, --verbose` — diagnostico

### Inspeccion visual (HTML + Cytoscape)

```bash
lacoco inspect <root-node> --output grafo.html
```

Visualiza el subgrafo alrededor de un nodo usando expansion BFS con presupuesto.

Opciones:
- `-b, --budget <num>` — maximo de nodos (defecto: 75)
- `-f, --focus <dim>` — prioridad dimensional: SYS, CPG, DTG, ALL (defecto: ALL)
- `-o, --output <path>` — archivo HTML (defecto: inspect.html)
- `--cdn` — usar CDN para Cytoscape.js

### Inspeccion desde query (pipeline RAG + grafo)

```bash
lacoco inspect-query [project] "<consulta>" --strategy hybrid --output grafo.html
```

Ejecuta el pipeline RAG completo y visualiza el subgrafo de los chunks recuperados.

Opciones:
- `-b, --budget <num>` — maximo de nodos (defecto: 75)
- `-s, --strategy <name>` — estrategia
- `--chunks <number>` — máximo de chunks producido por la estrategia
- `-m, --mode <mode>` — modo de visualizacion: default, tensor, scores (defecto: default)
- `-o, --output <path>` — archivo HTML (defecto: inspect-query.html)
- `--cdn` — usar CDN para Cytoscape.js
- `--ollama <url>` — endpoint de Ollama
- `--grounding` / `--no-grounding` — controla el grounding semantico

## Estrategias de recuperacion

| Estrategia | Descripcion |
|---|---|
| `hybrid` | BM25 + ANN + Reciprocal Rank Fusion. Default. No usa expansion de grafo. |
| `agentic` | Semillas BM25 + planificacion estructurada local con Ollama (max 3 iteraciones y 2 intentos por decisión). Requiere Ollama y falla explícitamente si no está disponible. |
| `ictd` | Anclas hibridas + difusion tensorial guiada por intent y dimension. |
| `clcr` | Anclas hibridas + recuperacion por etapas entre capas dimensionales. |
| `rpr` | Anclas hibridas + enumeracion y puntuacion de caminos relacionales. |

`--chunks` controla `anchorLimit` en `hybrid` y `chunkLimit` en las demás
estrategias. Es un límite previo al agregador; `--max-tokens` puede reducir aún
más la cantidad finalmente inyectada.

## Watcher

El watcher monitorea cambios en el codigo fuente y reindexa automaticamente.

```bash
lacoco watch start [project]
lacoco watch stop [project]
lacoco watch restart [project]
lacoco watch status [project]
lacoco watch list
```

Opciones:
- `-v, --verbose` — imprime cada archivo procesado
- `--foreground` — ejecuta en primer plano (no detached)
- `--json` — imprime JSON

El watcher requiere que el proyecto tenga un `tsconfig.json` configurado. Si se ejecuta `init` e `index_graph`/`index_vectors` antes, las rutas se resuelven automaticamente.

## Configuracion

```bash
lacoco config list
lacoco config get <key>
lacoco config set <key> <value> --local
lacoco config set <key> <value> --global
lacoco config unset <key>
lacoco config path
lacoco config keys
```

Claves principales:

| Clave | Tipo | Defecto | Descripcion |
|---|---|---|---|
| `strategy.default` | string | `hybrid` | Estrategia de retrieval por defecto |
| `agent.endpoint` | string | `http://localhost:11434` | Endpoint de Ollama |
| `agent.model` | string | `qwen2.5-coder:1.5b` | Modelo de Ollama |
| `paths.data` | string | `.lacoco` | Directorio de datos (relativo al proyecto) |
| `timeout.ms` | number | `30000` | Timeout para Ollama |
| `watcher.debounceMs` | number | `80` | Debounce del watcher |
| `profile.groundingEnabled` | boolean | `false` | Activa grounding por defecto |

Precedencia: variable de entorno > `--local` > `--global` > defecto.

Variables de entorno equivalentes:

```bash
LACOCO_STRATEGY=hybrid
LACOCO_AGENT_ENDPOINT=http://localhost:11434
LACOCO_AGENT_MODEL=qwen2.5-coder:1.5b
LACOCO_PROFILE_GROUNDING=true
```

## Pipeline de consulta

```text
prompt original
  -> QueryGrounder opcional (FTS5 sobre evidencias y alias del proyecto)
  -> AgentIntermediary1 (SLM genera route, clean_query, embedding_input, intent, dimensions)
  -> RecoveryStrategy (recupera contexto)
  -> ContextAggregator (deduplica, ordena, trunca a presupuesto de tokens)
  -> PromptInjector (inyecta contexto en el prompt original)
  -> LLM o agente de codificacion
```

## Almacenamiento

- **SQLite** (`tensor.sqlite`): grafo y perfil semantico en tablas/FTS5 separados. Por defecto en `paths.data/tensor.sqlite`.
- **LanceDB** (`lancedb/`): embeddings vectoriales con indice HNSW. Por defecto en `paths.data/lancedb`.
- **Registro de proyectos**: `$XDG_STATE_HOME/lacoco/projects.json` (Linux: `~/.local/state/lacoco/projects.json`).

Las rutas de almacenamiento se guardan en el registro y se resuelven automaticamente desde el proyecto. No es necesario pasarlas como flags en `retrieve`, `context export` o `inspect-query`.
