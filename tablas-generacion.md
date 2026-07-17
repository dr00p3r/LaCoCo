# Resultados de generación — tablas y redacciones

> Núcleo citable de la sección de generación del documento. Todas las cifras provienen de
> corridas con graduación verificada (los brazos deepseek fueron re-graduados para corregir
> celdas `test_exit_code=null` de mui/prettier). Pass@1 cuenta el *timeout* como fallo
> (denominador = tareas intentadas). Intervalos Mínimo/Máximo = IC 95 % por bootstrap
> (1000 iteraciones, semilla 42).

---

## Descripción del experimento

La evaluación de generación abarca tres generadores — **deepseek-v4-pro** (sobre opencode, cloud)
y **Claude Code** con **Sonnet** y **Haiku** — que cubren un rango de capacidad. El experimento
cruza tres factores:

- **Modelo/agente generador.** deepseek-v4-pro, Sonnet y Haiku.
- **Vía de entrega del contexto.** Tres condiciones: (1) **sin contexto** — el agente resuelve
  solo; (2) **directo** — el contexto recuperado se **inyecta** en el prompt antes de invocar al
  agente; (3) **MCP** — el contexto se ofrece **bajo demanda** mediante la herramienta
  `lacoco_retrieve`, que el agente decide invocar o no. En la condición MCP se compara además la
  **fuerza del hint** (suave = sugerencia; fuerte = protocolo obligatorio de localizar antes de editar).
- **Estrategia de recuperación** ("la herramienta"): `hybrid` (servida por el MCP), además de la
  línea `sin contexto`.

**Corpus.** gen13: 12 tareas efectivas (5 svelte, 4 prettier, 3 mui). Cada celda fija el
repositorio al *commit* del *issue*, aplica el parche de rotura y evalúa la corrección funcional
con el `test_patch` del *benchmark*.

**Métricas (M6–M11).** Pass@1 (M6), Coste USD *list-price* por tarea (M8), Tiempo por tarea (M7),
ToolCalls (M9), N_Read (M10) y Adopción MCP (M11, fracción de celdas donde el agente invoca la
herramienta). Diseño pareado por tarea dentro de cada escenario.

---

## Tabla 15

*Resultados de generación — escenario deepseek-v4-pro · directo. Sin contexto vs. con contexto
inyectado (hybrid), corrida pareada única. Pass@1 sobre las 12 tareas intentadas (timeout = fallo).
Coste en USD list-price por tarea; N_Read = lecturas de archivo. Mínimo/Máximo = IC 95 % bootstrap
(1000 iteraciones, semilla 42).*

| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |
| --- | --- | --- | --- | --- |
| Sin contexto | Pass@1 | 0,5833 | 0,3333 | 0,8333 |
|  | Coste (USD) | 0,095 | 0,065 | 0,131 |
|  | Tiempo (s) | 247 | 155 | 359 |
|  | ToolCalls | 24,5 | 19,3 | 30,4 |
|  | N_Read | 8,8 | 5,7 | 12,9 |
| Con contexto (hybrid) | Pass@1 | 0,5833 | 0,3333 | 0,8333 |
|  | Coste (USD) | 0,103 | 0,072 | 0,137 |
|  | Tiempo (s) | 364 | 226 | 498 |
|  | ToolCalls | 28,6 | 19,4 | 37,7 |
|  | N_Read | 8,8 | 5,4 | 12,9 |

*Nota.* Valores promedio sobre 12 tareas del corpus gen13, con el generador deepseek-v4-pro y el
contexto inyectado directamente en el prompt. Elaboración propia.

**Lectura.** Inyectar contexto **no mueve el Pass@1** (7/12 en ambas variantes) y añade latencia
(364 vs. 247 s) por más *timeouts*. En un modelo capaz, el contexto genérico no eleva el acierto.

---

## Tabla 16

*Resultados de generación — escenario Sonnet · MCP. Comparación por fuerza del hint (sin contexto /
suave / fuerte); estrategia servida = hybrid; corpus gen13 (12 tareas). Pass@1 sobre las 12 tareas
intentadas (timeout = fallo). Adopción MCP = fracción de celdas donde el agente invocó la
herramienta. Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42).*

| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |
| --- | --- | --- | --- | --- |
| Sin contexto | Pass@1 | 0,6667 | 0,4167 | 0,9167 |
|  | Coste (USD) | 0,953 | 0,762 | 1,178 |
|  | Tiempo (s) | 241 | 172 | 326 |
|  | ToolCalls | 39,8 | 31,3 | 49,5 |
|  | N_Read | 5,6 | 3,8 | 7,8 |
|  | Adopción MCP | 0,0000 | 0,0000 | 0,0000 |
| MCP suave | Pass@1 | 0,6667 | 0,4167 | 0,9167 |
|  | Coste (USD) | 0,860 | 0,628 | 1,107 |
|  | Tiempo (s) | 207 | 137 | 282 |
|  | ToolCalls | 29,8 | 24,4 | 35,2 |
|  | N_Read | 4,4 | 3,0 | 6,0 |
|  | Adopción MCP | 0,2500 | 0,0000 | 0,5000 |
| MCP fuerte | Pass@1 | 0,6667 | 0,4167 | 0,9167 |
|  | Coste (USD) | 0,837 | 0,647 | 1,079 |
|  | Tiempo (s) | 176 | 122 | 255 |
|  | ToolCalls | 26,9 | 22,1 | 32,9 |
|  | N_Read | 2,7 | 2,1 | 3,3 |
|  | Adopción MCP | 0,6667 | 0,4167 | 0,9167 |

