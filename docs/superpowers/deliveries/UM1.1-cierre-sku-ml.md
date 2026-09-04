# UM1.1 — Cierre inmediato de publicaciones ML activas con stock y sin SKU válido

**Estado:** desarrollo. **Prioridad:** bloqueante. **Superficie:** VPS/web responsive.
**Base:** `origin/conteo-confiable` observada en `6949f02`; rama `feature/um1-identidad-productos`; worktree `/opt/fusionbikes/worktrees/identidad-productos`.
**Seguridad:** modo `shadow`; no autoriza despliegue, migración productiva ni escrituras reales en ML.

## Resultado y alcance

Crear el núcleo mínimo nuevo y conciliar todas las claves ML activas con stock cuyo `SELLER_SKU` esté ausente, vacío, no exista de forma única en Woo o contradiga un GTIN válido. Cada clave debe quedar verificada, exceptuada explícitamente como `solo_ml`, o visible como urgencia abierta.

## Gates

1. Migración aditiva/idempotente y rollback documentado.
2. Auditoría fresca con `total = verificadas + excepciones + urgentes abiertas`.
3. Ningún caso se resuelve antes de releer ML y verificar SKU y stock.
4. Saga stock cero → limpiar SKU → escribir SKU → restaurar stock cubierta por fallos parciales.
5. Ventas inseguras retenidas y reprocesadas únicamente tras verificación.
6. Revisión, tests, E2E 390/768/1440, canario designado y jornada observada.

## Evidencia

- Implementación: en curso.
- Revisión independiente: pendiente.
- Tests dirigidos/globales: pendiente.
- E2E: pendiente.
- Canario, rollback real y jornada: pendientes externos.
