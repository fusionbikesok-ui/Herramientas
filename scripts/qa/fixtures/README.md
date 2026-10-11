# Fixtures de QA

## catalogo-vinculos.mjs

Siembra casos `QAFX-` para la pantalla "Catálogo y vínculos" en la base de QA
(`/opt/fusionbikes/qa/data/fusion.sqlite`). Nunca toca producción.

```bash
node scripts/qa/fixtures/catalogo-vinculos.mjs              # siembra (idempotente)
node scripts/qa/fixtures/catalogo-vinculos.mjs --limpiar    # borra solo lo sembrado
node scripts/qa/fixtures/catalogo-vinculos.mjs --masivos 70  # + 70 casos abiertos extra (QAFX-M<i>|) para probar "Ver más"
```

`--masivos N` (0..500, default 0; el modo normal no cambia) agrega N casos abiertos `QAFX-M<i>|` con su producto
Woo (`QAFX-SKU-M<i>`, ids 9950001..), publicación ML activa y caso `urgente` sin responsable. `--limpiar` los borra
(prefijo `QAFX-`). Con `--masivos 70` la cola de "abiertos" tiene 76 casos (70 + 6 visibles del fixture; MLA5 va a
intervención), así que la página 1 (`limit=50`) trae 50 y la página 2 (`offset=50`) trae 26. Con la base anonimizada
(~24 casos reales) el total sube en consecuencia.

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
| 8 foto (tecla `f`) | caso `QAFX-MLA8\|` (candidato Woo `QAFX-SKU-8` con `catalogo_cache.img` SVG data URI, sin red) | Elegir con `1` y luego `f` agranda la foto del candidato. Pasos: abrir el caso, el panel busca con el título ML y trae el candidato primero, pulsar `1` para elegirlo, luego `f` |
| 7 destrabar | op `QAFX-op-5` `intervencion`, caso `QAFX-MLA5\|` (tomado por `Matias`, versión 1) | Destrabar: `destrabarOperacionIdentidad` con `expected_version` y `evidence_fingerprint` del caso (`qafx-QAFX-MLA5\|`) y motivo. En QA la op vuelve a `shadow` y el caso a `pendiente` |
| 9 No le corresponde (permitir_unico) | GTIN `7790000000010` (`identificadores_producto`): `QAFX-6` lo tiene `activo` (único GTIN activo del producto) y `QAFX-7` en `conflicto` | En Identidad de productos, abrir el conflicto de ese código en la lista de conflictos ("Ver y resolver") y pulsar "No le corresponde" sobre `QAFX Candado cable 1m` (producto Woo `QAFX-SKU-6`). El backend responde 409 `INVALID_STATE` con `requiere_confirmacion:'permitir_unico'` y la pantalla pide confirmación; al confirmar reenvía con `permitir_unico:true` (200, el GTIN pasa a `incorrecto`). Solo toca el registro local, no ML. `--limpiar` pasa estas filas a `historico` (no se borran: trigger). |

Usuarios sugeridos en QA: admin `Matias`, operador `Miguel` (no admin). Los casos 3, 4 y 7 vienen tomados por `Matias`.

Advertencia: el worker de identidad no despacha estas filas (operaciones en `fallida` / `bloqueada_impacto`).
Pero el pedido `QAFX-ORD-1` cumple la condición de liberación, así que `liberarRetenidasResueltas` (cron) puede
liberarlo solo si el cron corre en QA.
