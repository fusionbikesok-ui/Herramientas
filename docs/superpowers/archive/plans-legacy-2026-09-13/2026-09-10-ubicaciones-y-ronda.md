# Plan específico: ubicaciones y ronda de conteo

**Fecha:** 2026-09-10
**Estado (verificado el 2026-09-11):** ronda sugerida, foto de ubicación, autorización y
auditoría de diferencias desplegadas. **El mapeo sigue en 0 productos**, que es lo que bloquea
todo lo demás: los cuatro avisos, la corrección al preparar y la devolución de canceladas.

## El punto de partida

La herramienta de conteo está completa y se usa (33 sesiones), pero la parte de ubicaciones
tenía **cero uso**: 0 de 33 sesiones con ubicación, 1 ubicación creada y 0 productos mapeados.
La causa era una sola regla: elegir ubicación era **mutuamente excluyente** con categoría/marca
y obligaba a un barrido completo de la zona. En la tienda se cuenta por marca, así que la
opción quedó muerta. El código que asocia SKU→ubicación al escanear ya existía y estaba bien
cableado; nunca se disparó porque ninguna sesión tenía ubicación.

## Decisiones del usuario (2026-09-10)

- **Se cuenta por marca o categoría**, no recorriendo estanterías.
- **El mapeo se llena aprovechando el conteo**: la marca dice QUÉ se cuenta y la ubicación
  DÓNDE está parado el operario.
- **Control diario = conteo cíclico**: cubrir la tienda entera en el menor tiempo posible.
- **Objetivo: 160 productos por ronda** (~2 h 20 al ritmo real de 52 s por producto; cubre los
  1.596 con stock en unos 10 días hábiles).
- **Hay movimiento real entre depósito y salón, y nadie lo asienta.**
- **Cuando el operario encuentra un producto en otro lado, se le pide un toque**: cuál
  ubicación. Sólo cuando el dato falló.
- Los cuatro avisos son útiles: lo que se movió sin asentar, lo que no se ve hace mucho, lo
  que está en dos lugares sin saber cuánto en cada uno, y lo que no apareció en ningún lado.

## Por qué NO se enciende el libro de movimientos

`stock_movements` está construido —entrada, salida, transferencia, origen y destino,
idempotencia— con **0 filas**, y hay rollout por SKU (`stock_rollout_skus`, 0 habilitados).
Daría cantidades exactas por ubicación, pero **depende exactamente de lo que el usuario dice
que no pasa**: que alguien asiente cada traslado. Si nadie lo hace, el libro queda tan
desactualizado como cualquier otra cosa, con el agravante de que *afirma* un número exacto y
por lo tanto miente con más confianza.

La salida no es pedir que registren, sino **capturar el movimiento del trabajo que ya se
hace**: el conteo para el mapeo inicial, y la preparación para las correcciones.

## Lo implementado y desplegado

1. **Ubicación combinable con categoría/marca.** La ubicación sola sigue siendo barrido
   completo. El anti-solape sólo la considera cuando ella define el alcance: dos personas
   contando marcas distintas en el mismo estante ya no se pisan.
2. **Ronda sugerida** (`GET /api/inventario/ronda-sugerida`) y tarjeta en "Elegir alcance" que
   llena el alcance de un toque. Unidad: marca, o marca+categoría cuando la marca no entra en
   una ronda. Orden por **proporción** sin contar, medida sobre lo que tiene stock — un grupo
   con 86 nuevos sobre 134 obliga a recontar 48 que ya estaban al día, y ese tiempo no avanza
   la cobertura. Usa `SQL_CATALOGO_CONTABLE`, la misma definición que el alcance de la sesión,
   para que el número prometido sea el que la sesión trae.
3. **Foto fechada de ubicación en la consulta rápida.** Cada producto devuelve sus ubicaciones
   con las unidades vistas y **cuándo** se vieron. Sale de unir `inventario_conteos` con la
   ubicación de la sesión: no hizo falta capturar nada nuevo. Siempre viaja `visto_en` para que
   quien la lee decida cuánto confiarle.

4. **Autorización y auditoría de diferencias** (2026-09-10). Tarjeta "Esperan tu autorización"
   para resolver sobrantes —los endpoints existían hacía dos semanas sin pantalla— y sección
   "Faltantes ajustados solos" (`GET /diferencias/aplicadas`) para poder revisar después los
   ajustes que se aplican sin preguntar. Los faltantes siguen aplicándose solos por decisión
   del usuario; lo que cambia es que ahora se ven.

5. **Anti-solape por alcance real** (2026-09-10): compara los SKUs que cada sesión va a contar
   de verdad, en vez de la unión de sus dimensiones. Y el 409 muestra los productos del cruce.

## Pendiente

- **Corrección al preparar:** mostrar la ubicación esperada en "Productos a buscar" y pedir un
  toque cuando el producto no estaba ahí. Depende de que esa pestaña se implemente.
- **Los cuatro avisos**, que necesitan historial: hoy hay 0 productos mapeados.
- **Corregir en Woo la categoría de `FB-2419`, `FB-4751` y `FB-5530`**: son repuestos Shimano
  en CASCOS y hacen chocar cualquier ronda Shimano con cualquier ronda de cascos. Es dato, no
  código, y se toca en Woo — pendiente de decisión del usuario.
- **Decidir qué hacer con los faltantes marcados `requiere_revision`**: hoy se aplican igual
  que el resto. La pantalla los distingue, pero nada los frena.
- **Marcar `principal`** (el campo existe sin usar) en la ubicación con más unidades vistas.

Nada de esto tiene sentido hasta que las rondas empiecen a llenar el mapa.

## El cuello de botella, medido el 2026-09-11

**1 ubicación cargada, 0 productos mapeados.** Ya son tres las funciones que esperan ese dato:
los cuatro avisos, la ubicación esperada en "Productos a buscar", y ahora la confirmación de
devolución de preparaciones canceladas, que no se puede completar sin elegir un estante
(`2026-09-10-devolucion-preparaciones-canceladas.md`).

El primer paso no es código: es que un admin cargue las zonas y estantes reales desde
Conteo → Elegir alcance. A partir de ahí cada ronda y cada devolución llenan el mapa solas.
