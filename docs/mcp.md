# Servidor MCP de LaCoCo

`lacoco mcp [proyecto]` levanta un servidor [MCP](https://modelcontextprotocol.io)
por **stdio** que expone el retrieval como una tool que el agente invoca **bajo
demanda** (a mitad de tarea), en vez del hook one-shot que enriquece el prompt en
`t=0`.

## Por qué MCP (frente al hook / skill sobre CLI)

- **Proceso persistente**: mantiene calientes SQLite, LanceDB, el modelo de
  embeddings y el cliente Ollama a lo largo de toda la sesión. Cada `lacoco
  retrieve` por CLI es un proceso nuevo que paga el cold-start (carga del modelo
  de embeddings + apertura de las DBs); el servidor lo amortiza tras la 1ª llamada.
- **Contrato tipado**: la tool valida sus argumentos con un schema; el modelo
  emite un tool-call nativo en vez de componer JSON dentro de un `printf` shell.
- **Bajo demanda**: el agente consulta cuando descubre qué necesita, no solo antes
  de empezar.

## Requisitos

El proyecto debe estar **indexado** antes de servirlo:

```bash
lacoco index_graph   <ruta-al-tsconfig>   # grafo estructural (SQLite)
lacoco index_vectors <ruta-al-tsconfig>   # embeddings (LanceDB) — necesario para hybrid
```

Y LaCoCo compilado (`pnpm build`); el servidor corre desde `dist/`.

## La tool `lacoco_retrieve`

Entrada:

| Campo | Req. | Descripción |
|---|---|---|
| `query` | sí | El prompt/tarea original, sin modificar. |
| `clean_query` | no | Query FTS5 (símbolos/archivos entre comillas unidos con `OR`). |
| `embedding_input` | no | Descripción en lenguaje natural de la evidencia buscada. |
| `intent` | no | `understand \| refactor \| create \| debug \| integrate \| unknown`. |
| `dimensions` | no | `SYS` (contratos/módulos/deps), `CPG` (clases/llamadas), `DTG` (datos/tipos/estado). |
| `strategy` | no | Estrategia de recuperación (default del servidor). |
| `maxTokens` | no | Presupuesto de tokens del contexto. |

**Clasificación**: si el agente aporta `clean_query` + `embedding_input` +
`intent` + `dimensions`, se validan y se **congelan** — el servidor NO llama al
clasificador SLM (más rápido, sin dependencia de Ollama en esa llamada). Si se
omiten, clasifica el SLM local (requiere Ollama). El campo `classifiedBy` de la
respuesta indica cuál se usó (`agent` | `slm`).

Salida (JSON): `classification`, `classifiedBy` y `chunks[]`, cada uno con
`nodeId`, `symbol`, `filepath`, `startLine`, `endLine`, `truncated`, `score`,
`source` y `text` (el **cuerpo** del símbolo cortado del working tree).

## Registro en agentes

### OpenCode

`opencode.json` en la raíz del proyecto servido (o vía `OPENCODE_CONFIG`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lacoco": {
      "type": "local",
      "enabled": true,
      "command": ["node", "/ruta/abs/LaCoCo/dist/cli/index.js", "mcp", "/ruta/abs/proyecto"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add lacoco -- node /ruta/abs/LaCoCo/dist/cli/index.js mcp /ruta/abs/proyecto
```

> ⚠️ Las claves exactas (`type`, `command`) dependen de la versión de OpenCode/Claude
> Code instalada. Verifica con `npx @modelcontextprotocol/inspector node
> /ruta/abs/LaCoCo/dist/cli/index.js mcp /ruta/abs/proyecto` antes de un run largo.

## Notas de operación

- **stdout** queda reservado al protocolo MCP; todo diagnóstico va a **stderr**.
- Si el proyecto no está indexado, el servidor sale con código 1 y un mensaje claro
  en stderr.
- Ante `SIGINT`/`SIGTERM` cierra la sesión (LanceDB + SQLite) ordenadamente.
