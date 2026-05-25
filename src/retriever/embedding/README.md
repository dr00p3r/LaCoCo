<h1 style="color:#F1F1F1"> Propósito </h1>

Embedding Generator tiene como objetivo generar embeddings con el modelo all-MiniLM-L6-v2.

<h1 style="color:#F1F1F1"> Parámetros Quemados </h1>

## Modelo
- **Modelo (*string*)**: El modelo utilizado. `Valor Actual: "all-MiniLM-L6-v2"`
- **Uso de quantized (*bool*)**: Define si comprimir un modelo o no. Depende de la gama de GPU de la máquina host. `Valor Actual: true`

## Generador

- **Dimensión (*int*)**: La cantidad de las dimensiones de los vectores. `Valor Actual: "384"`

## Método de Generación

- **Método de agrupación de vectores (*string*)**: El método aplicado para agrupar los vectores generados en uno solo para el respectivo almacenamiento en LanceDB. `Valor Actual: "mean"`.
- **Uso de normalización (*bool*)**: Define si implementar o no normalización, ya que, después de hacer el promediado, el vector resultante tendrá una cierta longitud, sin embargo, el significado del texto está dado por la dirección a la que apunta el vector, no por lo largo que sea. Además, para buscar textos similares en una base de datos, la métrica más utilizada es la Similitud del Coseno (Cosine Similarity), que compara el ángulo entre dos vectores. Por tanto, al habilitar esta opción el cálculo de la Similitud del Coseno se simplifica enormemente. En lugar de hacer operaciones trigonométricas complejas, el motor de base de datos solo necesita hacer un simple Producto Punto (Dot Product) entre los dos vectores para saber qué tan similares son. `Valor Actual: true`

<h1 style="color:#F1F1F1"> Funciones </h1>

## Generar Vectores
Esta función recibe un texto y lo vectoriza correspondientemente. 

## Generar en Batch
Esta función recibe un arreglo de textos y los vectoriza en lotes, básicamente trabajo en paralelo.