# UM1.2 — Detección y cobertura durable

**Estado:** en desarrollo. **Dependencia:** UM1.1 candidata. **Superficie:** VPS.

## Resultado

Impedir que reaparezca cobertura insegura mediante eventos durables ML/Woo, relectura desde origen, scan completo cada 15 minutos, salud degradada a los 60 minutos, alertas en menos de dos minutos y operaciones recuperables tras reinicios.

## Avance — webhook de catálogo Woo (2026-09-05)

- Ruta pública `POST /api/woo/webhook/product`, con HMAC, persistencia y deduplicación antes
  del ACK.
- Topics configurables: `product.created`, `product.updated`, `product.deleted`.
- Job durable `catalog.woo_product_sync`: relee el padre y todas sus variaciones; si la baja es
  de una variación borra solo esa fila local, y si es del padre borra el árbol local.
- No hay escrituras hacia Woo ni ML. La reconciliación de identidad global queda reservada al
  scan ML completo confiable; una relectura Woo puntual no puede degradar casos ajenos.

### Despliegue y evidencia — 2026-09-05

- PM2 reiniciado con `ac99f54`.
- Webhooks Woo activos: `product.created` (id 8), `product.updated` (id 9) y
  `product.deleted` (id 10), todos dirigidos a
  `https://herramientas.fusionbikes.com.ar/api/woo/webhook/product`.
- Entrega HMAC real `product.updated` del producto 1732: persistida antes de responder y
  completada por `catalog.woo_product_sync`; releyó el padre y sus cuatro variaciones vigentes.
- Incidente detectado en la primera entrega: la auditoría global posterior usó evidencia ML no
  confiable y reabrió 1056 casos. Se eliminó ese llamado global y se restauraron los estados
  desde el scan ML completo confiable de las 01:21 UTC. Resultado: 1055 verificadas, 34
  urgentes, 1 esperando operación y `conciliado=true`. Una segunda entrega HMAC completó sin
  alterar esos conteos. Backup: `data/fusion.sqlite.bak-um12-restaurar-cola-20260905T013950Z`.

## Gates

- Evento perdido, duplicado y fuera de orden convergen mediante scan.
- Claims avisan a los 20 minutos y vencen a los 30.
- Tres fallos o quince minutos terminan en intervención visible.
- Sin despliegue ni activación antes de revisión, tests y piloto.
