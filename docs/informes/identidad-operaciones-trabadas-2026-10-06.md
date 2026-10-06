# Operaciones de identidad trabadas: informe para decidir

Datos leídos de producción el 2026-10-06, solo lectura (`identidad_operaciones`, `ml_publicaciones_cache`, `catalogo_cache`).
**No se aplicó ni se canceló nada.** Quedan 20 operaciones sin completar: 1 `bloqueada_impacto` (104) y 19 `pendiente`.

## Resumen

| Grupo | Operaciones | Qué proponemos |
|---|---|---|
| No-op de SKU (SKU anterior = objetivo) | 129, 131–134, 136–144 (14) y la 135 aparte | Cancelar con `scripts/identidad-cancelar-noop.mjs` (dry-run por defecto). La 135 se decide con la 128. |
| Par 128 / 135 | 128, 135 | **Cancelar ambas.** La 128 está mal. |
| Reales | 104, 126, 127, 130 | Ver abajo: 104 y 130 ya parecen aplicadas en ML. |

Por qué las 15 no-op no se ejecutaron nunca: estaban en `pendiente`, paso `zero`, 0 intentos, y el canario las deja afuera.

## Las 4 operaciones reales

### Op 104 — Casco Rembrandt Para Niños (`MLA1116131600|174011478611`)
- SKU anterior: `REM201` → objetivo: `FB-68838` (Woo 68838 «Casco Rembrandt Para Niños — Halcón», stock 1). Stock pedido: 1.
- Estado: `bloqueada_impacto` (4 variaciones hermanas, impacto ya confirmado). Decidió Jose el 2026-09-05.
- **Hoy la publicación en ML ya tiene `seller_sku = FB-68838`, stock ML 1 = stock Woo 1, y el caso figura `verificado`.**
- Recomendación: **cancelar**. El resultado que buscaba ya existe; ejecutarla no cambia nada y la espera por hermanas ya no aplica.

### Op 126 — Palanca Potenciómetro Araña Magene PES P515 **170mm** Negro (`MLA2013471629|`)
- SKU anterior (ML): `FB-67029` «Palanca Potenciometro de Ruta PES 515 - Magene» (stock 1) → objetivo `FB-68103` «… — 170» (stock 1).
- El título de ML dice 170 mm y el objetivo es la variante 170: el cambio es coherente (de la ficha genérica a la variante exacta).
- Caso: `gtin_contradictorio` en `pendiente`. Es la única alerta a mirar: el GTIN de la publicación contradice al de la ficha genérica, lo que respalda ir a la variante.
- Recomendación: **aplicar**, de a una, con el canario, y verificar el SKU en ML después.

### Op 127 — Palanca Medidor De Potencia Magene TEO P515 **160mm** 110bcd Negro (`MLA2014047723|`)
- SKU anterior: `FB-67027` «Palanca Potenciometro para Ruta de Carbono Magene TEO P515» (stock 1) → objetivo `FB-68104` «… — 160» (stock 1).
- Mismo patrón que la 126: el título dice 160 mm y el objetivo es la variante 160. Caso `gtin_contradictorio`, `pendiente`.
- Recomendación: **aplicar**, igual que la 126.

### Op 130 — Descarrilador Trasero Shimano RD-M3100-SGS 9 Velocidades (`MLA1446723717|`)
- SKU anterior: **sin dato** (NULL) → objetivo `FB-5966` «Cambio Trasero Shimano Alivio Sgs M 3100 9V» (stock 1). Stock pedido: 1.
- Caso en `intervencion`.
- **Hoy la publicación ya tiene `seller_sku = FB-5966` y stock ML 1 = stock Woo 1.** «Descarrilador» y «cambio trasero» son el mismo producto (M3100 SGS 9V).
- Recomendación: **cancelar** (ya está aplicada) y cerrar la intervención a mano.

## Par 128 / 135 — mismo disco, una lo cambia y la otra lo revierte (`MLA2815578228|`)

| Op | SKU | Stock pedido | Qué haría |
|---|---|---|---|
| 128 | `FB-53504` → `FB-31402` | **0** | Cambiaría el «Rotor Disco Ezmtb **Centerlock** 180mm» (Woo 53504, stock 50) por «Disco … **6 Tornillos** 138G» (Woo 31402, stock 0) y **dejaría la publicación en 0**. |
| 135 | `FB-53504` → `FB-53504` | 50 | Revierte la 128: mismo SKU, escribe stock 50. |

- El título de ML dice **Centerlock**, que es `FB-53504`. La 128 apunta a otro producto (6 tornillos): está mal.
- Hoy ML ya tiene `seller_sku = FB-53504` y 50 de stock: la 135 no cambia nada.
- Recomendación: **cancelar ambas.** Ninguna debe ejecutarse (la 128 pondría en 0 una publicación con 50).

## No-op de SKU: qué cancela el script

`node scripts/identidad-cancelar-noop.mjs` (dry-run) hoy lista **5** puras (129, 137, 138, 142, 143): piden el stock que ML ya tiene.

Otras **9** (131, 132, 133, 134, 136, 139, 140, 141, 144) tienen el SKU correcto pero un `stock_objetivo` viejo del 12–16/09 que ya no coincide con ML (pedirían 4 donde ML tiene 2, o 3 donde está pausada en 0). Ejecutarlas empujaría stock desactualizado, así que cancelarlas es más seguro que correrlas. Se incluyen con `--incluir-stock-obsoleto` (decisión aparte).

La 135 no entra al script porque comparte clave con la 128.

## Para ejecutar en producción (no se hizo)
1. Backup de la base con `better-sqlite3` (el VPS no tiene `sqlite3`).
2. OK de José.
3. `node scripts/identidad-cancelar-noop.mjs --apply --backup-ok [--incluir-stock-obsoleto]`.
4. Las 104, 130, 128 y 135 se cancelan a mano o con una extensión del script si se decide así.
