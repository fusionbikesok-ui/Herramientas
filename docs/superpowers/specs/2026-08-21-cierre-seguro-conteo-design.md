# Cierre seguro de sesión — Contador de inventario

**Origen:** el incidente del 2026-08-21 (`docs/incidentes/2026-08-21-sobreventa-por-no-contado.md`).
Una venta de ML salió de un producto que el conteo nunca verificó y que seguía publicado con
stock 2.

## El problema, en una frase

**El sistema no distingue "lo conté y había 0" de "no llegué a contarlo".** Los dos casos se
ven igual —sin fila en `inventario_conteos`— y al confirmar los dos dejan el stock intacto.

`POST /sesiones/:id/confirmar` (`routes/inventario.js:657`) recorre **solo**
`inventario_conteos`. Un producto del alcance que nunca se escaneó no tiene fila ahí, así que
para el ajuste **no existe**: se queda publicado con el stock que tenía. Si ya no está
físicamente, se vende.

Esto no es un caso de borde. Las tres sesiones confirmadas de la historia lo tienen; la sesión
10 se confirmó habiendo contado **5 de 18** productos con stock.

## Objetivo

Que sea **imposible confirmar un conteo dejando productos con stock sin decisión**. Cada
producto con stock del alcance termina en uno de dos estados explícitos:

- **contado** — tiene una cantidad (incluido el 0 explícito: "lo busqué, no había ninguna");
- **pendiente de revisar** — el operario dice que no lo revisó. **La sesión queda abierta.**

Lo que desaparece es el tercer estado de hoy, el implícito: *sin decisión, stock intacto,
sesión cerrada*.

## Decisiones tomadas con el usuario (2026-08-21)

1. **Obligar a decidir uno por uno.** No se puede confirmar mientras haya productos con stock
   sin contar.
2. **El operario selecciona cuáles no revisó.** Los demás se pasan a 0 en lote.
3. **Los no revisados no se pueden dejar al aire:** la sesión **queda abierta** con esos
   pendientes y hay que volver a decidir 0 o revisarlos. No hay salida que cierre la sesión
   dejándolos sin verificar.
4. **Lo ya expuesto** (sesiones 8, 10, 14) se revisa a mano con la lista entregada. No se
   ajusta nada automáticamente.

## Alcance del cambio

Más chico de lo que parece: **el backend ya expone todo lo que hace falta**.
`GET /sesiones/:id` ya devuelve `pendientes[]` (con `bloque`, `stock_inicial`, `stock_woo`) y
`resumen.pendientes_con_stock`. No hace falta migración ni columna nueva.

### 1. Gate en `/confirmar` (fail-closed)

Antes de tocar Woo —y antes del reclamo atómico del estado— si hay pendientes del bloque
`con_stock`, responder **409** con la lista, exactamente igual que el gate de `sin_asociar`
que ya existe unas líneas más arriba:

```json
{ "ok": false, "error": "...", "pendientes_con_stock": 9,
  "pendientes": [{ "sku": "FB-7555", "nombre": "...", "stock_woo": 2 }] }
```

El bloque `sin_stock` **no** entra al gate: esos ya están en 0 en Woo, ajustarlos a 0 es un
no-op. Su botón "cerrar en 0" sigue como está.

### 2. Cerrar en 0 productos **con** stock

Hoy `POST /sesiones/:id/cerrar-sin-stock` filtra `bloque='sin_stock'` a propósito. Se necesita
poder cerrar en 0 los del bloque `con_stock` que el operario confirma que no están.

Regla de seguridad, más estricta que la del bloque sin stock: **solo lista explícita de SKUs,
nunca `todos:true`**. Bajar a 0 algo que tenía stock es destructivo — pasa por Woo al
confirmar. Un `todos:true` acá sería el botón que vacía el depósito por cansancio.

### 3. Pantalla de cierre

Al tocar "Confirmar ajuste" con pendientes con stock, en vez del ajuste aparece una pantalla
de cierre con la lista de lo que falta, cada uno con su stock publicado y una casilla:

- **sin tildar** (por defecto) → "no había ninguna", se pasa a 0;
- **tildado "no lo revisé"** → no se toca, queda pendiente.

Dos salidas:
- **Pasar a 0 los no tildados y confirmar** — habilitado solo si no queda ninguno tildado.
- **Guardar y seguir después** — aplica los ceros de los no tildados y **deja la sesión
  abierta** con los tildados como pendientes.

El default sin tildar es deliberado: la acción segura contra sobreventa (bajar a 0) es la que
no requiere esfuerzo, y dejar algo vendible sin verificar exige un acto explícito.

## Criterio de aceptación

1. Una sesión con al menos un pendiente del bloque `con_stock` **no puede confirmarse**:
   `/confirmar` devuelve 409 y **no se llama a Woo ni una vez**. Verificable con un test que
   falle si se saca el gate.
2. `cerrar-en-cero` con lista explícita crea filas con `cantidad=0` para SKUs del bloque
   `con_stock`; con `todos:true` responde 400 y no crea nada.
3. Tras pasar a 0 todos los pendientes con stock, `/confirmar` funciona como hoy.
4. En la pantalla, tildar "no lo revisé" en al menos uno deshabilita confirmar; destildarlos
   todos lo habilita.
5. La suite completa verde y la reproducción del incidente cubierta: una sesión armada como la
   14 (69 con stock, 60 contados) no puede confirmarse.

## Fuera de alcance

- Pausar/despublicar automáticamente lo no revisado (se evaluó; el usuario eligió la sesión
  abierta).
- Reabrir o corregir las sesiones 8, 10 y 14 ya confirmadas.
- Cualquier ajuste automático del stock ya expuesto.
