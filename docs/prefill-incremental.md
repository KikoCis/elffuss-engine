# Prefill incremental: no volver a pagar lo ya pagado

**Estado: FUNCIONANDO Y ENCENDIDO POR DEFECTO** desde `792ad9a`. El banco
(`tests/prefijo.browser.mjs`) pasa 6 de 6 en LOS DOS modelos:

| | turno 2 | turno 3 |
|---|---|---|
| 0.8B | procesa 23 de 63 | procesa 23 de 82 |
| 27B | procesa 26 de 66 | procesa 23 de 85 |

Texto idéntico con y sin reutilización, y tocar un mensaje viejo fuerza
reinicio completo. Lo procesado **se queda plano mientras el prompt crece**.

⚠️ Esta cabecera dijo durante unas horas «IMPLEMENTADO, VALIDADO E INERTE…
reutiliza 0 de 2», o sea que el documento refutaba a su propio código. Se
quedó así al commitearlo junto al arreglo sin releerlo. Un documento caducado
en un repo es peor que no tenerlo: los frentes de la investigación lo citaron
como estado actual.

## POR QUÉ NO ACERTABA NUNCA (medido, no supuesto) — y cómo se arregló

La traza da un desfase CONSTANTE de 5 tokens desde el final: «diverge en el
token 40 de 45» y «diverge en el token 59 de 64». Constante ⇒ estructural.
Decodificando esos tokens:

```
ingerido[40..]:  "<think>|\n\n|</think>|\n\n|uno"
prompt2 [40..]:  "uno|<|im_end|>|\n|<|im_start|>|user|…"
```

`montarPrompt` añade `<think>\n\n</think>\n\n` **al final de cada prompt** —lo
abre la plantilla, no el modelo— y el estado se lo traga. Pero cuando ese turno
pasa a ser HISTORIA, ese bloque **no se reproduce**. Así que lo ingerido nunca
puede ser prefijo del prompt siguiente: **por construcción, no por casualidad.**

## DOS ARREGLOS QUE PARECEN BUENOS Y NO LO SON

1. **Concatenar tokens en vez de recodificar.** Daría una secuencia DISTINTA de
   la que produce un reinicio, así que la salida dependería de si hubo caché.
   Es exactamente la contaminación silenciosa que esto intenta evitar, y además
   invalidaría la prueba de igualdad del banco.
2. **Meter el bloque `<think>` también en la historia.** Haría cuadrar el
   prefijo, pero se desvía de lo que hace la plantilla real de estos modelos —en
   historia el razonamiento se quita—, o sea cambiar la calidad para ganar
   velocidad. No.

## EL QUE SÍ: instantánea ANTES del bloque `<think>`

Si el estado se fotografía justo antes de alimentar `<think>`, lo ingerido es
`sistema + usuario + <|im_start|>assistant\n`, que **sí** es prefijo exacto del
prompt del turno siguiente, sin tocar el formato.

Exige **copiar** el estado, porque el recurrente del SSM no se rebobina.

### Lo que cuesta la instantánea (derivado de los hiperparámetros reales)

`state.js` ya crea TODOS los buffers con `COPY_SRC | COPY_DST`, así que copiar
de GPU a GPU está permitido sin tocar nada de su creación.

Con `time_step_rank`=48, `state_size`=128, `conv_kernel`=4, `inner_size`=6144 y
`group_count`=16:

| | por capa | × 48 capas SSM |
|---|---|---|
| estado recurrente | 48·128·128·4 = **3 MiB** | **144 MiB** |
| conv | 3·(2·16·128 + 6144)·4 = 120 KiB | **5,6 MiB** |
| | | **149,6 MiB FIJO** |

**Fijo quiere decir que no crece con el contexto.** Es la propiedad que hace
viable esto: fotografiar el estado de una conversación de 200.000 tokens cuesta
exactamente lo mismo que el de una de 10.

**La KV no se fotografía** —si se confirma que la máscara causal solo lee hasta
`nPast`, restaurar es devolver ese entero atrás y dejar que se sobrescriba—.
Eso es lo que separa 150 MiB de 400 MiB, así que se comprueba, no se supone.

### La ventaja híbrida, en cifras

Solo 16 de las 64 capas llevan KV: 4 cabezas × 256 × 4 B × 2 = **128 KiB por
token**. A 2048 de contexto son 256 MiB; **a los 262.144 que declara el modelo,
32 GiB.** Un denso de 64 capas de atención pagaría cuatro veces eso.

