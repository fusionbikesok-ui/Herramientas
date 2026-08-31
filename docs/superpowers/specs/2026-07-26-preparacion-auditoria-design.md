# Preparación de Pedidos — Ciclo 3: Auditoría por paso ("Actividad")

## Contexto

Sexto de los 6 ciclos de mejora acordados para Preparación de Pedidos (ver
la implementación vigente y la memoria del
proyecto). Ciclos 1 (caché de pedidos) y 2 (concurrencia + refresh automático) ya están en
`master`. Este es el ciclo 3.

**Problema real**: hoy la única autoría que queda registrada en una preparación es
`preparaciones.preparado_por`, escrito una sola vez al completar el pedido entero. Ningún
paso intermedio (escanear un ítem, subir/borrar una foto, marcar embalaje o despacho) deja
rastro de quién lo hizo. Con varios operarios tocando el mismo pedido (cambio de turno a
mitad de la preparación, memoria: `preparacion-pedidos.md`), no hay forma de saber quién hizo
qué sin preguntar de memoria — y si algo sale mal (item mal escaneado, foto que falta), no
hay forma de auditar sin acceso directo a la base.

## Propósito (confirmado con el usuario)

Resolver dos casos de uso, ambos con el mismo mecanismo:
1. **Disputas puntuales**: "¿quién escaneó mal este item?", "¿quién subió/borró esta foto?".
2. **Traspaso entre operarios**: ver qué hizo el turno anterior en un pedido a medio armar,
   no solo quién lo completó.

## Alcance

Registro histórico **completo e inmutable** (no un resumen, no "solo el último estado") de
estas 5 acciones, confirmadas explícitamente con el usuario:
- Escanear o confirmar manualmente un ítem.
- Subir una foto.
- Borrar una foto.
- Marcar embalaje o despacho de un ítem.
- Completar el pedido.

**Fuera de alcance** (decisiones explícitas del usuario, no ambigüedad):
- Los escaneos **rechazados** (código que no corresponde al pedido, o sobrante) **NO** se
  registran — solo los aceptados.
- El chequeo de permisos/roles no cambia; la sección es visible para cualquiera que abra el
  pedido, no solo admin.

## Modelo de datos

Tabla nueva, **solo-inserción** (append-only, nunca se edita ni se borra ninguna fila —
eso es lo que la hace un historial confiable):

```sql
CREATE TABLE IF NOT EXISTS preparacion_eventos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  preparacion_id INTEGER NOT NULL,
  item_id        INTEGER,              -- NULL para eventos del pedido entero (completar)
  tipo           TEXT NOT NULL,        -- 'escaneo' | 'foto_subida' | 'foto_borrada' |
                                       -- 'embalaje' | 'despacho' | 'completado'
  usuario        TEXT,                 -- snapshot del username en ese momento; NULL si
                                       -- fue 100% automático sin actor humano detrás
  detalle_json   TEXT NOT NULL,        -- ver estructura por tipo abajo
  creado_en      TEXT NOT NULL
)
CREATE INDEX IF NOT EXISTS idx_preparacion_eventos_prep ON preparacion_eventos(preparacion_id, id)
```

`usuario` es un **snapshot de texto**, no un `JOIN` contra la tabla de usuarios — si mañana
se renombra o se borra la cuenta, el historial no debe quedar en blanco (requisito explícito
de `disenador-ux`).

### `detalle_json` por tipo

- **`escaneo`**: `{ sku, nombre, cantidad_nueva, cantidad_esperada, origen }` — `origen` ∈
  `'camara' | 'lector_teclado' | 'manual'` (confirmación sin código = `'manual'`).
- **`foto_subida`**: `{ sku, nombre, tipo_foto, nombre_archivo, foto_id, upload_id? }`.
- **`foto_borrada`**: `{ sku, nombre, tipo_foto, nombre_archivo, foto_id, subida_por }` —
  `subida_por` para poder decir "la foto que había subido Fulano".
- **`embalaje`** / **`despacho`**: `{ sku, nombre, valor_anterior, valor_nuevo }`.
- **`completado`**: `{}` (no necesita detalle adicional, el evento en sí ya lo dice todo).

Eventos disparados automáticamente por el sistema (ej. ítem marcado con despacho
`deposito_delegado` por una regla, no por click directo del operario) llevan
`usuario = <quien disparó la acción que lo originó>` y un flag `sistema: true` dentro de
`detalle_json`, para poder mostrar "Sistema (por acción de X)" sin una columna aparte.

