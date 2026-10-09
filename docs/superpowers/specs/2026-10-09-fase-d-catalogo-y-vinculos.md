# Fase D: pantalla única "Catálogo y vínculos"

Fecha: 2026-10-09. Programa: `docs/superpowers/specs/2026-10-03-consolidacion-herramientas.md`, Fase D.
Depende de la Fase C (protección única por Identidad, en `activo` desde el 2026-10-08).
Decisiones de José tomadas en la sesión del 2026-10-09 (citadas en cada regla).

## Objetivo

Una sola pantalla para resolver el vínculo entre publicaciones de ML y productos de Woo, reemplazando a
Matcher, Identidad de productos (incluida su pestaña "Códigos en conflicto"), Guardia ML y la Bandeja E3.
Que un operador resuelva lo simple sin poder romper nada, y José lo dudoso.

## Decisiones

| Tema | Decisión de José |
|---|---|
| Usuarios | Un operador y José ("Ambos"). |
| Permisos | El operador vincula, marca "no sincronizar" y saltea. Solo José (admin) destraba una publicación en intervención y confirma un vínculo con contradicción de atributos. |
| Orden de la cola | Por plata en juego: unidades vendidas en ML en los últimos **30 días** × stock en Woo. Con datos ya disponibles, sin recarga. |
| Pantallas viejas | Se retiran **el mismo día** que sale la nueva. |
| Primera entrega | Caso por caso completo. El lote por familia va en una segunda entrega. |
| Dispositivo | PC o notebook con teclado. En celular se consulta todo y las acciones se hacen con toques, sin atajos. |
| "No sincronizar" | Quien lo hace elige entre 3 variantes (ver R3). |
| Ventas retenidas | Solo "Liberar". "Cancelar" se descarta. |

## Inventario de lo que se reemplaza (verificado en `origin/master`)

| Pantalla vieja | Qué se usa hoy | Dónde queda |
|---|---|---|
| Matcher (`public/matcher/`) | Solo lee `GET /api/matcher/candidatos` | Candidatos del detalle del caso |
| Identidad: Pendientes | Casos, tomar/relevar, decidir, notas, excepción "solo ML" | Pestaña **Casos** |
| Identidad: Productos Fusion | Buscar producto, identificadores, orden | Pestaña **Vínculos** |
| Identidad: Operaciones | Estado de operaciones; reintentar y confirmar impacto (admin) | Pestaña **Ejecución** |
| Identidad: Códigos en conflicto | `marcarIdentificadorIncorrecto`, `resolverConflictoIdentificador` | Tipo de caso dentro de **Casos**, con la misma matriz |
| Identidad: Historial | Consulta | Panel `h` del caso, y "ver historial" en **Vínculos** |
| Guardia ML | Casos (ya retirados en activo) y ventas retenidas | Pestaña **Retenidas** (solo Liberar) |
| Bandeja E3 | UX (teclado, deshacer, sin preselección); escribe solo en Postgres | Se hereda la UX; la escritura a Postgres se abandona |

Endpoints que siguen vivos por otros consumidores y **no** se retiran: `POST /api/matcher/decisiones` y
`push-skus-pendientes*` (los usan `public/sync-detalle` y el inicio), y `/api/v1/identidad-productos`
(fachada móvil). Los procesos de fondo de Guardia (`liberarRetenidasResueltas`) siguen por cron.

## Arquitectura de información

Una pantalla, 4 pestañas.

1. **Casos** (por defecto). La cola a la izquierda y el detalle a la derecha. Filtros: Abiertos, Salteados, En
   intervención, Pausadas.
2. **Vínculos.** Buscador por producto Woo o publicación ML. Muestra el vínculo vigente, las hermanas por SKU y por
   GTIN, y las notas. Permite revincular con la misma matriz, y revertir un "no sincronizar" (según R3).
3. **Ejecución.** Operaciones en ML: encolada → aplicada, fallida o frenada. Un contador muestra las fallidas.
   Reintentar y confirmar impacto son solo de admin.
