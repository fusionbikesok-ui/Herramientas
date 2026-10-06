# UM1.2 — Detección y cobertura durable

**Estado:** desarrollo. **Dependencia:** UM1.1 candidata. **Superficie:** VPS.

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
- Webhook Woo relee puntualmente; scans completos Woo y ML corren cada 15 minutos. Woo degrada a los 30 minutos sin scan confiable y ML a los 60.
- Un cambio descubierto por scan sin webhook converge y genera alerta/métrica de cobertura perdida.
- Baja o cambio crítico Woo confirmado protege todas las claves ML vinculadas; recuperación válida restaura stock y libera pedidos tras verificar.
- Claims son opcionales; cualquier decisor puede relevar con motivo y `expected_version` resuelve concurrencia.
- Tres fallos o quince minutos terminan en intervención visible.
- Sin despliegue ni activación antes de revisión, tests y piloto.

## Ciclo de vida

- ML pausada o sin stock con identidad inválida: caso no urgente.
- ML cerrada/eliminada: identidad archivada e historia conservada.
- ML reactivada con stock e identidad inválida: stock cero y urgencia máxima.
- Woo eliminada, en papelera o con SKU alterado: relectura puntual y protección de todas sus claves; una recreación con otro ID exige transferencia administrativa.

## Qué dispara el webhook de `items`, y qué no — 2026-09-05

Análisis pedido por el usuario **antes de desplegar**, sobre la pregunta concreta de si un
cambio de precio podría reactivar publicaciones.

### Lo que el webhook hace

Relee el ítem (`GET /items?ids=`, nunca un PUT) y actualiza `ml_publicaciones_cache`. No
dispara la auditoría de identidad —el antecedente de PM-101, donde un webhook de Woo corrió la
auditoría global y degradó 1056 SKU, no se repite— y no hay triggers sobre esa tabla.

### Consumidores del cache y efecto real de tenerlo más fresco

16 archivos leen `ml_publicaciones_cache`. Los que derivan en una **acción**:

| Consumidor | Efecto de un cache más fresco | Riesgo |
| --- | --- | --- |
| `reactivarAutomatico` | Evalúa antes una publicación que volvió a tener stock o cuyo precio cambió | **Ninguno nuevo**: revalida en vivo contra ML (`chequearNetoReactivar`, fail-closed) antes de escribir. Cambia el *cuándo*, no el *si*. Ver PM-139 |
| `syncWcToMl` (push de stock) | Deja de empujar antes a una publicación recién pausada; empuja antes a una recién activa | Favorable: el push va por `sku_matcher_decisiones`, no por estos campos |
| `esClaveCubierta` → retención de pedidos | Un `seller_sku` más fresco cambia antes el veredicto de cobertura | Favorable: decide sobre datos más nuevos |
| Auditoría de identidad | Clasifica sobre observaciones más frescas | Favorable, y es el motivo del ramp |

Ninguno introduce una acción nueva; todos actúan sobre datos más nuevos.

### Lo que NO medíamos y ahora sí

Se registraba **que** llegó un aviso, no **qué** cambió. `ml_cambios_observados` (migración 087)
captura el diff campo por campo —`seller_sku`, `available_quantity`, `status`, `sub_status`,
`precio`, `user_product_id`, `gtin`— con origen `webhook` o `scan`.

Preguntas que pasan a tener respuesta y hoy no la tenían:

- ¿Con qué frecuencia ML cambia un precio por su cuenta?
- ¿Cuántas veces nos pausa una publicación, y con qué `sub_status`?
- ¿Alguien edita el `SELLER_SKU` en ML por fuera de la herramienta?
- ¿El stock se mueve sin que haya venta? — la señal de las bolsas compartidas de PM-132.

Es **captura, no acción**: nadie decide nada con esa tabla todavía, y su escritura es fail-open
para no tumbar la proyección.

### Pendiente, deliberadamente

- **Accionar sobre esos cambios** (alertar por precio modificado fuera de la herramienta, por
  pausa inesperada, por `SELLER_SKU` editado a mano). Primero hay que ver los números reales:
  accionar sobre una frecuencia que no conocemos es inventar umbrales.
- **Retención de `ml_cambios_observados`**: sin política todavía. A ~380 ítems con cambios por
  día el crecimiento es modesto, pero conviene fijarla antes de que sea un problema.
