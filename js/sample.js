// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
// Elffuss Runtime · muestreo y bucle de generación.
// ─────────────────────────────────────────────────────────────────────────────
// El bucle de decode es donde el motor pasa el 99 % del tiempo, y donde falla lo
// que un forward suelto no puede detectar: que el estado se arrastre bien entre
// llamadas. Un forward aislado empieza con el estado a cero y la caché vacía, así
// que valida la matemática pero no la memoria.
//
// La prueba que sí lo detecta es de consistencia interna: procesar «abc» de una
// vez tiene que dar el MISMO resultado que procesar «a», luego «b», luego «c».
// Si la caché KV se escribe en el sitio equivocado, si el estado recurrente no
// se arrastra o si las posiciones de RoPE se reinician, las dos formas divergen.
//
// Licencia: código propio y PRIVADO — no se publica. Sin dependencias externas.

// Muestreo sobre los logits ya en CPU. Se trabaja sobre el último token, que es
// el único que interesa al generar.
//   · temp = 0 → greedy, determinista.
//   · top-p sobre la distribución ya con temperatura, como es habitual.
export function sample(logits, opts = {}) {
  const { temperature = 0, topP = 1, topK = 0, seed = 1,
          repeatPenalty = 1.1, repeatLastN = 64, previos = null } = opts;
  const n = logits.length;

  // PENALIZACIÓN DE REPETICIÓN. Sin esto, el decode voraz sobre un modelo muy
  // cuantizado entra en bucle: «el color es de color, el color es de color…».
  // No es un defecto del modelo, es que nada empuja a salir del mínimo local, y
  // llama-cli la aplica POR DEFECTO (1.1 sobre los últimos 64) — comparar mi
  // salida con la suya sin ella era comparar dos cosas distintas.
  //
  // La forma es la de llama.cpp: dividir si el logit es positivo y MULTIPLICAR
  // si es negativo. Dividir siempre haría MENOS negativo lo ya improbable, o
  // sea lo premiaría.
  if (previos && previos.length && repeatPenalty !== 1) {
    const desde = Math.max(0, previos.length - repeatLastN);
    const vistos = new Set();
    for (let i = desde; i < previos.length; i++) vistos.add(previos[i]);
    for (const id of vistos) {
      if (id < 0 || id >= n) continue;
      logits[id] = logits[id] > 0 ? logits[id] / repeatPenalty : logits[id] * repeatPenalty;
    }
  }
  if (temperature <= 0) {
    let best = 0;
    for (let i = 1; i < n; i++) if (logits[i] > logits[best]) best = i;
    return best;
  }

  // Se ordena por logit y se corta antes de exponenciar: con 248.320 entradas,
  // hacerlo al revés cuesta un softmax completo para tirar el 99,9 %.
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => logits[b] - logits[a]);
  const keep = topK > 0 ? Math.min(topK, n) : n;

  // Resta del máximo antes de exp(): sin ella, logits de 30 desbordan.
  const max = logits[idx[0]];
  const probs = new Float64Array(keep);
  let total = 0;
  for (let i = 0; i < keep; i++) {
    probs[i] = Math.exp((logits[idx[i]] - max) / temperature);
    total += probs[i];
  }

  let corte = keep;
  if (topP < 1) {
    let acc = 0;
    for (let i = 0; i < keep; i++) {
      acc += probs[i] / total;
      if (acc >= topP) { corte = i + 1; break; }
    }
  }
  let sub = 0;
  for (let i = 0; i < corte; i++) sub += probs[i];

  // Generador propio y con semilla: Math.random() haría irreproducible
  // cualquier prueba de regresión de generación.
  let s = (seed >>> 0) || 1;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  let r = ((s >>> 8) / 8388608) * sub;
  for (let i = 0; i < corte; i++) {
    r -= probs[i];
    if (r <= 0) return idx[i];
  }
  return idx[corte - 1];
}

// Genera tokens uno a uno. El prompt entero va en UNA llamada (prefill) y cada
// token nuevo en la suya (decode), que es exactamente el patrón real.
export async function generate(session, readLogits, promptIds, opts = {}) {
  const max = opts.maxTokens || 32;
  const stop = new Set(opts.stopIds || []);
  const onToken = opts.onToken || (() => {});
  const out = [];

  let ids = promptIds;
  for (let step = 0; step < max; step++) {
    const { logits, logitsTokens } = await session.forward(ids);
    // El forward devuelve logits SOLO del último token salvo que se pidan todos:
    // deducir el vocabulario dividiendo por el número de tokens del prompt daría
    // un vocabulario 316 veces más pequeño y una lectura corrida.
    const vocab = logits.size / 4 / logitsTokens;
    const all = await readLogits(logits, logitsTokens * vocab);
    const last = all.subarray((logitsTokens - 1) * vocab, logitsTokens * vocab);
    // Se le pasan los tokens ya emitidos MÁS el prompt: repetir lo que acaba de
    // decir el usuario es tan bucle como repetirse a sí mismo.
    const id = sample(last, { ...opts, seed: (opts.seed || 1) + step,
                              previos: promptIds.concat(out) });
    session.recycle();
    if (stop.has(id)) break;
    out.push(id);
    onToken(id, step);
    ids = [id];
  }
  return out;
}
