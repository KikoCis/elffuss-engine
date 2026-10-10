# Las capas no cuestan lo mismo, y la causa es UN tensor

`tests/prefillpases.browser.mjs` deja un aserto en rojo: **36% de dispersión
entre las 48 capas SSM**, que el propio banco daba por «idénticas en forma».

**La premisa era falsa.** Leyendo el índice del GGUF (tipo Y forma de cada
tensor, no solo el tipo) salen **5 firmas distintas entre las 65 capas**:

| familia | capas | variantes |
|---|---|---|
| SSM (48) | `0,1,2,4,5,6` · `8,9,10,12,…` | **6 + 42** |
| atención (16) | `3,7` · `11,15,19,…` | **2 + 14** |
| cabeza MTP | `64` | 1 (no se ejecuta) |

Las dos familias se parten **por el mismo sitio**: capas 0-7 contra capas 8 en
adelante. Y la diferencia es **un solo tensor**:

```
ffn_down.weight  [17408, 5120]
    capas 0-7   → Q2_K
    capas 8+    → IQ1_S
```

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

| variante de `ffn_down` | capas | ms por capa | dispersión dentro del grupo |
|---|---|---|---|
| **Q2_K** | 6 | **1556** | 8% |
| **IQ1_S** | 42 | **1217** | 13% |

**Q2_K cuesta un 28% MÁS que IQ1_S.** Y agrupar así convierte el 36% de
dispersión en 8% y 13%: la premisa era el problema, no la medición.

Es al revés de lo que yo predije. Q2_K es aritmética de bits pura e IQ1_S lleva
una tabla de códigos con un gather por peso, así que esperaba IQ1_S más lenta.

**No es ancho de banda**: Q2_K son 2,625 bits por peso contra 1,5625 de IQ1_S,
o sea ~68% más bytes para ese tensor — pero esos bytes de más son una fracción
despreciable del tiempo de la capa, dos órdenes de magnitud por debajo de la
diferencia medida. Es coste de ALU al descuantizar.

**Consecuencia:** la política de precisión mixta que le da Q2_K a las ocho
primeras capas «por calidad» las convierte a la vez en las más lentas del
modelo. Vale en torno al **3,5% del prefill entero**. Pero **no es una palanca
gratis**: cambiarlo cambia los pesos, la calidad y el tamaño del fichero — es
una decisión de cuantización, no de código.

## El aserto, arreglado

Ya no exige que las 48 capas SSM cuesten lo mismo: agrupa **por variante** y
exige uniformidad dentro de cada grupo, que es lo único afirmable. Y de paso
imprime la razón entre variantes, que es el número que antes faltaba.