4. **Retenidas.** Ventas retenidas, con Liberar y motivo obligatorio. Aviso de que se liberan solas cada 5 minutos
   cuando la causa se resuelve.

## Reglas

### R1. Cola

- Cada fila muestra: título, motivo del caso, plata en juego, y chips PAUSADA, HERMANAS n e INTERVENCIÓN.
- Orden descendente por `unidades ML 30 días × stock Woo`. Con empate, primero el caso más antiguo.
- Fuente de ventas: `gestion_pedidos` + `gestion_pedido_items` con fuente `mercadolibre` (SKU y cantidad). Si el
  plan encuentra una fuente mejor con la misma cobertura, la documenta.
- Saltear (`s`) manda el caso al final y lo marca "salteado por X". No resuelve nada.

### R2. Detalle y matriz por atributo

- Arriba, el efecto actual en ML: "Hoy está en stock 0 (regla …)" o "Hoy vende con stock N".
- Matriz: columnas Atributo, Publicación ML, Producto Woo y Estado. Filas: título, SKU, GTIN, color, talle,
  rodado, transmisión y velocidades.
- Fuentes: `obtenerCasoIdentidad`, `atributosMlLegibles`, `atributosLegibles` y `contradiccionDeClave`.
- Semáforo:
  - **Rojo (veto):** el campo está en `motivos`, o sea los dos lados tienen valor y difieren.
  - **Ámbar:** falta el dato de un lado, o difiere solo en el formato.
  - **Verde:** coincide después de normalizar.
  - **Gris:** no aplica al producto.
- El estado nunca se indica solo con color: siempre va con ícono y texto ("Difiere", "Falta", "Coincide").
- SKU igual con GTIN o título contradictorio se rotula "leve: sigue vendiendo" (R2 de la Fase C).
- Candidatos sin preselección. Elegir uno (1/2/3) recalcula la matriz.

### R3. Acciones

| Acción | Quién | Qué hace |
|---|---|---|
| Vincular | Operador y José | `decidirCasoIdentidad`. Con rojo, deshabilitado y con la razón a la vista. |
| Confirmar igual | Solo José | Vincula pese al veto. Motivo obligatorio. |
| No sincronizar | Operador y José | Pide motivo y una de 3 variantes: **(a)** solo marcar, el sistema deja de tocarle el stock, no retiene ventas y cualquiera lo revierte; **(b)** marcar y pausar en ML; **(c)** solo marcar, y revertir queda solo para admin. |
| Saltear | Operador y José | R1. |
| Destrabar | Solo José | Saca de intervención con motivo; el stock se reevalúa por las reglas de la Fase C. |
| Reintentar / confirmar impacto | Solo José | Pestaña Ejecución. |
| Liberar retenida | Operador y José | Motivo obligatorio. Si la causa sigue, avisa "Se va a volver a retener". |

Cada intento de escritura lleva su `Idempotency-Key`; un reintento la reutiliza y un intento nuevo usa otra.
"Guardado" aparece solo después del 200. Deshacer (`z`) dentro de 10 segundos manda una decisión compensatoria,
solo sobre la última propia y una sola vez.

### R4. Casos especiales

- **Publicación pausada:** se vincula igual. Si ML ya tiene ese SKU, se actualiza el vínculo local y se cierra el
  caso ("Vínculo actualizado. ML ya tenía este SKU"). Requiere el cambio de `decidirCasoIdentidad` del PR en curso
  (SIN_CAMBIO_SKU con publicación pausada).
- **Hermanas** (`SIBLING_IMPACT_CONFIRMATION_REQUIRED`): confirmación en la misma tarjeta con la lista de
  hermanas, "Vincular las n" y "Volver".
- **Intervención:** el operador lo ve en solo lectura, con candado y "Lo destraba José".
- **Operación fallida o frenada:** tarjeta roja y fija con el motivo y la acción siguiente. Si hay ventas retenidas
  del mismo ítem, un enlace lleva a Retenidas.

### R5. Estados y errores