*Nota.* Valores promedio sobre 12 tareas del corpus gen13, con Claude Code · Sonnet y el contexto
servido bajo demanda vía MCP. El coste es API-equivalente (list-price). Elaboración propia.

**Lectura.** Pass@1 **plano en 0,667** en las tres condiciones: el hint no mueve el acierto. Lo que
**sí** cambia es la eficiencia, que escala con la fuerza del hint: ToolCalls 39,8→26,9 (−32 %),
N_Read 5,6→2,7 (−52 %), tiempo 241→176 s (−27 %), con adopción 0→0,25→0,67. En un modelo fuerte,
el MCP compra eficiencia, no aciertos.

---

## Tabla 17

*Resultados de generación — escenario Haiku · MCP. Comparación por fuerza del hint (sin contexto /
suave / fuerte); estrategia servida = hybrid; corpus gen13 (12 tareas). Pass@1 sobre las 12 tareas
intentadas (timeout = fallo). Adopción MCP = fracción de celdas donde el agente invocó la
herramienta. Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42).*

| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |
| --- | --- | --- | --- | --- |
| Sin contexto | Pass@1 | 0,4167 | 0,1667 | 0,6667 |
|  | Coste (USD) | 0,389 | 0,280 | 0,508 |
|  | Tiempo (s) | 425 | 330 | 521 |
|  | ToolCalls | 62,2 | 47,9 | 76,5 |
|  | N_Read | 15,1 | 10,0 | 20,3 |
|  | Adopción MCP | 0,0000 | 0,0000 | 0,0000 |
| MCP suave | Pass@1 | 0,5833 | 0,3333 | 0,8333 |
|  | Coste (USD) | 0,429 | 0,316 | 0,556 |
|  | Tiempo (s) | 370 | 294 | 449 |
|  | ToolCalls | 57,4 | 45,7 | 69,9 |
|  | N_Read | 13,4 | 10,5 | 16,5 |
|  | Adopción MCP | 0,2500 | 0,0000 | 0,5000 |
| MCP fuerte | Pass@1 | 0,5000 | 0,2500 | 0,7500 |
|  | Coste (USD) | 0,371 | 0,207 | 0,573 |
|  | Tiempo (s) | 402 | 296 | 506 |
|  | ToolCalls | 57,0 | 40,0 | 74,2 |
|  | N_Read | 13,9 | 9,4 | 18,8 |
|  | Adopción MCP | 0,7500 | 0,5000 | 0,9167 |

*Nota.* Valores promedio sobre 12 tareas del corpus gen13, con Claude Code · Haiku y el contexto
servido bajo demanda vía MCP. El coste es API-equivalente (list-price). Elaboración propia.

**Lectura.** Aquí el MCP **sí mueve el acierto**: el hint suave sube el Pass@1 de 0,417 a 0,583
(rescata dos *timeouts* dándole al modelo un punto de partida). Pero el hint **fuerte backfirea**
(0,500): el protocolo rígido sobre-restringe al modelo débil y lo gira a *timeout* en tareas que
antes resolvía. El punto dulce es un **empujón, no un mandato**.

---

## Tabla 18

*Resultados de generación — escenario deepseek-v4-pro · MCP. Comparación por fuerza del hint (sin
contexto / suave / fuerte); estrategia servida = hybrid; corpus gen13 (12 tareas). Pass@1 sobre las
12 tareas intentadas (timeout = fallo). Adopción MCP = fracción de celdas donde el agente invocó la
herramienta. Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42).*

| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |
| --- | --- | --- | --- | --- |
| Sin contexto | Pass@1 | 0,5833 | 0,3333 | 0,8333 |
|  | Coste (USD) | 0,095 | 0,065 | 0,131 |
|  | Tiempo (s) | 247 | 155 | 359 |
|  | ToolCalls | 24,5 | 19,3 | 30,4 |
|  | N_Read | 8,8 | 5,7 | 12,9 |
|  | Adopción MCP | 0,0000 | 0,0000 | 0,0000 |
| MCP suave | Pass@1 | 0,5833 | 0,2500 | 0,8333 |
|  | Coste (USD) | 0,080 | 0,066 | 0,098 |
|  | Tiempo (s) | 282 | 199 | 375 |
|  | ToolCalls | 29,3 | 23,0 | 36,2 |
|  | N_Read | 11,2 | 8,7 | 13,8 |
|  | Adopción MCP | 0,6667 | 0,4167 | 0,9167 |
| MCP fuerte | Pass@1 | 0,8333 | 0,5833 | 1,0000 |
|  | Coste (USD) | 0,101 | 0,071 | 0,136 |
|  | Tiempo (s) | 231 | 161 | 307 |
|  | ToolCalls | 35,2 | 27,1 | 43,7 |
|  | N_Read | 11,5 | 7,3 | 16,7 |
|  | Adopción MCP | 1,0000 | 1,0000 | 1,0000 |

