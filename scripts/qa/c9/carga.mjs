#!/usr/bin/env node
/**
 * E1 T3 C9 — reproduce los webhooks anonimizados contra una instancia AISLADA del legado, espaciados
 * parejo en la duración pedida, y mide la latencia del ACK desde el cliente.
 *
 * Uso: node carga.mjs <peticiones.json> <base_url> <duracion_s> <secreto_woo> <salida.json>
 * Salida: por petición { tipo, topic, status, ms } y un resumen con p50/p95/p99 y códigos por tipo.
 */
import crypto from 'crypto';
import fs from 'fs';

const [archivo, base, durTexto, secreto, salida] = process.argv.slice(2);
const peticiones = JSON.parse(fs.readFileSync(archivo, 'utf8'));
const duracionMs = Number(durTexto) * 1000;
const paso = duracionMs / peticiones.length;
const pct = (xs, p) => { const o = [...xs].sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)] : null; };

async function enviar(p) {
  const cuerpo = JSON.stringify(p.body);
  let url; const headers = { 'content-type': 'application/json' };
  if (p.tipo === 'ml') url = `${base}/api/ml/notificacion`;
  else {
    url = `${base}/api/woo/webhook/${p.tipo === 'woo_order' ? 'order' : 'product'}`;
    headers['x-wc-webhook-topic'] = p.topic;
    headers['x-wc-webhook-delivery-id'] = p.delivery;
    headers['x-wc-webhook-signature'] = crypto.createHmac('sha256', secreto).update(cuerpo).digest('base64');
  }
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'POST', headers, body: cuerpo, signal: AbortSignal.timeout(15_000) });
    await r.arrayBuffer();
    return { tipo: p.tipo, topic: p.topic, status: r.status, ms: performance.now() - t0 };
  } catch (e) {
    return { tipo: p.tipo, topic: p.topic, status: 0, ms: performance.now() - t0, error: e?.cause?.code || e.name };
  }
}

const inicio = performance.now();
const resultados = [];
const vuelo = [];
for (let i = 0; i < peticiones.length; i++) {
  const objetivo = inicio + i * paso;
  const espera = objetivo - performance.now();
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  vuelo.push(enviar(peticiones[i]).then((r) => { resultados[i] = r; }));
}
await Promise.all(vuelo);
const ms = resultados.map((r) => r.ms);
const codigos = {};
for (const r of resultados) codigos[`${r.tipo}:${r.status}`] = (codigos[`${r.tipo}:${r.status}`] || 0) + 1;
const resumen = { n: resultados.length, duracion_s: Math.round((performance.now() - inicio) / 1000), p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: Math.max(...ms), codigos, errores_red: resultados.filter((r) => r.status === 0).length };
fs.writeFileSync(salida, JSON.stringify({ resumen, resultados }), { mode: 0o600 });
console.log(JSON.stringify(resumen));
