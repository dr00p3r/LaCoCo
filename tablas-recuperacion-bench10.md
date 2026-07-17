# Recuperación — experimento final bench10 (Tablas 19 y 20)

> Experimento de recuperación a escala sobre el benchmark de 10 repositorios. Dos variantes de
> consulta (texto directo vs. SLM intermediario), ocho estrategias. Embeddings
> `jina-embeddings-v2-base-code` (768 dim). IC 95 % por bootstrap (1000 iteraciones, semilla 42);
> latencia en percentil 95; agregación macro por tarea.

---

## Redacción

Habiendo comprobado el efecto del MCP sobre la eficiencia, se configuró el experimento de
recuperación final sobre el conjunto multi-salto de mayor escala, tomado del benchmark de 10
repositorios (SWE-PolyBench y Multi-SWE-bench). Tras aplicar el *gate* de validez (gold-en-grafo),
quedaron **47 tareas válidas** de 56 evaluadas, distribuidas en **7 repositorios**: github-readme-stats
(14), svelte (12), material-ui (8), serverless (5), prettier (4), axios (2) y dayjs (2). La
recuperación se ejecutó con embeddings *code-aware* **jina-embeddings-v2-base-code** (768 dimensiones),
comparando las **ocho estrategias** implementadas (hybrid, connector, consensus, clcr, ictd, repograph,
ppr y rpr) en dos variantes de consulta: **(1) texto directo** del *issue* y **(2) texto intermediado
por el SLM**. Las métricas se agregan de forma macro por tarea, con intervalos de confianza al 95 %
por *bootstrap* (1000 iteraciones, semilla 42) y latencia en percentil 95. Los resultados se muestran
en las Tablas 19 (sin SLM) y 20 (con SLM).

---

## Tabla 19

*Resultados de recuperación — experimento final bench10, consulta con texto directo (sin SLM
intermediario). Ocho estrategias sobre 47 tareas válidas (10 repositorios del benchmark; 7 con tareas
válidas). Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42); latencia en percentil 95.*

| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |
| --- | --- | --- | --- | --- |
| HYBRID | Acierto de Sitio de Edición | 0,7447 | 0,6170 | 0,8723 |
|  | Rango Recíproco Medio | 0,5686 | 0,4503 | 0,6932 |
|  | Cobertura de Contexto Útil | 0,1301 | 0,0948 | 0,1668 |
|  | Tasa de Ruido Externo | 0,0357 | 0,0161 | 0,0608 |
|  | Latencia (ms) | 2.445 | 2.433 | 2.456 |
| CONNECTOR | Acierto de Sitio de Edición | 0,7660 | 0,6596 | 0,8723 |
|  | Rango Recíproco Medio | 0,5710 | 0,4529 | 0,6931 |
|  | Cobertura de Contexto Útil | 0,1337 | 0,0977 | 0,1717 |
|  | Tasa de Ruido Externo | 0,0554 | 0,0303 | 0,0853 |
|  | Latencia (ms) | 2.458 | 2.448 | 2.468 |
| CONSENSUS | Acierto de Sitio de Edición | 0,7447 | 0,6170 | 0,8723 |
|  | Rango Recíproco Medio | 0,5685 | 0,4472 | 0,6905 |
|  | Cobertura de Contexto Útil | 0,1381 | 0,1007 | 0,1771 |
|  | Tasa de Ruido Externo | 0,0576 | 0,0321 | 0,0884 |
|  | Latencia (ms) | 2.442 | 2.432 | 2.452 |
| CLCR | Acierto de Sitio de Edición | 0,8298 | 0,7234 | 0,9362 |
|  | Rango Recíproco Medio | 0,5233 | 0,4055 | 0,6335 |
|  | Cobertura de Contexto Útil | 0,1148 | 0,0827 | 0,1476 |
|  | Tasa de Ruido Externo | 0,0821 | 0,0464 | 0,1232 |
|  | Latencia (ms) | 2.455 | 2.444 | 2.466 |
| ICTD | Acierto de Sitio de Edición | 0,7660 | 0,6383 | 0,8936 |
|  | Rango Recíproco Medio | 0,3818 | 0,2817 | 0,4884 |
|  | Cobertura de Contexto Útil | 0,1185 | 0,0841 | 0,1552 |
|  | Tasa de Ruido Externo | 0,0326 | 0,0094 | 0,0607 |
|  | Latencia (ms) | 2.454 | 2.444 | 2.465 |
| REPOGRAPH | Acierto de Sitio de Edición | 0,7447 | 0,6170 | 0,8723 |
|  | Rango Recíproco Medio | 0,5711 | 0,4532 | 0,6932 |
|  | Cobertura de Contexto Útil | 0,1354 | 0,0979 | 0,1785 |
|  | Tasa de Ruido Externo | 0,0377 | 0,0163 | 0,0629 |
|  | Latencia (ms) | 2.442 | 2.432 | 2.451 |
| PPR | Acierto de Sitio de Edición | 0,7447 | 0,6170 | 0,8723 |
|  | Rango Recíproco Medio | 0,3634 | 0,2621 | 0,4706 |
|  | Cobertura de Contexto Útil | 0,0929 | 0,0616 | 0,1284 |
|  | Tasa de Ruido Externo | 0,1482 | 0,1054 | 0,1946 |
|  | Latencia (ms) | 2.445 | 2.435 | 2.455 |
| RPR | Acierto de Sitio de Edición | 0,3830 | 0,2553 | 0,5319 |
|  | Rango Recíproco Medio | 0,1710 | 0,0949 | 0,2664 |
|  | Cobertura de Contexto Útil | 0,0115 | 0,0018 | 0,0239 |
|  | Tasa de Ruido Externo | 0,4652 | 0,3788 | 0,5514 |
|  | Latencia (ms) | 2.459 | 2.448 | 2.468 |

