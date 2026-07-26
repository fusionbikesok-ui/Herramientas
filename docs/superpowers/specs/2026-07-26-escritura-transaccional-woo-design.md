# Escritura transaccional a Woo — Preparación de Pedidos

**Fecha:** 2026-07-26
**Estado:** aprobado, pendiente de plan de implementación
**Alcance:** quinto ciclo de 6 en la lista de mejoras a Preparación de Pedidos. Ataca la
fricción #7 detectada en el análisis original: "doble escritura no transaccional a Woo en
seguimientos" — hoy solo *mitigada*, nunca formalizada.

**Nota:** este ciclo se planeó y ejecutó con el usuario no disponible en el momento
(agente orquestador tomando las decisiones de diseño en su representación, criterio
conservador igual que los ciclos 1, 2 y 4).

## Contexto y problema

`POST /seguimientos/:wcOrderId` (`routes/preparacion.js`) hace **dos escrituras
separadas** a la API de WooCommerce, sin ninguna garantía transaccional entre ambas:

1. PUT 1: `status: 'completed'` + `meta_data` con el tracking → dispara el mail nativo de
   WooCommerce al cliente.
2. PUT 2: `status: enviadoandreani` (estado final custom del flujo).

Si PUT 1 tiene éxito pero PUT 2 falla (timeout, WC caído un instante, rate limit), el
pedido queda **"colgado"**: en Woo figura `completed` con tracking cargado, pero nunca
llegó a `enviadoandreani`. Hoy esto se **mitiga**, no se soluciona:

- `GET /seguimientos` escanea *todos* los pedidos `completed` de Woo en cada carga de
  pantalla, cruza el meta del tracking, y muestra los colgados con badge "reintentar".
- La única forma de resolverlo es que un operario **note el badge y clickee "Guardar"
  de nuevo a mano** — no hay ningún reintento automático.
- Mientras tanto (hasta que alguien lo note), si el request original devolvió `500`, el
  código actual **ni siquiera deja registro local** de que el pedido llegó a `completed`
  — la única fuente de verdad es Woo mismo.

## Decisiones (tomadas por el orquestador en ausencia del usuario)

1. **No se reemplaza la detección existente vía escaneo de Woo — se agrega un
   mecanismo automático encima.** El escaneo de `status=completed` en `GET /seguimientos`
   es una red de seguridad real: detecta colgados aunque el registro local nunca se haya
   creado (por ejemplo, si el proceso se cae justo después del PUT 1, antes de escribir en
   SQLite, o si un colgado quedó de antes de que existiera este ciclo). Reemplazarlo por
   una bandera puramente local perdería esa cobertura. Los tests de contrato existentes
   (`test/preparacion-contrato.test.js`, `describe('GET /seguimientos')`) **no se tocan**.
2. **Nueva columna local `woo_paso2_pendiente`** en `preparaciones`, para que el propio
   código que hizo el PUT 1 dejé registro inmediato (antes de intentar el PUT 2) de que
   el pedido llegó a `completed` con tracking guardado — así el reintento automático (item
   siguiente) no depende de volver a escanear Woo.
3. **`POST /seguimientos/:wcOrderId` ahora persiste el registro local ANTES del PUT 2**,
   no después de que ambos PUTs tengan éxito (como es hoy). Si el PUT 2 falla: la
   respuesta pasa a ser `502` con `{ok:false, colgado:true, error:...}` en vez de un `500`
   genérico — el frontend ya maneja esto sin cambios (el `catch` de `guardarSeguimiento`
   ya hace `alert(e.message)` con el mensaje de error, cualquiera sea).
4. **Nuevo cron cada 10 minutos** que busca `preparaciones WHERE woo_paso2_pendiente=1` y
   reintenta el PUT 2 solo, sin intervención humana. Si tiene éxito, limpia la bandera y
   marca `completada`. Si vuelve a fallar, lo deja para la corrida siguiente (fail-open,
   mismo patrón que los crons existentes en `server.js`).
