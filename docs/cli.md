# LaCoCo CLI - Guia de uso

LaCoCo es un reforzador contextual local para proyectos JavaScript/TypeScript. Indexa la estructura del proyecto en un grafo SQLite y embeddings semanticos en LanceDB; despues recupera evidencia para que un agente de codificacion la use como contexto.

## Instalacion

```bash
pnpm install
pnpm run build
```

El binario `lacoco` queda en `dist/cli/index.js`. Para desarrollo usa `pnpm run dev -- <comando>`.

## Registro de proyectos

Cada proyecto debe registrarse antes de indexar o recuperar. El registro persiste rutas de almacenamiento por proyecto.

```bash
lacoco init [project-path]
lacoco status [project]
lacoco project list
lacoco project inspect <project>
lacoco project remove <project>
```

- `init` registra el proyecto actual o la ruta dada y le asigna un ID unico.
- `status` muestra paths de almacenamiento, estado de indexacion y watcher.
- `project inspect` busca por nombre, ID o ruta.

## Indexacion

Dos pasos independientes crean las bases que consumen las estrategias de retrieval.

### Grafo estructural

```bash
lacoco index_graph <ruta-tsconfig-o-proyecto>
```

Extrae AST con ts-morph y persiste nodos, aristas y metadatos dimensionales (`SYS`, `CPG`, `DTG`) en SQLite con FTS5. Si recibe un directorio, descubre proyectos JavaScript/TypeScript bajo ese arbol (`tsconfig*.json`) e ignora servicios no soportados, por ejemplo Spring Boot.

Opciones:

- `-d, --db <path>` - ruta de salida. Defecto: `paths.data/tensor.sqlite`.
- `-v, --verbose` - progreso detallado.

### Vectores semanticos

```bash
lacoco index_vectors <ruta-tsconfig-o-proyecto>
```

Genera embeddings con `all-MiniLM-L6-v2` y los persiste en LanceDB con indice HNSW. Igual que `index_graph`, puede procesar repositorios multi-servicio descubriendo todos los `tsconfig*.json` utiles.

Opciones:

- `--lancedb <path>` - directorio de salida. Defecto: `paths.data/lancedb`.
- `-v, --verbose` - progreso detallado.

Ambos comandos registran automaticamente el proyecto y guardan las rutas de almacenamiento.

## Skill del proyecto

```bash
lacoco skill update [project] --json
lacoco skill update [project] --install codex,claude,opencode --json
lacoco skill install [project] --agent all --json
```

`skill update` genera `.lacoco/skill.md` desde el grafo indexado. Ese archivo es el snapshot canonico de LaCoCo para el proyecto.

`skill install` genera o refresca el snapshot canonico y luego instala un paquete `SKILL.md` en los agentes destino para que puedan descubrir LaCoCo automaticamente:

- `codex`: `${CODEX_HOME:-~/.codex}/skills/lacoco-<project>/SKILL.md`
- `claude`: `${CLAUDE_HOME:-~/.claude}/skills/lacoco-<project>/SKILL.md`
- `opencode`: `${XDG_CONFIG_HOME:-~/.config}/opencode/skills/lacoco-<project>/SKILL.md` y registra la ruta en `opencode.jsonc` bajo `skills.paths`

Variables de prueba/override:

- `LACOCO_CODEX_SKILLS_DIR`
- `LACOCO_CLAUDE_SKILLS_DIR`
- `LACOCO_OPENCODE_CONFIG_DIR`
- `LACOCO_OPENCODE_SKILLS_DIR`
- `LACOCO_OPENCODE_CONFIG_PATH`

La skill instalada instruye al agente a ejecutar retrieval antes de responder o editar cuando la tarea dependa del codigo del repositorio. El agente construye `clean_query`, `embedding_input`, `intent` y `dimensions`, llama a `lacoco retrieve` por stdin, usa `contextBlock` como evidencia, y despues toma accion.

El watcher actualiza grafo y vectores, pero no reinstala skills automaticamente. Si cambia la arquitectura, ejecuta `skill update --install <agents>` despues de reindexar.

## Retrieval

LaCoCo ya no limpia ni clasifica el prompt con un intermediario interno antes de recuperar contexto. El agente externo hace esa tarea usando la skill del proyecto y envia una consulta estructurada.

```bash
printf '%s' '<json>' | lacoco retrieve [project] --strategy hybrid --json
```

Entrada por stdin:

```json
{
  "schemaVersion": 1,
  "originalPrompt": "Prompt original del usuario, sin modificar",
  "clean_query": "\"OrderService\" OR \"sales container\"",
  "embedding_input": "Modificar el contenedor que coordina la logica de venta de productos",
  "intent": "refactor",
  "dimensions": ["CPG", "DTG"],
  "confidence": 0.9,
  "strategy": "hybrid",
  "chunks": 20,
  "maxTokens": 4000
}
```

Campos principales:

- `clean_query` - consulta FTS5 orientada a simbolos, archivos o terminos del dominio.
- `embedding_input` - descripcion semantica breve para busqueda vectorial.
- `intent` - `understand`, `refactor`, `create`, `debug`, `integrate` o `unknown`.
- `dimensions` - una o mas de `SYS`, `CPG`, `DTG`.
- `strategy`, `chunks` y `maxTokens` son opcionales; los flags CLI tienen prioridad.

Opciones:

- `-s, --strategy <name>` - estrategia. Defecto: `strategy.default`.
- `--chunks <number>` - maximo de chunks producido por la estrategia.
- `--max-tokens <number>` - presupuesto del agregador. Defecto: 4000.
- `--json` - devuelve un unico documento JSON parseable.
- `-v, --verbose` - diagnostico del pipeline en stderr.