Estados: cargando, cola vacía ("No hay casos abiertos"), caso, rojo, intervención, guardando, guardado (solo
después del 200), conflicto 409 ("Alguien cambió este caso" con "Aplicar mi decisión sobre la versión nueva"),
rechazada, error de carga con Reintentar, sin conexión (banner fijo y acciones bloqueadas) y deshaciendo. Los
errores quedan fijos hasta resolverse; no son toasts.

| Código API | Mensaje |
|---|---|
| `NOT_FOUND` | Este caso ya no existe. Se resolvió o lo sacaron. |
| `INVALID_INPUT` | Falta completar un dato. Revisá lo marcado. |
| `omitir_requiere_override` | No sincronizar necesita un motivo. |
| `contradiccion_titulo` | No se puede vincular: difiere {campos}. Lo confirma José. |
| `SIBLING_IMPACT_CONFIRMATION_REQUIRED` | Esto cambia también {n} publicaciones hermanas. ¿Seguimos? |
| `SIN_CAMBIO_SKU` | Activa: ML ya tiene este SKU, no hay nada que cambiar. Pausada: Vínculo actualizado, ML ya tenía este SKU. |
| `OPERACION_DUPLICADA` | Ya se mandó este cambio. Mirá su estado en Ejecución. |
| 403 | Esto lo hace José. |
| Red | Sin conexión. No se guardó nada. |
| Operación encolada / aplicada / fallida / frenada | En cola para ML / Aplicada en ML / ML la rechazó: {motivo}. Reintenta José. / Frenada: {regla}. Stock en 0 hasta resolver. |

### R6. Teclado (escritorio)

1/2/3 elegir candidato, Enter vincular, `s` saltear, `n` no sincronizar, `/` buscar otra variante, `z` deshacer,
`d` solo diferencias, `f` foto, `h` historial, `?` atajos (apagables, preferencia guardada en el navegador).
En celular no hay atajos: las mismas acciones son botones.

### R7. Retiro de las pantallas viejas

El mismo día del despliegue: Matcher, Identidad, Guardia y Bandeja redirigen a la pantalla nueva; se sacan sus
tarjetas del inicio y se agrega la de "Catálogo y vínculos". Antes del despliegue se recorre la tabla de
inventario como checklist: cada acción vieja tiene su equivalente o está descartada en esta spec.

## Criterios de aceptación

1. La cola sale ordenada por unidades 30 días × stock, descendente; con empate, el caso más antiguo primero.
2. Un operador no ve Destrabar, Confirmar igual ni Reintentar, y un POST directo a esas acciones devuelve 403.
3. Con un veto rojo, Vincular está deshabilitado y la razón aparece en texto.
4. "Guardado" no aparece antes del 200; un reintento usa la misma `Idempotency-Key`.
5. Una publicación pausada cuyo SKU en ML ya es el objetivo se vincula y el caso se cierra.
6. Un caso con hermanas pide confirmación con la cantidad correcta.
7. El estado de ejecución pasa de encolada a aplicada sin recargar; una fallida queda roja y fija.
8. "No sincronizar" exige motivo y variante; la variante (b) pausa en ML; la (c) no deja revertir a un operador.
9. Liberar una retenida exige motivo y queda registrado.
10. Ningún estado depende solo del color. A 360 px la cola y el detalle se apilan sin nada oculto.
11. Las pantallas viejas redirigen y ninguna acción del inventario queda sin equivalente.
12. Recorrido E2E de teclado (con operador y con admin): foco en el primer caso → `2` → `d` → `f` → `h`/Esc →
    Enter (encolada) → `z` → `s` → `n` sin motivo da error y con motivo guarda → caso rojo: Enter no hace nada y
    como admin "Confirmar igual" exige motivo → `/` y `?` → hermanas: modal, Tab, Esc → Retenidas: liberar →
    sin red: banner y acciones bloqueadas → 360 px.

## Fuera de alcance

- Lote por familia (segunda entrega).
- Confirmar stock compartido (hoy no tiene pantalla).
- Cancelar venta retenida.
- Ventas de 90 días.
- Log de eventos de decisiones como fuente del set dorado.
