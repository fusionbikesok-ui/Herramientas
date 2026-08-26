# Plan: ajuste de stock por delta en confirmación de inventario

## Objetivo

`routes/inventario.js` (`/sesiones/:id/confirmar`) escribe el stock contado como valor
**absoluto** vía `setStockWc` (`lib/wooStock.js:48`, `stock_quantity: cantidad`). Si entre
el momento de contar y el momento de confirmar la sesión se vende una unidad (WC o ML), el
confirm pisa esa venta y resucita la unidad vendida: queda publicada y vendible sin existir
físicamente. Es la causa raíz directa del problema de sobreventa que reporta José.

Duración real de sesiones observadas en producción: 0,1 h a 14,7 h. Volumen: ≥100 pedidos en
30 días con pico 10h-17h, la franja en la que José cuenta. La ventana de carrera es real y
recurrente, no un caso de borde teórico.

## Contrato nuevo

`inventario_sesion_alcance.stock_inicial` ya congela el stock al abrir la sesión (columna
existente, `routes/inventario.js` la puebla en `congelarAlcance`). Con eso:

```
delta        = cantidad_contada - stock_inicial
stock_live   = getStockLiveWc(cfg, db, sku)   // ya existe, lib/wooStock.js:59
stock_final  = max(0, stock_live + delta)
```

- Si nadie tocó el producto: `stock_live == stock_inicial` → `stock_final == cantidad_contada`
  (mismo resultado que hoy).
- Si hubo una venta entre medio: se respeta esa venta.
- Si `getStockLiveWc` falla (red, WC caído): **no se escribe nada**, el ítem queda marcado
  para reintento — mismo criterio fail-closed que ya usa el resto del módulo (ver el
  manejo de `fallidos`/`errores` en el loop de `/confirmar`).
- Si `stock_inicial` es `null` (fila de alcance vieja, previa a esta columna, o alcance no
  congelado por algún camino): fail-closed — no se puede calcular delta sin base, se trata
  igual que un fallo de lectura live.

## Dónde

- `lib/wooStock.js`: nueva función `setStockWcDelta(cfg, db, sku, deltaOrigen, stockInicial)`
  que encapsula la lectura live + cálculo + escritura. No tocar `setStockWc` (la siguen
  usando otros callers: sync ML→WC, reintentos — confirmar con `grep -rn "setStockWc("`
  antes de tocar la firma existente).
- `routes/inventario.js`, función `confirmar` (línea ~739 en adelante): reemplazar la
  llamada a `setStockWc(wooCfg, db, item.sku, item.cantidad)` por la nueva función, pasando
  el `stock_inicial` de `inventario_sesion_alcance` para ese SKU en esa sesión.
- Registrar cuándo `stock_live != stock_inicial` (evento hoy invisible) — reusar
  `inventario_conteos` o loguearlo donde ya se908 acumulan `errores`/diferencias de la
  sesión; no crear tabla nueva para esto, es parte de este fix acotado, no de la Fase 3.

## Freno por sobrante (ajuste al comportamiento del freno, mínimo para este fix)

El plan completo de José separa faltante/sobrante con umbrales de $100.000. Ese diseño
completo es Fase 0 más amplia (tabla `inventario_diferencias`, alertas). **Para este fix
acotado no se implementa el freno todavía** — el alcance es únicamente eliminar la
condición de carrera del ajuste absoluto. Dejarlo explícito para que revisor/tester no lo
busquen como si faltara: es intencional, entra en un fix siguiente.

## Tests

- Caso central: abrir sesión, `stock_inicial=3`, contar 3, simular que entre medio bajó a 2
  en WC (mock de `getStockLiveWc` devolviendo 2), confirmar → debe escribir **2**, no 3.
- Sin cambios externos: `stock_live == stock_inicial` → mismo resultado que el comportamiento
  actual (no debe romper `test/inventario.test.js` ni `test/wooStock.test.js` existentes).
- Delta negativo no debe bajar de 0: `stock_live=0`, faltante grande → resultado 0, no negativo.
- `stock_inicial` null → no se escribe, ítem queda en fallidos con error explícito.
- Fallo de `getStockLiveWc` (excepción) → no se escribe, ítem en fallidos, sesión termina
  `confirmada_con_errores` (comportamiento ya existente del loop, solo verificar que aplica).

## Fuera de alcance (a propósito)

Freno por sobrante grande, tabla de diferencias histórica, alertas de negativo, criticidad,
ubicaciones, etiquetas. Todo eso es el resto del plan de José y se despacha por separado.
