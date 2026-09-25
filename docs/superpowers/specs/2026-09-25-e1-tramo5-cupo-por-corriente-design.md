# E1 tramo 5 — Cupo sombra de ML por corriente

**Estado:** diseño (PM-188, decisión de José 2026-09-25). **Entrega:** E1. **Reglas:** todo lo que toque ML sigue `specs/ml-api-guia.md`.

## 1. Problema

`crearPresupuestoShadow` (`lib/gatewayCanal.js`) es un único bucket por minuto de `GATEWAY_ML_SHADOW_RPM=30`
compartido por las 6 corrientes ML de la sombra. `ml.shipments` (1 GET por envío abierto) y `ml.messages`
(1 + 1 por pack) lo vacían solos: 0 barridos OK en 24 h y señales de `ml.items` en dead letter con
`retryable: HTTP_429`. Además, el 429 sintético es indistinguible de un 429 real de ML (guía §4). Con esto
la campaña de 7 días verdes (PM-186) no puede salir nunca.

## 2. Alcance

1. **Cupo por corriente.** Cada operación del gateway pertenece a una corriente:

   | Corriente | Operaciones del gateway |
   |---|---|
   | `orders` | `ml.orders.search`, `ml.order`, `ml.missed_feeds` |
   | `shipments` | `ml.shipment` |
   | `items` | `ml.items.scan`, `ml.items.multiget` |
   | `questions` | `ml.questions.search`, `ml.question` |
   | `messages` | `ml.messages.unread`, `ml.messages.pack` |
   | `claims` | `ml.claims.search`, `ml.claim` |

   Cada corriente tiene su bucket por minuto (`GATEWAY_ML_SHADOW_RPM_<CORRIENTE>`), y
   `GATEWAY_ML_SHADOW_RPM` sigue como **techo global** encima de todas: una llamada sale sólo si hay
   lugar en su corriente **y** en el global. Sin variable por corriente, la corriente no recibe cupo
   propio (cero = cerrado), igual que hoy la sombra arranca cerrada por defecto. Una operación ML que no
   esté en la tabla es un error de programación (falla el test que recorre `OPERACIONES`).
2. **429 sintético etiquetado.** El 429 del presupuesto devuelve además el header
   `x-fusion-cupo: sombra-agotado` (y `retry-after` con los segundos que faltan para el próximo minuto,
   no un 60 fijo), agregado a `HEADERS_DEVUELTOS`. La plataforma (`transporte-gateway.ts`,
   `relectura.ts`) lo mapea a un código `CUPO_SOMBRA_AGOTADO` distinto de `HTTP_429`:
   - se reintenta en el próximo ciclo **sin consumir intentos** hacia dead letter (no es una falla del
     recurso, es espera propia);
   - el barrido queda `diferido`, no `fallido`, y el reporte diario lo cuenta aparte;
   - un 429 **real** de ML sigue como hoy (`HTTP_429`, cuenta intentos).
3. **Ajuste del tope con medición registrada.** Métrica por corriente (llamadas permitidas / diferidas
   por minuto) desde el `metricas` del gateway. Reparto inicial propuesto sobre el techo global actual
   de 60 rpm (el documentado el 2026-09-17): orders 10, shipments 15, items 15, questions 5, messages 10,
   claims 5. Tras 48 h se registra la medición en `evidence/e1/` y se ajusta con OK de José. El techo
   global nunca supera lo que deja libre el presupuesto del legado (`lib/mlRateLimiter.js`).

## 3. Fuera de alcance (backlog, guía §7)

- Shipments y messages por evento con reconciliación horaria (punto 2).
- Lectura única compartida legado↔plataforma (punto 4, territorio de E9).

## 4. Aceptación del tramo

- Tests dirigidos: buckets independientes (vaciar `shipments` no afecta a `items`), techo global,
  header y `retry-after`, mapeo `CUPO_SOMBRA_AGOTADO` sin dead letter, cobertura de la tabla de corrientes.
- En producción, 24 h con las 6 corrientes con al menos un barrido OK y **cero** dead letters por
  `CUPO_SOMBRA_AGOTADO`.
- Rollback: quitar las variables por corriente y volver al build anterior del legado; el techo global
  sigue funcionando igual que hoy.
- Despliegue de T5 = día 0 de la campaña de 7 días verdes (PM-186).
