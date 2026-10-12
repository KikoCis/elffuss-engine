# Las capas no cuestan lo mismo, y la causa es UN tensor

`tests/prefillpases.browser.mjs` deja un aserto en rojo: **36% de dispersión
entre las 48 capas SSM**, que el propio banco daba por «idénticas en forma».

**La premisa era falsa.** Leyendo el índice del GGUF (tipo Y forma de cada
tensor, no solo el tipo) salen **5 firmas distintas entre las 65 capas**:

| familia | capas | variantes |
|---|---|---|
| SSM | 48 | **2** (un tramo corto al principio, el resto) |
| atención | 16 | **2** (el mismo corte) |
| cabeza MTP | 1 | 1 (no se ejecuta) |

Qué índice de capa cae en qué variante es parte de cómo se empaqueta un modelo
concreto, y no hace falta para lo que cuenta este documento: el efecto depende de
que HAYA dos variantes en el tensor dominante, no de cuáles sean ni de dónde esté
el corte.

Las dos familias se parten **por el mismo sitio**, y en el mismo punto, y la
diferencia es **un solo tensor**: el `ffn_down.weight` de cada bloque, que en un
tramo de capas viene con una cuantización y en el resto con otra.

Qué cuantización le toca a qué tramo es parte de cómo se empaqueta un modelo
concreto, y eso no se publica: no hace falta para entender el efecto, que es lo
que cuenta este documento. El efecto depende solo de que haya **dos formatos
distintos en el tensor dominante**, no de cuáles sean.

Todo lo demás —tipo y forma— es idéntico entre las dos variantes.

## Por qué importa

Ese tensor no es uno cualquiera: es la etiqueta `r17408b20` del perfil, **la
matmul más cara del modelo, el 40,7% del prefill**. O sea que la operación
dominante se ejecuta con **dos cuantizaciones distintas según el índice de
capa**, y eso basta para explicar que las capas «idénticas» no cuesten igual.

Es la política de cuantización mixta de siempre —las primeras capas con más
precisión— pero aquí tiene consecuencia de rendimiento, no solo de calidad:
Q2_K es aritmética de bits pura y IQ1_S lleva una tabla de códigos con un
gather por peso.

## MEDIDO: la variante «mejor» es la más LENTA

Agrupando por variante dentro de la misma sesión (entre sesiones los absolutos
varían ×1,45 y no se comparan):

| variante de `ffn_down` | coste por capa | dispersión dentro del grupo |
|---|---|---|
| la de más precisión | **×1,28** | 8% |
| la de menos | ×1,00 (referencia) | 13% |

**La variante de más precisión cuesta un 28% MÁS.** Y agrupar así convierte el
36% de dispersión en 8% y 13%: la premisa era el problema, no la medición.

Es al revés de lo que yo predije. Una de las dos es aritmética de bits pura y la
otra lleva una tabla de códigos con un gather por peso, así que esperaba la
segunda más lenta.

**No es ancho de banda**: la de más precisión son ~68% más bytes para ese tensor,
pero a la velocidad de memoria eso explica menos del 1% de la diferencia medida.
El resto es coste de ALU al descuantizar.

**Consecuencia:** la política de precisión mixta que le da el formato más preciso
a un tramo de capas «por calidad» las convierte a la vez en las más lentas del
modelo. Vale en torno al **3,5% del prefill entero**. Pero **no es una palanca
gratis**: cambiarlo cambia los pesos, la calidad y el tamaño del fichero — es
una decisión de cuantización, no de código.

## El aserto, arreglado

Ya no exige que las 48 capas SSM cuesten lo mismo: agrupa **por variante** y
exige uniformidad dentro de cada grupo, que es lo único afirmable. Y de paso
imprime la razón entre variantes, que es el número que antes faltaba.
