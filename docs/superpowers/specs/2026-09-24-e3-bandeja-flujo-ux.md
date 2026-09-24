# E3: flujo de la bandeja de identidad (estados, copy, foco)

**Fecha:** 2026-09-24. **Baja a un flujo implementable** `2026-09-24-e3-bandeja-interfaz.md` (aprobada por José). Lo redactó `disenador-ux`; este archivo lo transcribe desde su informe (el agente no tenía herramienta de escritura), así que si algo no coincide con la spec de la interfaz, **manda la spec**.

## 1. Estados de la pantalla

| Estado | Qué se ve | Anuncio | Foco |
|---|---|---|---|
| Cargando | esqueleto del mismo tamaño que el caso | `status` «Cargando casos» | no se mueve |
| Caso | matriz + candidatos + acciones | `status` «Caso N de M» | encabezado del caso (`tabindex="-1"`) |
| Vacío | «No quedan casos en este filtro» + los chips de otros filtros | `status` | primer chip con casos |
| Error con reintento | aviso persistente «No pudimos cargar los casos» + botón Reintentar | `alert` | botón Reintentar |
| Sin conexión | aviso persistente «Sin conexión. Tus decisiones sin guardar se reintentan solas» | `alert` | no se mueve |
| Apagada (503 `bandeja_apagada`) | «La bandeja está apagada por ahora» | `alert` | encabezado |
| Buscando (`/`) | los resultados entran como columnas de la misma matriz | `status` «N resultados» | campo de búsqueda; `Esc` vuelve al caso |
| Guardando / Guardado | indicador en la banda de estado; **«Guardado» sólo tras el 200** | `status` | no se mueve |
| Conflicto 409 | aviso persistente «Este caso cambió mientras lo revisabas; tu elección se conserva» + matriz actualizada con lo cambiado marcado + botón «Aplicar mi decisión sobre la versión nueva» | `alert` | el caso en conflicto |
| Rechazada | aviso persistente con el copy de §3 | `alert` | el caso |
| Deshaciendo | «Deshaciendo…» | `status` | caso reabierto |

Reglas generales:
- Los avisos de error **no son toasts**: quedan hasta que se resuelven.
- Tras decidir, el foco va al encabezado del caso siguiente; tras un 409, al caso en conflicto; tras deshacer, al caso reabierto. Nunca cae en `body`.
- Cada intento de decisión genera su `Idempotency-Key` (`crypto.randomUUID()`); un reintento del mismo intento **la reutiliza**. Puede haber varias decisiones en vuelo.
- La banda de estado muestra el contador de decisiones sin guardar, y el navegador avisa al cerrar la pestaña si hay guardados pendientes.

## 2. Candidatos y acciones

- Los candidatos van **sin preselección** (decidido por José, P2). `Enter` sin selección no hace nada y anuncia por `alert` «Elegí un candidato antes de vincular».
- Un caso sin candidatos muestra sólo «Buscar otra variante» y «No existe en el catálogo».
- Al elegir, omitir o «no existe» se aplica sin diálogo y aparece el aviso de deshacer.
- **Deshacer** (`z` o el botón del aviso): vale 10 s y sólo sobre la última decisión propia, una sola vez; un segundo `z` anuncia «No hay nada para deshacer». Genera una decisión compensatoria (`revierte`). El servidor lo acepta sin ser admin si la decisión es la vigente, propia, de menos de 60 s y el caso no cambió.
- **409, «Aplicar mi decisión sobre la versión nueva»:** si el candidato elegido desapareció o cambió de marca, no aplica solo: pasa a «Revisar de nuevo» con la matriz nueva.
- Con los atajos apagados también se apaga `z` (todos, sin excepción).

## 3. Copy por código de la API