5. **Se registra en el feed de Actividad (ciclo 3)**: `tracking_colgado` cuando el PUT 2
   falla la primera vez, `tracking_recuperado` cuando el cron (o un reintento manual) lo
   resuelve. Reusa `registrarEvento`, no un sistema paralelo.
6. **El reintento manual desde la UI sigue funcionando exactamente igual que hoy** (vía
   el camino `colgadoCompletado` ya existente) — es un camino alternativo válido si el
   operario lo nota antes que el cron, o si por algún motivo el cron no lo resuelve.

## Diseño técnico

### Esquema

```sql
-- ALTER TABLE preparaciones ADD COLUMN woo_paso2_pendiente INTEGER NOT NULL DEFAULT 0
```

Patrón idempotente `try/catch` con `ALTER TABLE`, igual que `borrado_en` en el ciclo 3.

### `POST /seguimientos/:wcOrderId` (modificado)

Después del PUT 1 (o de saltearlo si ya estaba completed con el mismo tracking), y
**antes** de intentar el PUT 2:

```js
db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
  VALUES ('web', ?, ?, 1, 'en_preparacion', ?, 1)
  ON CONFLICT(clave) DO UPDATE SET woo_paso2_pendiente=1`)
  .run(`web:${wcOrderId}`, wcOrderId, now());
```

Después, el PUT 2 queda envuelto en su propio `try/catch`:

- Si tiene éxito: `UPDATE preparaciones SET estado='completada', completado_en=?,
  woo_paso2_pendiente=0 WHERE clave=?`, responde `{ok:true}` (sin cambios respecto a hoy).
- Si falla: registra `tracking_colgado` (fail-open) y responde `502` con
  `{ok:false, colgado:true, error:'el tracking se guardó pero no se pudo marcar como
  enviado (se reintentará solo)'}`. **No se relanza la excepción** — el catch externo del
  handler no debe convertir esto en un `500` genérico.

### Cron de reintento (`purgarColgadosTracking`, nuevo, exportado desde `routes/preparacion.js`)

```js
export async function reintentarColgadosTracking(db, cfg) {
  const pendientes = db.prepare('SELECT * FROM preparaciones WHERE woo_paso2_pendiente=1').all();
  let resueltos = 0;
  for (const prep of pendientes) {
    try {
      await wooFetch(cfg.woo, `/orders/${prep.wc_order_id}`, 'put', { status: cfg.enviadoAndreaniStatus || 'enviadoandreani' });
      db.prepare("UPDATE preparaciones SET estado='completada', completado_en=?, woo_paso2_pendiente=0 WHERE id=?")
        .run(new Date().toISOString(), prep.id);
      registrarEvento(db, { preparacionId: prep.id, itemId: null, tipo: 'tracking_recuperado', usuario: null, detalle: {} });
      resueltos++;
    } catch (e) {
      console.error(`reintentarColgadosTracking: sigue colgado wc_order_id=${prep.wc_order_id}:`, e.message);
    }
  }
  return resueltos;
}
```

Registrado en `server.js` junto a los demás `cron.schedule`, cada 10 minutos:
`cron.schedule('*/10 * * * *', () => reintentarColgadosTracking(app._db, { woo: wooCfg, enviadoAndreaniStatus: ... }).catch(...))`.

Sin límite de chunking explícito — el universo de colgados es inherentemente chico
(fricciones puntuales de red), no un dataset que crezca sin cota.

## Fuera de alcance de este ciclo

- Tocar el PUT 1: sigue disparando el mail nativo tal cual hoy; no se propone ninguna
  forma de "deshacer" ese mail si algo sale mal después.
- Un mecanismo de alerta activa (email/Slack) si un colgado persiste después de varios
  reintentos del cron — se puede agregar después si en la práctica el cron no alcanza.
- Extender este patrón a otras escrituras de Woo (`lib/wooStock.js`, `routes/sync.js`):
  son escrituras de un solo PUT cada una, no encadenadas, y no muestran el mismo síntoma.

## Siguiente paso

Invocar el plan de implementación: columna nueva + reescritura del bloque PUT2 dentro de
`POST /seguimientos/:wcOrderId` (TDD) + función de reintento + registro del cron.
