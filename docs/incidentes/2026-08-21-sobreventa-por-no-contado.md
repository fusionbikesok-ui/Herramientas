# Sobreventa por producto no contado — 2026-08-21

## Qué pasó

La sesión de conteo **14** (Joaco, ZAPATILLAS / Metha) se confirmó el **2026-08-20 15:07 UTC**.
De los **69 productos con stock** de su alcance, **9 nunca se escanearon**. El Contador ajusta
en Woo solo lo que se contó, así que esos 9 quedaron con su stock intacto: **26 unidades
publicadas que nadie verificó**.

Cuatro horas después se vendió una:

| | |
|---|---|
| Producto | **FB-7555** — Zapatillas Metha Cross — Negro / 40 |
| Venta | ML `2000018041223892`, 2026-08-20 19:07 (-04:00) |
| Stock en Woo | 2 al confirmar el conteo → 1 tras la venta |
| Contado en la sesión 14 | **nunca se escaneó** |

## La causa raíz

**El sistema no distingue "lo conté y había 0" de "no llegué a contarlo".** Los dos casos se
ven igual —sin fila en `inventario_conteos`— y al confirmar los dos se tratan igual: no se
toca el stock. Un producto que ya no está físicamente sigue publicado y se vende.

No es un bug de código: es lo que hoy hace el flujo de confirmación. El bloque `sin_stock`
tiene su botón "cerrar en 0"; los del bloque `con_stock` que no se escanean quedan colgados
sin que nada lo señale.

## Alcance — no fue un caso aislado

Las **tres** sesiones confirmadas de la historia tienen el mismo agujero:

| Sesión | Quién | Confirmada | Sin contar | Unidades sin ajustar |
|---|---|---|---|---|
| 8 | Jose | 2026-07-30 | 2 de 16 | 2 |
| 10 | Jose | 2026-08-14 | **13 de 18** | 21 |
| 14 | Joaco | 2026-08-20 | 9 de 69 | 26 |

La sesión 10 es la más grave en proporción: se confirmó habiendo contado **5 de 18** productos
con stock.

## Estado al 2026-08-21 13:40 UTC

Los **9 de la sesión 14 ya están en stock 0** — alguien los ajustó en Woo a mano ese día
~13:38, al detectar la sobreventa.

Siguen expuestas **17 unidades en 13 productos** de las sesiones 8 y 10 (bicicletas Zion y dos
Oakley). El detalle está en `2026-08-21-stock-sin-verificar.csv`, ordenado por stock
descendente, con la columna `Revisar` en `SI` para lo que todavía está publicado.

## Decisión tomada (usuario, 2026-08-21)

1. **Al confirmar, obligar a decidir uno por uno.** No se puede confirmar mientras haya
   productos con stock sin contar. Por cada uno el operario elige *"no había ninguna"* (va a 0)
   o *"no lo revisé"* (no se toca el stock, queda marcado). Con acción masiva para cerrar de a
   muchos.
2. **Lo ya expuesto se revisa a mano** en el depósito, con esta lista. No se ajusta nada
   automáticamente.
