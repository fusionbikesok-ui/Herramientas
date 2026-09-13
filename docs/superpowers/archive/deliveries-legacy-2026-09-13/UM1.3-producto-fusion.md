# UM1.3 — Producto Fusion completo

**Estado:** planificada. **Dependencia:** UM1.1. **Superficie:** VPS.

## Resultado

Completar la identidad canónica independiente de canales: familias y reglas versionadas, atributos, provisionales, archivo, reserva/transferencia de identificadores y bootstrap desde Woo.

## Gates

- Un máximo de una identidad Woo activa y múltiples claves ML por Producto Fusion.
- `fusion_sku = FB-{id_woo}` y no editable.
- Sólo simples y variaciones Woo `publish|private` son unidades vendibles; padres `variable` quedan fuera y stock cero conserva identidad.
- EAN-8/13, UPC-A y GTIN-14 tipados; máximo un EAN y un UPC activos por unidad y unicidad global. UPC-A/EAN-13 con cero inicial son equivalentes.
- Producto Fusion es autoridad de códigos; Woo proyecta el principal y ML conserva todos los observados tipados.
- Bootstrap idempotente y conciliado sin duplicados.
- Decisiones heredadas aproximadas preservadas solo como historia.
- Identidades verificadas incompletas conservan operación con deuda de catálogo de siete días; vínculos nuevos se bloquean. Cambios de reglas revalidan vínculos.
