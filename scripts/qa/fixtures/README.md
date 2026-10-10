# Fixtures de QA

## catalogo-vinculos.mjs

Siembra casos `QAFX-` para la pantalla "Catálogo y vínculos" en la base de QA
(`/opt/fusionbikes/qa/data/fusion.sqlite`). Nunca toca producción.

```bash
node scripts/qa/fixtures/catalogo-vinculos.mjs              # siembra (idempotente)
node scripts/qa/fixtures/catalogo-vinculos.mjs --limpiar    # borra solo lo sembrado
```

- Antes de escribir hace un respaldo: `fusion.sqlite.bak-qafx-<ts>` en el mismo directorio.
- Rehúsa rutas de producción (`/opt/fusionbikes/herramientas/data`, por realpath) y cualquier ruta que no sea la de QA.
- `--permitir-copia <ruta>` existe solo para verificar contra una copia temporal; nunca acepta prod.
- Los productos `QAFX` no se borran (trigger de la 082); `--limpiar` los archiva.

Escenarios, con sus claves:

| Caso | Clave / operación | Qué prueba |
|---|---|---|
| 1 veto | caso `QAFX-MLA1\|` (contradicción de color) | "Confirmar igual" (admin) y "Vincular" bloqueado (operador) |
| 2 hermanas | caso `QAFX-MLA2\|11` (2 hermanas activas) | confirmación de hermanas en la tarjeta |
| 3 pausar N | op `QAFX-op-3` `bloqueada_impacto`, caso `QAFX-MLA3\|21` (2 hermanas) | diálogo "Pausar las N" |
| 4 fallida | op `QAFX-op-4` `fallida`, caso `QAFX-MLA4\|` | Reintentar y mapeo del error |
| 5 retenidas | pedidos `QAFX-ORD-1` (liberable, importe 3000) y `QAFX-ORD-2` (no_sincronizar, importe 2300, `se_vuelve_a_retener`) | liberar, y el aviso de "se vuelve a retener" |
| 6 Enter | caso `QAFX-MLA7\|` (candidato único `QAFX-SKU-7`) | Enter como atajo de Vincular |

Usuarios sugeridos en QA: admin `Matias`, operador `Miguel` (no admin). Los casos 3 y 4 vienen tomados por `Matias`.

Advertencia: el worker de identidad no despacha estas filas (operaciones en `fallida` / `bloqueada_impacto`).
Pero el pedido `QAFX-ORD-1` cumple la condición de liberación, así que `liberarRetenidasResueltas` (cron) puede
liberarlo solo si el cron corre en QA.