El contrato JSON de salida usa `schemaVersion: 3` e incluye `classification`, `chunks`, parametros efectivos, almacenamiento y `contextBlock`. LaCoCo no genera una respuesta final: el agente debe usar `contextBlock` como evidencia junto al prompt original.

## Exportar contexto

```bash
printf '%s' '<json>' | lacoco context export [project] --output contexto.md --strategy hybrid
```

Usa el mismo JSON por stdin que `retrieve` y exporta los chunks recuperados como Markdown.

Opciones:

- `-o, --output <path>` - archivo de salida requerido.
- `-s, --strategy <name>` - estrategia.
- `--chunks <number>` - maximo de chunks producido por la estrategia.
- `--max-tokens <number>` - presupuesto del agregador.
- `--json` - imprime metadatos JSON.
- `-v, --verbose` - diagnostico.

## Inspeccion visual

```bash
lacoco inspect <root-node> --output grafo.html
```

Visualiza el subgrafo alrededor de un nodo usando expansion BFS con presupuesto.

Opciones:

- `-b, --budget <num>` - maximo de nodos. Defecto: 75.
- `-f, --focus <dim>` - prioridad dimensional: `SYS`, `CPG`, `DTG`, `ALL`. Defecto: `ALL`.
- `-o, --output <path>` - archivo HTML. Defecto: `inspect.html`.
- `--cdn` - usar CDN para Cytoscape.js.

### Inspeccion desde query

```bash
printf '%s' '<json>' | lacoco inspect-query [project] --strategy hybrid --output grafo.html
```

Recupera contexto con la consulta estructurada por stdin y visualiza el subgrafo de los chunks recuperados.

Opciones:

- `-b, --budget <num>` - maximo de nodos. Defecto: 75.
- `-s, --strategy <name>` - estrategia.
- `--chunks <number>` - maximo de chunks producido por la estrategia.
- `-m, --mode <mode>` - `default`, `tensor` o `scores`. Defecto: `default`.
- `-o, --output <path>` - archivo HTML. Defecto: `inspect-query.html`.
- `--cdn` - usar CDN para Cytoscape.js.

## Estrategias de recuperacion

| Estrategia | Descripcion |
|---|---|
| `hybrid` | BM25 + ANN + Reciprocal Rank Fusion. Default. |
| `agentic` | Semillas BM25 + planificacion local con Ollama. Requiere Ollama. |
| `ictd` | Anclas hibridas + difusion tensorial guiada por intent y dimension. |
| `clcr` | Anclas hibridas + recuperacion por etapas entre capas dimensionales. |
| `rpr` | Anclas hibridas + enumeracion y puntuacion de caminos relacionales. |
| `consensus` | Combina estrategias para tareas donde el codigo relevante puede estar lexica y estructuralmente disperso. |

`--chunks` controla `anchorLimit` en `hybrid` y `chunkLimit` en las demas estrategias. Es un limite previo al agregador; `--max-tokens` puede reducir aun mas la cantidad finalmente entregada.

## Watcher

```bash
lacoco watch start [project]
lacoco watch stop [project]
lacoco watch restart [project]
lacoco watch status [project]
lacoco watch list
```

El watcher monitorea cambios TypeScript/JavaScript y actualiza grafo y vectores. No actualiza `.lacoco/skill.md` ni las skills instaladas; usa `lacoco skill update --install <agents>` cuando quieras refrescarlas.

Opciones:

- `-v, --verbose` - imprime cada archivo procesado.
- `--foreground` - ejecuta en primer plano.
- `--json` - imprime JSON.

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
| `agent.endpoint` | string | `http://localhost:11434` | Endpoint de Ollama para `agentic` |
| `agent.model` | string | `qwen3:4b-instruct` | Modelo de Ollama para `agentic` |
| `retrieval.annOverfetch` | number | `1` | Factor de overfetch ANN |
| `retrieval.annDimSource` | string | `kind` | Fuente de dimension para ANN |
| `paths.data` | string | `.lacoco` | Directorio de datos relativo al proyecto |
| `paths.logs` | string | `.lacoco/logs` | Directorio de logs |
| `paths.state` | string | `.lacoco/state` | Directorio de estado |
| `timeout.ms` | number | `30000` | Timeout para Ollama |
| `watcher.debounceMs` | number | `80` | Debounce del watcher |

Precedencia: variable de entorno > `--local` > `--global` > defecto.

Variables de entorno equivalentes:

```bash
LACOCO_STRATEGY=hybrid
LACOCO_AGENT_ENDPOINT=http://localhost:11434
LACOCO_AGENT_MODEL=qwen3:4b-instruct
LACOCO_ANN_OVERFETCH=2
LACOCO_DATA_DIR=.lacoco
```

## Pipeline de consulta

```text
prompt original del usuario
  -> skill instalada en el agente
  -> JSON estructurado por stdin
  -> RecoveryStrategy
  -> ContextAggregator
  -> contextBlock JSON
  -> agente externo usa el contexto para responder o editar
```

## Almacenamiento

- **SQLite** (`tensor.sqlite`): grafo, metadata y FTS5. Defecto: `paths.data/tensor.sqlite`.
- **LanceDB** (`lancedb/`): embeddings vectoriales con indice HNSW. Defecto: `paths.data/lancedb`.
- **Skill** (`skill.md`): instrucciones Markdown generadas desde el grafo. Defecto: `paths.data/skill.md`.
- **Registro de proyectos**: `$XDG_STATE_HOME/lacoco/projects.json` (Linux: `~/.local/state/lacoco/projects.json`).

Las rutas se guardan en el registro y se resuelven automaticamente desde el proyecto. No es necesario pasarlas como flags en `retrieve`, `context export` o `inspect-query`.