*Nota.* Valores promedio (agregación macro por tarea) sobre 47 tareas válidas, con consulta directa
(texto del issue). Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42); latencia P95.
Elaboración propia.

---

## Tabla 20

*Resultados de recuperación — experimento final bench10, consulta intermediada por el SLM. Ocho
estrategias sobre 40 tareas válidas (7 excluidas adicionales respecto de la Tabla 19 por fallo de
intermediación del SLM). Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42); latencia
en percentil 95, incluye la inferencia del SLM.*

| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |
| --- | --- | --- | --- | --- |
| HYBRID | Acierto de Sitio de Edición | 0,7000 | 0,5750 | 0,8250 |
|  | Rango Recíproco Medio | 0,5411 | 0,4135 | 0,6820 |
|  | Cobertura de Contexto Útil | 0,1532 | 0,1067 | 0,2020 |
|  | Tasa de Ruido Externo | 0,0367 | 0,0102 | 0,0694 |
|  | Latencia (ms) | 5.053 | 4.546 | 5.624 |
| CONNECTOR | Acierto de Sitio de Edición | 0,7500 | 0,6250 | 0,8750 |
|  | Rango Recíproco Medio | 0,5403 | 0,4149 | 0,6774 |
|  | Cobertura de Contexto Útil | 0,1567 | 0,1114 | 0,2045 |
|  | Tasa de Ruido Externo | 0,0673 | 0,0428 | 0,1000 |
|  | Latencia (ms) | 5.071 | 4.565 | 5.640 |
| CONSENSUS | Acierto de Sitio de Edición | 0,7250 | 0,5750 | 0,8500 |
|  | Rango Recíproco Medio | 0,5383 | 0,4121 | 0,6758 |
|  | Cobertura de Contexto Útil | 0,1532 | 0,1073 | 0,2043 |
|  | Tasa de Ruido Externo | 0,0531 | 0,0245 | 0,0878 |
|  | Latencia (ms) | 5.057 | 4.557 | 5.623 |
| CLCR | Acierto de Sitio de Edición | 0,7500 | 0,6250 | 0,8750 |
|  | Rango Recíproco Medio | 0,4726 | 0,3580 | 0,6033 |
|  | Cobertura de Contexto Útil | 0,1346 | 0,0893 | 0,1832 |
|  | Tasa de Ruido Externo | 0,0612 | 0,0286 | 0,0980 |
|  | Latencia (ms) | 5.062 | 4.562 | 5.632 |
| ICTD | Acierto de Sitio de Edición | 0,6750 | 0,5500 | 0,8250 |
|  | Rango Recíproco Medio | 0,3380 | 0,2388 | 0,4485 |
|  | Cobertura de Contexto Útil | 0,1332 | 0,0859 | 0,1839 |
|  | Tasa de Ruido Externo | 0,0388 | 0,0163 | 0,0673 |
|  | Latencia (ms) | 5.055 | 4.550 | 5.625 |
| REPOGRAPH | Acierto de Sitio de Edición | 0,7250 | 0,6000 | 0,8500 |
|  | Rango Recíproco Medio | 0,5382 | 0,4104 | 0,6759 |
|  | Cobertura de Contexto Útil | 0,1567 | 0,1114 | 0,2045 |
|  | Tasa de Ruido Externo | 0,0451 | 0,0184 | 0,0798 |
|  | Latencia (ms) | 5.056 | 4.555 | 5.624 |
| PPR | Acierto de Sitio de Edición | 0,6500 | 0,5000 | 0,8000 |
|  | Rango Recíproco Medio | 0,4243 | 0,3125 | 0,5417 |
|  | Cobertura de Contexto Útil | 0,0994 | 0,0607 | 0,1408 |
|  | Tasa de Ruido Externo | 0,1337 | 0,0939 | 0,1786 |
|  | Latencia (ms) | 5.062 | 4.558 | 5.635 |
| RPR | Acierto de Sitio de Edición | 0,3250 | 0,2000 | 0,4750 |
|  | Rango Recíproco Medio | 0,1660 | 0,0762 | 0,2616 |
|  | Cobertura de Contexto Útil | 0,0144 | 0,0021 | 0,0298 |
|  | Tasa de Ruido Externo | 0,4464 | 0,3453 | 0,5487 |
|  | Latencia (ms) | 5.065 | 4.565 | 5.630 |