### Retención de fotos borradas

Al borrar una foto (`DELETE /:id/foto/:fotoId`), el archivo **ya no se borra del disco de
inmediato** como hoy — se marca la fila de `preparacion_fotos` con una columna nueva
`borrado_en` (no se hace `DELETE` de la fila) y se conserva el archivo físico. Una limpieza
(cron o manual, a definir en el plan) purga archivos con `borrado_en` de más de 60 días.
El historial de "Actividad" puede así seguir mostrando la miniatura de una foto borrada
dentro de esa ventana de 60 días.

## Backend — puntos de instrumentación

Cada uno de los 5 endpoints ya existentes en `routes/preparacion.js` agrega **una fila** a
`preparacion_eventos`, sin cambiar su lógica de negocio actual:
- `POST /:id/escanear` → tipo `escaneo`.
- `POST /:id/foto` → tipo `foto_subida`.
- `DELETE /:id/foto/:fotoId` → tipo `foto_borrada` (y cambia a soft-delete, ver arriba).
- `POST /:id/item/:itemId/embalaje` → tipo `embalaje`.
- `POST /:id/item/:itemId/despacho` → tipo `despacho`.
- `POST /:id/completar` → tipo `completado`.

El registro del evento es **fail-open respecto a la acción principal**: si el `INSERT` en
`preparacion_eventos` fallara por algún motivo, la acción real (escanear, subir foto, etc.)
**no se cancela** — el historial es auxiliar, no debe poder bloquear el trabajo físico de
armar un pedido. En la práctica, al ser un `INSERT` síncrono de better-sqlite3 en la misma
transacción/secuencia que la escritura principal, el caso de fallo aislado es marginal; se
maneja con un `try/catch` alrededor del insert de evento que solo loguea, sin propagar.

`GET /:id` (detalle del pedido) se extiende para devolver también los eventos de esa
preparación (mismo patrón que ya hace con `fotos`), ordenados por `id DESC`, sin paginado en
el backend — el "tope de 30 + Ver más" es de presentación en el frontend.

`POST /:id/heartbeat` (ya existente, cada 15s) se extiende para devolver también el
`id` del último evento conocido por el cliente que lo llama, de modo que el frontend pueda
detectar "hay eventos nuevos" **sin ningún request adicional** — reutiliza el canal que ya
existe.

## Frontend — flujo (definido por `disenador-ux`)

Sección nueva **"Actividad"** (no "Historial" — ese nombre ya lo usa la pestaña global que
lista pedidos completados) al final del detalle del pedido, debajo de la `finbar`:

- **Colapsada por defecto** si `estado != completada` (el operario abrió el pedido para
  *trabajar*, no para auditar) — header `▸ Actividad (12)` clickeable.
- **Expandida por defecto** si `estado == completada` (ahí el job es revisar/auditar).
- El estado de colapso se recuerda **por sesión de navegador**, no por pedido.
- **Chip de acceso rápido** cerca del título/banner de presencia, arriba de la scanbar
  (`Actividad (12)`), que hace scroll suave a la sección y la expande — para el caso "entré
  solo a ver quién tocó esto" sin bajar pasando los ítems.
- Lista cronológica **completa**, más reciente arriba, tope inicial de 30 entradas + botón
  "Ver más" (no paginado numerado, no agrupado/resumido — requisito explícito del usuario).
- Cada entrada muestra (ver detalle exacto en la sección de UI abajo): quién, cuándo
  (relativo + absoluto en tooltip), verbo en lenguaje de depósito, SKU + nombre de producto,
  contador resultante, y el detalle específico según tipo (miniatura para fotos, valor
  anterior→nuevo para embalaje/despacho, origen para escaneo).
- **Actualización sin polling nuevo**: viaja en el heartbeat de presencia ya existente
  (cada 15s). Colapsada → header pasa a `▸ Actividad (12) · 3 nuevos`. Expandida → las
  entradas nuevas se insertan arriba con una marca visual breve, **sin auto-scroll y sin
  re-renderizar el resto del detalle** (no debe interferir con `refrescarDetalle()` ni con
  el foco permanente de la scanbar).
- Las acciones **propias** del operario aparecen de inmediato tras la respuesta del POST,
  no esperan al próximo heartbeat.
- **Estado vacío**: "No hay actividad registrada. El registro empezó el DD/MM/AAAA." (no un
  vacío mudo, para no sugerir falsamente que "nadie tocó nada").
