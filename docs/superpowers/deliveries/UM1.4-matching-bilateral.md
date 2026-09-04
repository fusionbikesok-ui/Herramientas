# UM1.4 — Matching bilateral y segunda cola

**Estado:** planificada. **Dependencia:** UM1.3. **Superficie:** VPS/web.

## Resultado

Operar las colas ML→Fusion y Woo→ML. Todo Woo vendible con stock debe quedar vinculado, enviado a tarea de publicación con SLA de siete días o excluido explícitamente.

## Gates

- Automatización solo por `SELLER_SKU` textual exacto único o GTIN válido único.
- Conflicto SKU↔GTIN bloqueante.
- Un candidato aproximado explicable; precio y fotos fuera del puntaje.
- Calibración con 200 casos: ≥90% global y ninguna familia elegible <80%.
