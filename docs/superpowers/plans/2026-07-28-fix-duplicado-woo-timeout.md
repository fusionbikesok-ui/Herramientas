# Plan: cerrar el hueco de duplicado por timeout en syncMlToWc

**Fecha:** 2026-07-28
**Worktree:** `.claude/worktrees/fix-duplicado-woo-timeout`
**Contexto:** `routes/sync.js` (`_procesarOrden`) ya tiene un lock atómico (reserva
`ml_order_id` en `ordenes_ml_wc_pedidos` con `wc_order_id=0` antes de llamar a Woo) que
arregló el incidente de doble-proceso del 2026-07-25. Pero el propio código documenta un
hueco residual: si el `POST /orders` a WooCommerce tiene éxito en el servidor pero la
respuesta al cliente se pierde/timeoutea, el `catch` borra la reserva y el próximo ciclo del
cron reintenta, creando un pedido duplicado real en Woo. No se disparó por este motivo hoy
(el incidente de hoy fue por una instancia de prueba con DB aislada corriendo en paralelo,
ya resuelto matando el proceso), pero el usuario pidió cerrarlo igual porque es un riesgo
real ("esto no puede fallar nunca más").

## Fix

En el `catch` de `_procesarOrden` (después del intento de `wooFetch(wooCfg, '/orders', 'post', ...)`),
antes de borrar la reserva y permitir reintento, verificar si Woo YA creó el pedido:

1. Consultar `GET /orders?meta_key=_ml_order_id&meta_value=<orderId>` (o el filtro
   equivalente que soporte la API de WooCommerce del proyecto — revisar cómo se listan
   pedidos por meta en otras partes del código, ej. `wooFetch` con query params) para ver
   si existe un pedido con ese `_ml_order_id` que Woo sí haya persistido.
2. Si existe → completar la reserva con ese `wc_order_id` real (mismo `UPDATE` que en el
   camino feliz) en vez de borrarla. No crear un pedido nuevo.
3. Si NO existe (falla real, no hubo pedido) → borrar la reserva como hoy, permitir
   reintento en el próximo ciclo.
4. Esta verificación debe tener su propio manejo de error: si la consulta de verificación
   también falla (ej. Woo caído), fail-closed → NO borrar la reserva (mejor bloquear un
   reintento que arriesgar un duplicado), loguearlo claramente para intervención manual.
5. Agregar un timeout explícito razonable al POST de creación de pedido si no lo tiene ya
   (revisar `wooFetch`/`lib/wooStock.js` o donde esté centralizado el cliente HTTP de Woo).

## Tests (TDD)

- Mock de `wooFetch` que simula: POST falla por timeout, pero una consulta posterior
  `GET /orders?...` muestra que el pedido SÍ existe → debe completarse la reserva con el
  `wc_order_id` real, sin crear un segundo pedido.
- Mock que simula: POST falla, y la consulta de verificación también confirma que NO existe
  ningún pedido → se borra la reserva, próximo ciclo puede reintentar (comportamiento actual,
  test de regresión).
- Mock que simula: POST falla, Y la consulta de verificación TAMBIÉN falla (error de red) →
  la reserva NO se borra (fail-closed), se loguea el caso para intervención manual.
- No romper ningún test existente de `sync.js`.

## Fuera de alcance
- No tocar el lock atómico de reserva en sí (ya funciona bien para el caso de dos procesos
  compitiendo).
- No tocar `syncWcToMl` ni `procesarReintentos`/`procesarCancelacionesMl` salvo que el fix
  requiera un helper compartido.
- No hay UI involucrada — no hace falta disenador-ux/ui ni probador-e2e, pero sí revisor +
  tester + auditor-despliegue.