| Código | Texto |
|---|---|
| `version_conflict` (409) | «Este caso cambió mientras lo revisabas; tu elección se conserva.» |
| `caso_cerrado` (409) | «Este caso ya se resolvió. Pasamos al siguiente.» |
| `revierte_no_vigente` (409) | «Esa decisión ya no es la vigente, no se puede deshacer.» |
| `solo_admin` (403) | «Sólo un administrador puede revertir esto.» |
| `variante_invalida` (422) | «Esa variante ya no está disponible. Elegí otra.» |
| `caso_sin_publicacion` (422) | «Este caso no tiene una publicación única para decidir.» |
| `idempotency_mismatch` (422) | «Se cambió la decisión mientras se reintentaba. Volvé a decidir.» |
| `caso_inexistente` (404) | «Este caso ya no existe.» |
| `bandeja_apagada` (503) | «La bandeja está apagada por ahora.» |
| `plataforma_no_responde` (502) | «La plataforma no responde. Reintentamos solos.» |

## 4. Recorrido «sólo teclado» para `probador-e2e` (11 pasos)

1. Abrir la pantalla; el foco cae en el encabezado del primer caso.
2. `?` abre la ayuda; comprobar el interruptor de atajos; `Esc` cierra.
3. Decidir 5 casos con `1`/`2`/`3` + `Enter`; el foco avanza y hay un anuncio por decisión.
4. `/` busca otra variante; escribir `j`, `s`, `n` en el campo **no** dispara atajos.
5. `s` omite; `n` marca «no existe».
6. `z` deshace dentro de los 10 s; un segundo `z` anuncia que no hay nada.
7. `d` alterna «sólo diferencias»; `f` abre el visor de foto y `Esc` lo cierra.
8. 409 con dos pestañas: decidir el mismo caso en las dos; la segunda muestra el conflicto y la matriz actualizada.
9. Cortar la red: aparece «Sin conexión» y el contador de pendientes; al volver, se guardan.
10. Apagar los atajos desde `?`; comprobar que ninguna tecla de una sola letra actúa.
11. Recargar: la preferencia de atajos apagados persiste (`localStorage`).

## 5. Huecos de la spec y cómo los resuelve este documento

**Decididas por José el 2026-09-24:** P1 → sólo PC con teclado (los botones y el modo angosto quedan de respaldo, igual cumplen 44×44 y sin scroll horizontal); P2 → sin preselección.

**Pendiente de José** (hay un valor por defecto):
- **P3, deshacer contra el guardado en segundo plano:** `revierte` necesita el `decision_id`, que llega recién con el 200. Por defecto, `z` espera al 200 (si el guardado sigue en vuelo, se cancela el envío pendiente; si ya salió, se espera y se revierte).

**Definidos acá con un valor razonable:**
- Motivo opcional al decidir: campo colapsado bajo las acciones (`m` lo abre); no frena el avance.
- `mantener_omision` existe en la API y no está en la spec: se ofrece sólo cuando el caso tiene una omisión vigente del legado (D5), como «Mantener la omisión».
- `h` (historial) figura en la spec §6 pero no en la tabla de teclado §4: se agrega a la tabla.
- `no_decidibles` viene en los contadores: se muestra como un chip informativo «Sin publicación única: N», no navegable.
- «Caso N de M»: M es el **total del filtro** (suma de contadores), no lo cargado.
- `auto_sku_en_sombra`: se muestra como una «sugerencia del sistema» en el candidato que coincide, sin atajo propio; `Enter` no la confirma sola. `d5` se marca en el encabezado del caso («Prioridad: D5»).
- `evidencia`: panel colapsado «Evidencia» con fuente, fecha y campos.
- «Señales que coinciden» = las marcas ✓ y ≈ por atributo (el contrato no trae otra cosa).
- Foco tras un 409: automático sólo si no hay un campo de texto activo; si lo hay, se anuncia por `alert` y no se mueve.

**Sin resolver (fuera de este corte):**
- H7: la reversión de decisiones viejas o ajenas por un admin (diálogo con motivo obligatorio, entrada desde el historial) no tiene pantalla ni copy. La API la soporta; la pantalla de este corte muestra el historial en sólo lectura.
