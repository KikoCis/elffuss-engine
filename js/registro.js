// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Elffuss Runtime · el REGISTRO de modelos: qué hay, dónde vive y cómo se lee.
// ─────────────────────────────────────────────────────────────────────────────
// Vive aparte del proveedor por una razón concreta: la app necesita SONDEAR si
// un modelo está disponible antes de ofrecerlo en el selector, y hacerlo
// importando el proveedor entero costaría traerse el motor completo a todo el
// que abra la página sin usarlo nunca.
//
// Tener las URLs en dos sitios ya salió mal una vez: cuando el 27B pasó de ser
// un fichero suelto a dos fragmentos en dos hosts, el sondeo de la app se quedó
// apuntando al fichero VIEJO. Seguía funcionando de milagro —el fichero aún
// estaba ahí— y el día que se borre para recuperar disco, la opción desaparece
// del selector sin que nadie relacione las dos cosas. Una sola fuente.
//
// Licencia: código propio, Apache-2.0 (ver SPDX arriba y LICENSE). Sin dependencias externas.

// Registro de modelos. `bytes` no es decorativo: se compara con el
// content-length real y avisa si el fichero de origen ha cambiado, porque un
// cambio de cuantización aguas arriba altera la salida sin previo aviso.
export const MODELS = {
  // MiniCPM5-2B, cuantizado a Q8_0 por nosotros desde el F16 de 4,7 GB.
  //
  // Entra sin tocar el motor porque su GGUF declara `general.architecture =
  // llama`, que ya se lee. Es un transformer PURO: las 42 capas son de atención
  // y las 42 pagan contexto, así que no tiene la ventaja del híbrido —en los
  // Qwen la mayoría de los bloques son SSM con estado de tamaño fijo— y su
  // caché KV por ficha es casi la del 27B teniendo diez veces menos parámetros.
  //
  // El fichero declara un contexto de 131.072 y aquí se pide 65.536. Lo que
  // manda no es el modelo, es lo que cuesta su KV: a 131k en f16 no cabe en el
  // presupuesto de una pestaña, y a 65k sí. Con la KV a 8 bits —no implementada
  // todavía, hoy solo hay f16 y f32— el contexto declarado sería alcanzable.
  //
  // Q8_0 y no algo más pequeño a propósito: es uno de los dos únicos tipos que
  // entran por el GEMM teselado del prefill. Un Q4_K cae al camino por filas y
  // paga una relectura de los pesos POR CADA ficha del lote.
  'minicpm5-2b': {
    label: 'MiniCPM5 2B · Q8_0',
    url: 'https://m1.elffuss.com/minicpm5-2b.q8',
    bytes: 2679710688,
    ctx: 65536,
  },

  'qwen35-0.8b': {
    label: 'Qwen3.5 0.8B · Q8_0',
    url: 'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf',
    bytes: 833592096,
    // 64k, medido en los dos modelos: la reserva funciona y el prefill NO cambia
    // (el contexto cuesta memoria, no tiempo — solo se paga por los tokens que
    // de verdad se procesan). Con la caché en f16 son la mitad de bytes que la
    // cuenta de antes: el modelo grande pasa de pedir 8 GiB a pedir 4.
    //
    // Si no cupiera, `provider.js` baja por mitades hasta 2048 en vez de dejar
    // al usuario sin modelo: un contexto de 16k sigue siendo ocho veces el de
    // antes y no se parece en nada a no tener modelo.
    ctx: 65536,
  },
  // El 27B propio. Verificado contra el volcado de llama.cpp (`test:diag27`):
  // el bloque 0 cuadra nodo a nodo y ninguna de las 64 capas se despega, así que
  // el texto ya sale coherente y no degenerado. Es avanzado por lo que CUESTA, no
  // por lo que falle: 7,6 GB de descarga, IQ1 (~2,2 bits por peso), contexto corto
  // y —medido, no supuesto— un prefill que con un prompt largo se hace eterno; el
  // retraso cae entero antes del primer token. Demostrable, no usable.
  //
  // (Aquí ponía que subir el `ctx` no servía de nada porque el techo lo pone el
  // prefill. Era falso y costó caro: ver el comentario del propio `ctx` abajo.)
  //
  // El `bytes` es el del fichero verificado: si el de origen cambia de
  // cuantización, la salida cambia sin avisar y esto lo caza.
  //
  // No cachearlo NO impide usarlo: el motor lee por RANGOS, así que funciona
  // igual leyendo del servidor. Lo que se paga es volver a leerlo en cada
  // sesión, y en un modelo que ya es «demostrable, no usable» por el prefill eso
  // no cambia el veredicto. El 0.8B sí cabe holgado y sí se cachea. El porqué
  // del `cache: false`, con la medición delante, está junto al propio campo.
  'qwen38-27b': {
    // SUSTITUIDO el 2026-09-23. Era nuestro Qwen3.8-27B IQ1_S (7,62 GB), y lo
    // reemplaza el ternario de Prism ML porque está MEDIDO que es mejor en las
    // tres cosas que importan aquí, no en una:
    //
    //   · agéntico: 37/40 y 39/40 en dos rondas del banco propio, contra 18/40
    //     de nuestro peldaño del mismo tamaño. La diferencia con nuestro IQ2_M
    //     (10 GB) es de 3 casos, POR DEBAJO del suelo de ruido de 5: o sea que
    //     iguala a un modelo un 40 % mayor.
    //   · kernel: su matmul gana porque NO hay codebook. El peso sale de un
    //     desplazamiento y una máscara, no de una tabla de 16 KiB con gather
    //     disperso por carril.
    //   · tamaño: 7,21 GB contra 7,62. Menos descarga, no más.
    //
    // Se elige el empaquetado PQ2_0 y no el PTQ1_0 (5,95 GB) aunque ocupe más:
    // 128 pesos a 2 bits son 32 bytes JUSTOS y el subgrupo tiene 32 carriles, un
    // byte cada uno, sin divergencia. El de base 3 reparte en tres etapas de
    // tamaños distintos y va 1,53x más lento — medido en 8 rondas, gana en 8.
    // Y se puede trasladar la medida de calidad entre los dos porque guardan los
    // MISMOS pesos bit a bit (comprobado en 4 tensores, 20.480 valores).
    //
    // ⚠️ Requiere la rotación de Hadamard sobre las activaciones: el fichero la
    // declara en sus metadatos y `hadamard.js` la aplica. Un motor que no la
    // tenga NO falla — carga y devuelve ruido.
    label: 'Bonsai 27B · ternario',
    // Servido desde el host del BROKER, no desde la web. Ahí el broker lo lee
    // en su MISMO origen (sin CORS de por medio) y lo guarda UNA vez para todos
    // los Elffuss: claw, code, copilot… en vez de que cada web se baje sus
    // propios gigabytes. Y el host manda Access-Control-Allow-Origin, así que el
    // camino directo —sin broker— también funciona.
    //
    // Estuvo en /models/ de la propia web y ahí era IMPOSIBLE compartirlo: el
    // broker vive en otro origen y sin CORS su fetch fallaba con «Failed to
    // fetch», sin más explicación.
    // REPARTIDO entre dos hosts, y la razón es medible: la cuota del navegador
    // es POR ORIGEN. En uno solo, 7,1 GiB se cortaban pasado el 90 % en tres de
    // cada cuatro intentos; en dos, cada mitad va sobrada. Y como los dos son
    // subdominios del mismo sitio, lo que se guarde se comparte con claw, code,
    // copilot y translator sin volver a bajarlo.
    //
    // `bytes` por fragmento NO es decorativo: si uno cambia de tamaño, las
    // fronteras se desplazan y todo lo que venga detrás se lee corrido — basura
    // sin un solo error.
    url: [
      { url: 'https://m1.elffuss.com/bonsai-27b.p0', bytes: 3602907136 },
      { url: 'https://m2.elffuss.com/bonsai-27b.p1', bytes: 3603261792 },
    ],
    // El del fichero SANEADO, que es el que se publica: al quitarle los
    // metadatos con rutas de disco encogió 256 bytes. Con el número viejo el
    // motor avisaba en cada carga de que el origen había cambiado.
    bytes: 7206168928,
    // 512 era INVIABLE y no por poco: el prompt de sistema de Elffuss son 626
    // tokens él solo (medido con este mismo tokenizador), así que la caché KV
    // reventaba —«la caché se llena»— antes de que el usuario escribiera nada.
    // El modelo no fallaba: no llegaba a ver la pregunta.
    //
    // Subirlo NO cuesta tiempo, cuesta memoria: `ctx` solo dimensiona la caché
    // KV (64 MiB a 512 → 256 MiB a 2048). El prefill lo paga el número de
    // tokens que se procesan de verdad, que es el mismo. Bajarlo para «ir más
    // rápido» fue confundir las dos cosas.
    ctx: 65536,   // ver la nota del modelo pequeño: medido, y con red si no cabe
    // SE CACHEA, y esto es lo que más ha costado del modelo entero. Medido
    // contra producción, con el registro de nginx de testigo:
    //
    //   1ª carga  centenares de peticiones al servidor
    //   2ª carga  CERO peticiones
    //
    // Y la segunda no puede ser una descarga disfrazada: tardó una fracción de
    // lo que el enlace necesita para mover el modelo entero, así que los bytes
    // salieron del almacén. De minutos de espera a segundos.
    //
    // Estuvo desactivado porque parecía romper producción, y era mentira tres
    // veces: el banco se medía contra el dominio que redirige (y perdía el
    // localStorage, así que cargaba OTRO modelo), el equipo se dormía a media
    // descarga (ERR_NETWORK_IO_SUSPENDED), y cada vuelta abría un perfil nuevo
    // —o sea que un cacheo perfecto se habría medido igual que ninguno—.
    //
    // Lo que SÍ estaba roto era el broker: al fallar una descarga no borraba
    // los trozos ya escritos, así que cada fallo dejaba gigabytes huérfanos, el
    // intento siguiente no cabía, y salía «exceed its storage quota» acusando
    // al disco del usuario. Se envenenaba solo. Arreglado en server/broker/.
    cache: true,
    // El prompt compacto ESTUVO aquí y se ha quitado. La razón de ponerlo era
    // de velocidad: el completo tarda más en procesarse y el usuario espera
    // mirando una caja quieta. Pero un prompt recortado deja al modelo sin
    // saber hacer tareas, y un asistente que carga, responde y no sirve para
    // nada es peor que uno lento — probado en uso real, no en un banco.
    //
    // El coste de volver al prompt completo es un primer prefill más largo.
    // Eso se ataca donde toca: reutilizando el prefijo entre turnos (ya hecho,
    // ver provider.js) y guardando la foto del estado entre SESIONES, que es lo
    // que hace que se pague una vez y no cada vez que se abre la web.
  },
};