*Nota.* Valores promedio sobre 12 tareas del corpus gen13, con el generador deepseek-v4-pro y el
contexto servido bajo demanda vía MCP. A diferencia de los escenarios Sonnet y Haiku (triples
pareados en una sola sesión), los tres brazos provienen de corridas separadas, por lo que existe
un confound de lote; el Pass@1 fue re-graduado para uniformar la evaluación. Elaboración propia.

**Lectura.** La adopción de la herramienta escala con el hint (0 → 0,67 → 1,00): al no inyectar
contexto, el modelo depende de la tool y el hint fuerte logra adopción total. A diferencia de
Claude, en deepseek el MCP **añade** exploración en lugar de reemplazarla (ToolCalls 24,5→35,2,
N_Read 8,8→11,5). El Pass@1 pasa de 0,583 (sin contexto = suave) a 0,833 con el hint fuerte, pero
este ascenso debe leerse con cautela: los intervalos de confianza se solapan (n=12), los tres
brazos son corridas separadas, y parte de la ventaja del hint fuerte se apoya en una tarea con
artefacto de arnés (`prettier-12930`) y en rescates de *timeout* de un lote distinto. Se reporta
como tendencia consistente con el mecanismo, no como resultado concluyente.

---

## Hallazgo central

A través de tres generadores (deepseek-v4-pro, Sonnet y Haiku) y dos vías de entrega (inyección
directa y MCP), el contexto recuperado **no incrementa de forma robusta el Pass@1**: el cuello de
botella se traslada del *localizar* el sitio de edición al *razonar* la corrección. El efecto
medible del contexto es de **eficiencia** —en un modelo capaz (Sonnet) el MCP reduce la exploración
(−32 % ToolCalls, −52 % lecturas) a igual acierto— y de **robustez** —en un modelo débil (Haiku) un
empujón suave rescata tareas que sin contexto terminan en *timeout*—. Además, el **valor del MCP y
la fuerza óptima del hint escalan de forma inversa a la capacidad del modelo**: para el modelo
fuerte el contexto solo aporta eficiencia y el hint rígido es indiferente; para el débil, el empujón
suave ayuda pero el mandato rígido lo perjudica. Este resultado es complementario al de recuperación:
el aporte de las estrategias estructurales (connector/consensus) se demuestra en la localización del
sitio de edición (capítulo de recuperación), mientras que su traducción a la generación se manifiesta
como eficiencia y robustez, no como una mayor tasa de resolución.

---

### Procedencia de los datos (no incluir en el documento)

| Tabla | Corrida(s) | Notas |
| --- | --- | --- |
| 15 | `genAB-v1` (no_context + hybrid) | deepseek-pro directo; 1 corrida pareada, re-graduada |
| 16 | `cc-nc`, `cc-mcp-soft`, `cc-mcp-hard` | triple pareado Sonnet, graduación verificada celda a celda |
| 17 | `cc-haiku-nc`, `cc-haiku-mcp-soft`, `cc-haiku-mcp-hard` | triple pareado Haiku |
| 18 | `genAB-v1` (nc) + `genAB-mcp` (suave) + `genAB-mcp-hint` (fuerte) | deepseek-pro; MCP puro (strategy=no_context); lotes separados, re-graduada |

Todas las corridas usan el **mismo corpus gen13** (3 material-ui + 4 prettier + 5 svelte). Los
brazos MCP de las Tablas 16/17/18 son *MCP puro* (`strategy=no_context` → sin inyección; la tool es
la única fuente y sirve `hybrid`).

Excluidas por confusión (no citar Pass@1): `gen-eff` (deepseek-flash, dominado por *timeouts*) y
`gen-grounded-pro` (spread por artefactos de arnés). Aclaración sobre la comparación **por
estrategia vía MCP** de bench10 (Tabla 14 del documento): las celdas MCP **sí** inyectan el contexto
de su estrategia en el prompt (connector ≠ consensus), pero la *tool* `lacoco_retrieve` sirve
`hybrid` por defecto y su adopción fue ~0 (el modelo no la usa porque el contexto ya está inyectado);
por eso equivale a la comparación *directa* (Tabla 13) con una tool disponible pero ociosa, no a una
demostración de "contexto entregado vía MCP".