- **Estado de error de carga**: "No se pudo cargar la actividad · Reintentar" —
  **fail-open**, nunca bloquea la preparación en curso (a diferencia del resto de la app,
  que es fail-closed en operaciones de stock/precio).
- **Puente con el banner de presencia**: cuando otro operario del banner genera un evento y
  la sección está colapsada, se reutiliza el `flash()` ya existente para un toast breve
  ("Ana confirmó Bici Venzo R29"). Presencia (banner) y Actividad (sección) quedan
  visualmente separados — tiempos verbales distintos, "quién está" vs. "quién hizo qué".

## Frontend — sistema visual (definido por `disenador-ui`)

Especificación completa entregada por el agente; resumen de las decisiones vinculantes para
`hard-worker-frontend`:

- **Jerarquía de cada entrada**: el **producto** pesa más que el verbo o la persona (el
  operario busca "qué pasó con esta bici", no quién lo hizo primero). Grid `28px 1fr`,
  rail vertical de 1px entre entradas, badge circular de 26px por tipo con forma+color
  distintos (◎ azul escaneo · ✓ verde confirmó sin código · ▣ violeta foto · ⌫ rojo borró ·
  ⬒ ámbar embalaje · ➜ ámbar despacho · ★ verde completó) — doble codificación para
  accesibilidad, no solo color.
- **Header colapsable**: zona de toque `min-height: 56px` (por encima del piso de 44px,
  coherente con memoria de manos ocupadas/guantes en depósito), caret que rota 90°,
  badge `(12)` + `· 3 nuevos` en azul.
- **Chip de acceso rápido**: pill gris neutro (no azul sólido) para no competir
  visualmente con la scanbar ni con "Confirmar" — solo un punto de 7px se pinta azul si hay
  novedades.
- **Foto borrada**: distinguible sin depender solo de color/texto — `grayscale` + opacidad
  reducida + trama diagonal + borde punteado rojo + badge "✕" + texto "(borrada)" +
  `aria-label` (4 canales redundantes, perceptible con cualquier deficiencia cromática).
- **Estados vacío/error**: vacío en tono neutro (no semáforo); error en ámbar (no rojo —
  el rojo queda reservado para lo que sí frena la operación).
- Todo reusa tokens existentes de la paleta del proyecto; los pocos tokens nuevos
  (`--tap-comfort`, `--act-rail`, `--act-deleted-veil`, `--act-deleted-hatch`,
  `--act-new-hold`) deben agregarse al `:root` local de `public/preparacion/index.html`
  (esa página no enlaza `public/lib/theme.css` por un conflicto de nombre en `--amber` — no
  intentar enlazarlo en este ciclo, replicar los tokens con el mismo nombre/valor).
- Contraste verificado AA (≥4.5:1) para todo el texto de la sección sobre los fondos
  usados. **Nota aparte, no bloqueante de este ciclo**: `--muted2` ya usado hoy en
  `.item-sku` da 3.33:1 (no conforme) — no se toca en este ciclo, la sección nueva usa
  `--muted` (5.67:1) en su lugar para todo su texto secundario.
- Mockups de referencia (todos los estados, desktop y mobile) verificados visualmente por
  el orquestador antes de aprobar esta spec.

## Testing

- Backend: cada endpoint instrumentado necesita un test que confirme que el evento
  correspondiente queda insertado con los datos correctos, y que el fallo simulado del
  insert de evento (mock de excepción) no impide que la acción principal se complete.
  Soft-delete de fotos: test de que `DELETE /:id/foto/:fotoId` ya no borra la fila ni el
  archivo, solo marca `borrado_en`, y que el archivo sigue siendo servible mientras dure
  la ventana de retención.
  Purga de fotos borradas: test de la lógica que identifica y elimina archivos con
  `borrado_en` de más de 60 días (el mecanismo exacto — cron nuevo vs. verificación al
  vuelo — se decide en el plan).
- Frontend: no hace falta e2e nuevo dedicado más allá del que ya corre `probador-e2e` sobre
  la pantalla completa tras la implementación (según pipeline estándar del proyecto).

## Fuera de alcance de este ciclo (explícito)

- No se toca la heurística de `kit_transmision` (ciclo 6, sin arrancar).
- No se agrega corrección de tracking erróneo (ciclo 4, sin arrancar).
- No se formaliza la escritura transaccional a Woo (ciclo 5, sin arrancar).
- No se corrige el contraste preexistente de `--muted2` fuera de la sección nueva.