*Nota.* Valores promedio sobre 40 tareas válidas (7 excluidas adicionales respecto de la Tabla 19 por
fallo de intermediación del SLM), con la consulta reformulada por el SLM. Mínimo/Máximo = IC 95 %
bootstrap (1000 iteraciones, semilla 42); latencia P95, incluye la inferencia del SLM. Elaboración
propia.

---

## Lectura / análisis

**Sin SLM (Tabla 19).** A esta escala **CLCR lidera** el Acierto de Sitio de Edición (0,830);
connector (0,766) e ictd (0,766) le siguen, por encima de hybrid, consensus, repograph y ppr (0,745).
En Rango Recíproco Medio, connector, repograph e hybrid empatan en la cima (~0,571), mientras que
CLCR queda algo por debajo (0,523) pese a su mayor acierto. Las líneas base publicadas confirman su
límite: **RepoGraph reproduce a Hybrid** (misma señal estructural agnóstica a la intención) y **PPR**
iguala el acierto (0,745) pero su ranking se hunde (MRR 0,363) y su ruido se dispara (0,148) por medir
centralidad sin condicionar por la intención. **RPR** es la peor (acierto 0,383, ruido 0,465). El
conjunto sostiene que las estrategias de LaCoCo con conectividad tipada (connector/consensus, junto a
CLCR) dominan la localización del sitio de edición, sin regresión frente a las líneas base.

**Con SLM (Tabla 20).** Reintroducir el SLM como intermediario **degrada** el acierto en las
estrategias líderes (CLCR 0,830→0,750; Hybrid 0,745→0,700) y **duplica la latencia** (~2,4 s → ~5,1 s
por la inferencia del modelo), aunque incrementa levemente la Cobertura de Contexto Útil. Connector se
sostiene mejor que el resto (0,766→0,750). El resultado replica a escala el hallazgo previo: con
embeddings *code-aware*, el **texto directo supera al SLM**, porque la reformulación en lenguaje
natural aleja la consulta del vocabulario real del código que el modelo de embeddings ya representa.

---

### Procedencia (no incluir en el documento)

Fuente: `eval/runs/2026-07-11-bench10-mh/retrieval-metrics.deterministic.json` (Tabla 19) y
`retrieval-metrics.baseline.json` (Tabla 20). Validez (gate gold-en-grafo): 47 válidas / 8
inválidas por anclaje / 1 inválida por índice, de 56 instancias. El brazo SLM incluye 40 tareas
(7 exclusiones adicionales por fallo de intermediación). Embeddings jina-embeddings-v2-base-code.
