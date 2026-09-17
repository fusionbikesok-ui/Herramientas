# E1 C10 — canario Woo cerrado por José (2026-09-17)

- Woo al 100 % desde 10:48:30 UTC; prueba de 5 h iniciada 10:49:23 UTC (`fusion-e1-c10-soak`, log en `/root/e1-c10/20260917T104923Z/`).
- José da el canario de Woo por aprobado a las 14:24 UTC, sin esperar el final de las 5 h.
- Corte: 43 mediciones sanas de 43, 0 abortos, 0 incidentes activos.
- Última medición: `14:20:21 legado=200 plataforma=ok señales[succeeded=51] señal_activa_mas_vieja_s=0 {"recibos":{"ml:excluded:canary_excluded":52,"ml:excluded:unsupported_topic":44,"woo:copied:":64},"incidentes":[]}`
- Un reinicio planificado (12:58:30 UTC, fix del vigía d90a0da), sin impacto.
- No cumple `E1-SOAK-01` (24 h): sigue pendiente. ML sigue excluido hasta después del 23/09 16:00 UTC.
- La copia Woo queda encendida al 100 %; el monitor sigue hasta su fin natural como red de rollback.

## E1-SOAK-01 — dispensa

José decidió el 2026-09-17 que la prueba de 24 h no es necesaria y **aprobó el comportamiento como está** con base en esta corrida. E1-SOAK-01 queda **aceptado por decisión de José (dispensa)**, no cumplido por medición.

## Ensayo de rollback (2026-09-17, aprobado por José)

Registro en el VPS: `/root/e1-c10/rollback-20260917T150732Z.log`; backup `.env` en `/root/env-backup-rollback-20260917T150725Z`.

| Hora UTC | Paso | Resultado |
|---|---|---|
| 15:18:30 | `SOMBRA_COPIA_ENABLED=false` + `pm2 restart herramientas` | `/healthz` 200 en 3 s |
| 15:18–15:29 | observación con copia apagada | 4 recibos ML registrados sin `shadow_status` (antes `excluded/canary_excluded`); ningún webhook Woo en la ventana |
| 15:38:30 | `SOMBRA_COPIA_ENABLED=true` + reinicio | `/healthz` 200 en 2 s; log `[sombra] copia encendida: canales=woo porcentaje=100` |

Rollback ensayado: apagar la copia no afecta la recepción del legado y volver a encenderla restablece el canario.