Las otras 48 capas no pagan NADA por contexto: su estado es de tamaño constante.
O sea que para contexto largo, en este modelo, el problema es **entero** de las
16 capas de atención — y ahí es donde valen las técnicas de cuantizar, desalojar
o deslizar ventana sobre la KV.

## Lo que pasa hoy

`provider.js` llama a `sesion.state.reset()` en CADA turno, así que cada turno
vuelve a procesar la conversación entera desde el token cero, a ~163 ms por
token de prompt. El turno 5 vuelve a pagar todo lo que ya calcularon los turnos
1 a 4.

El comentario que justifica ese reset dice que el `system` cambia en cada
llamada porque lleva el contexto vivo dentro, así que el prefijo cacheado no
valdría. **Ese razonamiento es correcto en general y NO aplica al 27B**:
`registro.js` le pone `prefiereCompacto: true`, y el prompt compacto de
`agent.js` no lleva ni catálogo de herramientas ni bloque `CONTEXTO AHORA`. Son
506 caracteres (~126 tokens) estables entre turnos.

## Cuándo el prefijo es reutilizable de verdad

Mientras `history.length <= RECENT` (RECENT = 6 en `context.js`):

- `old` sale vacío, así que **no hay reordenación por BM25**. Esa reordenación
  es lo que rompería todo: puntúa los mensajes viejos contra la consulta ACTUAL,
  o sea que el conjunto y el orden de lo que sobrevive cambian en cada turno.
- `recent` es la historia entera, y cada turno solo AÑADE al final.
- `clampMsg` es función pura del contenido del mensaje: un mensaje dado siempre
  recorta al mismo texto, así que los turnos viejos tokenizan igual cada vez.

Pasados los 6 mensajes la ventana se desliza y deja de ser append-only. No se
intenta reutilizar nada ahí: se reinicia y ya.

## Las dos trampas, que NO dan error

1. **Un estado recurrente no se puede rebobinar.** 48 de las 64 capas son SSM
   (gated delta net). La caché KV se podría truncar en una posición; el estado
   recurrente del SSM **no**, porque es el resultado de haber recorrido toda la
   secuencia. Conclusión: la reutilización solo es legal si el prompt nuevo es
   un AÑADIDO PURO al viejo. Ante cualquier divergencia, `reset()` completo —
   nunca un reset parcial.

2. **Destokenizar y volver a tokenizar NO es la identidad.** Los tokens de la
   respuesta que ya están en el estado son los que SE MUESTREARON. Si el turno
   siguiente vuelve a codificar el texto del asistente, puede salir otra
   secuencia de tokens para el mismo texto. Comparando TEXTO eso no se ve y
   contamina todos los turnos siguientes en silencio.

   Por eso la comparación es **sobre tokens**, y la secuencia nueva se construye
   arrastrando los arrays de tokens ya usados (prompt previo + tokens
   muestreados) en vez de recodificar la respuesta.

## La guardia

```
idsPrevios = tokens que el estado YA ha consumido (prompt previo + respuesta muestreada)
ids        = tokens del prompt de este turno

si ids empieza EXACTAMENTE por idsPrevios  → alimentar solo ids.slice(idsPrevios.length)
si no                                       → state.reset() y alimentar ids entero
```

La comparación es token a token, no por longitud ni por texto. Si no cuadra, se
reinicia: perder la optimización es gratis, arrastrar un estado inválido no.

Nota: el token de parada (`<|im_end|>` / eos) se muestrea pero **no** se
alimenta —el bucle rompe antes—, así que no está en el estado y hay que
incluirlo en el añadido.

## Lo que se espera ganar

En una conversación dentro de los 6 primeros mensajes, el turno 2 en adelante
pasaría de procesar el prompt entero a procesar solo el mensaje nuevo del
usuario más los delimitadores de plantilla: de cientos de tokens a decenas.

**No se pone número aquí a propósito.** Todavía no está medido, y esta misma
sesión ya ha visto un micro-banco predecir ×3–4 donde el kernel real dio ×1,14.

## Cómo se valida antes de creérselo

1. **Igualdad de bytes**: misma conversación con y sin reutilización, comparando
   la salida token a token. Tiene que dar diferencia 0. Es el método que ya cazó
   tres fallos que no daban error.
2. **Divergencia forzada**: cambiar un mensaje viejo a mitad de conversación y
   comprobar que la guardia dispara el reset en vez de reutilizar.
3. **Pasar de RECENT**: llegar al mensaje 7 y comprobar que se reinicia.