// ¿Se puede usar este modelo AHORA? Se pregunta a los ficheros de verdad, con
// una petición de un solo byte por fragmento: comprueba de paso que el host
// responda, que admita rangos y que el CORS deje leerlo, que es exactamente lo
// que hará la carga después. Ofrecer una opción que falla al elegirla es peor
// que no ofrecerla.
// Todos los ORIGENES donde puede haber pesos guardados.
//
// Cada fragmento lo guarda el broker de SU PROPIO host (ver `model-broker.js`),
// asi que un modelo repartido entre dos servidores ocupa DOS origenes. El panel
// de almacenamiento preguntaba solo al broker por defecto y por eso enseñaba
// una fraccion: con el 27B guardado en m1 y m2, el contador miraba a un tercer
// origen que no tiene nada. Una cifra de ocupacion que no suma donde estan los
// bytes es peor que no tenerla, porque parece exacta.
export function origenesAlmacen() {
  // Solo los origenes NUESTROS: un modelo servido desde un tercero (Hugging
  // Face, por ejemplo) no tiene nuestra pagina de broker, asi que preguntarle
  // no devolveria nada y ademas costaria la espera entera del timeout — ocho
  // segundos de panel colgado por un origen que nunca iba a responder.
  const NUESTRO = /(^|\.)elffuss\.com$|(^|\.)utopiaia\.com$|^localhost$/;
  const o = new Set();
  for (const m of Object.values(MODELS)) {
    const urls = Array.isArray(m.url) ? m.url.map(f => f.url) : (m.url ? [m.url] : []);
    for (const u of urls) {
      try {
        const { hostname, origin } = new URL(u);
        if (NUESTRO.test(hostname)) o.add(origin + '/');
      } catch { /* url relativa o rara */ }
    }
  }
  return [...o];
}

export async function disponible(id) {
  const m = MODELS[id];
  if (!m) return false;
  const urls = Array.isArray(m.url) ? m.url.map(f => f.url) : [m.url];
  try {
    const rs = await Promise.all(urls.map(u =>
      fetch(u, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' })));
    return rs.every(r => r.ok);
  } catch { return false; }
}

// ¿Se guarda este modelo en el navegador? Normalmente lo dice el registro, pero
// se puede FORZAR desde fuera con `localStorage['elffuss.engine.cache']`
// ('1' enciende, '0' apaga).
//
// No es un ajuste para usuarios, es un instrumento: el cacheo del 27B hay que
// medirlo contra producción de verdad —un banco aislado ya lo dio por bueno y
// no lo era— y sin este interruptor la única forma de probarlo sería
// encendérselo a todo el mundo. Si sale mal, quien lo paga es quien esté
// cargando el modelo en ese momento: la descarga entera perdida y vuelta a
// empezar por el otro camino.
export function cachea(m) {
  try {
    const o = localStorage.getItem('elffuss.engine.cache');
    if (o === '1') return true;
    if (o === '0') return false;
  } catch { /* sin localStorage (worker, sandbox) */ }
  return m.cache !== false;
}
