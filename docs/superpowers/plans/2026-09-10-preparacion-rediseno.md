# Plan específico: rediseño de Preparación

**Fecha:** 2026-09-10
**Estado:** navegación y pantalla del pedido implementadas y desplegadas; "Productos a buscar"
existe como pestaña pero sin marcado; cola sin reloj de corte. Verificado el 2026-09-11.
**Alcance:** jerarquía, navegación y flujo de la pantalla de Preparación, más la pestaña nueva
"Productos a buscar". No toca el modelo de preparaciones ni el escaneo.

Especimen visual: `docs/superpowers/design/2026-09-10-preparacion-propuesta.html`.

## Por qué

La pantalla actual tiene 12 pills del mismo peso que mezclan el trabajo del día con la
configuración. En escritorio ocupan dos filas; en el celular, **siete filas antes del primer
pedido**. No hay foco: en 1440 px el contenido vive en una columna angosta y el 60% de la
pantalla está vacío, mientras la acción principal —"Preparar"— es un botón chico de bajo
contraste. La paleta no era el problema: los tokens de `public/lib/theme.css` se conservan.

## Decisiones tomadas con el usuario

- **La cola se ordena por el reloj de corte.** Los datos ya existen y no se usaban:
  `fecha_despacho_limite` y `estado_despacho` por pedido (ML con 30 min de margen, Flex hasta
  las 17:00, web 15:00). El corte es la firma de la pantalla.
- **Se diseñan escritorio y teléfono en serio**, no uno estirado.
- **Cuatro espacios**, los que ya nombra el plan maestro: Productos a buscar, Pedidos a
  preparar, Listos para despachar, Despachos. Etiquetas, seguimientos, hojas, lotes, perfiles
  de foto y horarios pasan a un menú **Más**.
- **Marcar un producto NO reemplaza al escaneo.** Marcar significa "lo tengo en el carro"; en
  la mesa se escanea cada unidad contra su pedido, como hoy. Es lo que impide cruzar dos
  pedidos del mismo SKU.
- **El marcado es unidad por unidad**, no por SKU: un faltante parcial queda sobre una unidad
  concreta en vez de resolverse después.
- **Dos o más personas preparan en simultáneo.** Cada marca guarda quién la hizo y la vista
  refresca cada ~5 s, para que nadie camine dos veces al mismo estante. La cola general sigue
  con su polling de 25 s.
- **Tamaños de foto por función:** 88 px en Productos a buscar (es el dato de identificación;
  76 px en teléfono), 64 px en la mesa, 44 px en listas compactas.
- **Acción primaria de 56 px de alto**, por encima de los 44 de WCAG, porque se usa con
  guantes. Secundarias 48 px.

## Dependencia: ubicaciones de estante

**No se muestran ubicaciones hasta que la herramienta de conteo quede terminada** (decisión
del usuario, 2026-09-10). Mientras tanto, "Productos a buscar" se ordena por urgencia: primero
lo que espera el pedido que sale antes. Cuando las ubicaciones estén cargadas y sean
confiables, se agrega el recorrido físico y el orden pasa a ser por zona.

El especimen mostraba estantes (A3, C1, B2) y se corrigió: la pantalla no puede prometer un
dato que la base no tiene.

## Modelo de la pestaña nueva

Hoy la lista de recolección se calcula **en el navegador** a partir de la cola y no persiste
nada — es sólo una vista. Marcar exige estado nuevo:

- Tabla de marcas por unidad: SKU, usuario, estado (`en_carro` / `usada` / `devuelta`), fechas.
- La lista se calcula en el backend, no en el cliente, para que dos dispositivos vean lo mismo.
- Una unidad escaneada en la mesa consume una marca `en_carro` de ese SKU.
- Si la cantidad requerida baja por debajo de la marcada, el sobrante se muestra como
  "devolver al estante" en vez de desaparecer en silencio.
- **"No lo encuentro"** es una acción visible: el plan maestro dice que un faltante es
  incidente urgente, no un pendiente escondido. Registra quién avisó, cuándo, y qué pedido
  queda bloqueado.

## El pedido abierto

Es la pantalla donde el operario pasa la mayor parte del tiempo y la única donde un error manda
el producto equivocado. Medido sobre la pantalla actual en un teléfono de 390×844:

- El pedido **recién empieza a los 388 px**: antes hay título, párrafo y las 12 pestañas.
- ~~"Finalizar preparación" intercalado en el medio del checklist~~ — **medición mal
  interpretada.** `.finbar` es `position:sticky; bottom:0`: los 772 px eran su posición pegada
  al borde inferior de la pantalla, no su lugar en el documento. La barra al pie ya estaba
  bien resuelta y el código incluso documenta que se movió ahí a propósito.
- Blancos de toque: "← Cola" 22 px, "Confirmar" 30 px, "Cámara" 33 px, el campo 36 px.
  Ninguno llega a 44, en una pantalla que se usa con guantes.
- El checklist **no muestra foto del producto**: se verifica una bici contra texto y una lista
  de categorías.
- Los requisitos de foto aparecen como `⚠︎ Falta:` en ámbar repetido: se leen como errores,
  no como los pasos que son.

### Bug reproducido: una preparación abierta puede quedar inalcanzable

`en_preparacion` aparece **únicamente** en la tarjeta de la cola, y la pantalla no usa
`pushState` ni hash, así que no hay URL para abrir una preparación. Si el pedido se cae de la
cola mientras está abierto —el envío de ML pasa a `shipped`, el pedido web deja
`lpaandreani`— la preparación queda sin puerta: no está en la cola, no aparece en Historial,
y `abrirDetalle(id)` sólo se invoca desde tarjetas que ya no existen. Reproducido el
2026-09-10: 0 tarjetas, ausente del historial.

**Es el mecanismo que produjo las 38 preparaciones fantasma.** No son basura vieja: son
trabajo encerrado. Lo escaneado y las fotos siguen en la base; falta la puerta.

### Decisiones para esta pantalla

- **URL propia** `/preparacion/pedido/{id}`: recarga, historial del navegador y link directo.
- **Adentro no van las 12 pestañas.** Sólo "← Cola".
- **Los pasos son pasos** (Productos → Fotos → Finalizar), visualmente distintos de la
  navegación, con el hecho en verde y el actual en azul.
- **Foto del producto de 88 px** y unidades como marcas, el mismo lenguaje que "Productos a
  buscar".
- **El campo de escaneo queda fijo al hacer scroll** (decisión del usuario): con guantes y
  varios productos, volver arriba para escanear es incómodo.
- **Las decisiones de embalaje van al paso Fotos** (decisión del usuario): se toman cuando se
  embala de verdad, no compitiendo con el escaneo.
- **Las fotos se muestran como capturas pendientes** con "1 de 3", el ejemplo de qué tiene que
  salir y la hecha en verde con su hora.
- **"Finalizar" al pie**: ya estaba correcto (barra sticky). Sólo sube a 56 px de alto.
- **Si el canal despacha el pedido mientras está abierto** (decisión del usuario): se avisa
  arriba y se deja terminar. La evidencia se guarda igual; nada se pierde.
- **Las 38 encerradas se cierran en lote** con motivo auditado (decisión del usuario),
  conservando lo escaneado y las fotos.

## Las cuatro pestañas: mapeo a las vistas existentes

- **Productos a buscar** → la lista consolidada por producto, que vivía embebida arriba de la
  cola. Ahora tiene vista propia; el marcado unidad por unidad llega después.
- **Pedidos a preparar** → la cola (`pendientes`).
- **Listos para despachar** → `lotes`. Es donde el que despacha arma la salida escaneando los
  paquetes que se lleva (aclaración del usuario, 2026-09-10).
- **Despachos** → la hoja de despachos (`hoja-andreani`; la de ML queda en Más).

Historial y configuración quedan en **Más**, como pide el plan maestro.

### Pendiente: mezclar ML y Web en una salida

`routes/preparacion.js:1127` lo prohíbe explícitamente: *"E4: los lotes congelan una selección
por canal; nunca se mezclan ML y Web/Andreani."* El usuario aclara que en la práctica **sí se
mezclan, bajo condiciones**: cuando son pocos pedidos, entran todos en la misma salida y están
todos preparados. Hay que decidir si se levanta la regla con esas condiciones explícitas —
no como efecto lateral de un cambio de navegación.

## Ciclo de vida de las marcas (decidido)

- **Un pedido que entra a mitad del recorrido suma sus productos a la lista**, sin resetear lo
  ya marcado. La cantidad requerida sube en la próxima actualización.
- **Las marcas que no terminaron en un pedido preparado se sueltan al cierre del día**, y queda
  registrado quién las había hecho. Si no, al día siguiente la lista da por encontrado algo que
  quedó en un carro en un rincón o volvió al estante.

**Cuidado con qué hora se usa.** `despacho_horarios` guarda 15:00 de lunes a viernes, pero esa
es la hora de corte del transporte, no el cierre del local — el maestro menciona que la tienda
cierra a las 19:00. Soltar las marcas a las 15:00 se las borraría a alguien que sigue
trabajando. Se usa el cierre del local, configurable, y explícitamente distinto del corte de
despacho.

## Estado verificado el 2026-09-11

**Hecho:**

- Las **cuatro pestañas** acordadas están en la nav (`public/preparacion/index.html:349-352`),
  con "Más" para etiquetas, seguimientos, hojas, lotes, perfiles y horarios.
- Campo de escaneo fijo, acción primaria de 56 px, blancos de toque de 44+.
- URL propia `?pedido=N`, vista de abiertas, toma de claim y aviso de canal.
- **Devolución de preparaciones canceladas** — ver
  `2026-09-10-devolucion-preparaciones-canceladas.md`. Cierra la deuda de las dos canceladas.

**Falta, con evidencia:**

- **"Productos a buscar" es sólo lectura.** `cargarRecoleccion()` calcula la lista en el
  navegador desde `/pendientes` y no persiste nada: no hay marcado unidad por unidad, no hay
  "No lo encuentro", y dos personas preparando no se ven. Necesita la tabla de marcas.
- **La cola no ordena por el reloj de corte.** `pedidosElegiblesOrdenados`
  (`lib/preparacion.js:357`) ordena ML primero y después por fecha del pedido;
  `fecha_despacho_limite` sólo se muestra como texto dentro de la tarjeta.
- **Nada cierra sola una preparación cuando el canal informa la salida.** Medido el
  2026-09-10: apareció **un fantasma nuevo en un día** (#68966, web, `enviadoandreani`, con 1
  ítem y 3 fotos). Existe cierre automático para el camino de tracking Andreani
  (`routes/preparacion.js:847`), no para ML `shipped` ni para el resto.
- **"Listos para despachar" no tiene por dónde empezar**: ver el plan de historial de
  despachos. `despacho_lotes` sigue en 0 filas.
- **16 de 101 preparaciones de septiembre se despacharon sin verificar** (en agosto fueron 64
  de 141: mejora fuerte, pero sigue siendo 1 de cada 6).

## Implementado y desplegado el 2026-09-10

- `GET /api/preparacion/abiertas` + bloque "Preparaciones abiertas sin terminar" en la cola.
- URL propia `?pedido=N`: recarga, botón atrás y link compartible.
- Toma de claim al abrir desde la vista nueva o por URL, porque las encerradas lo tenían vencido.
- Aviso en el detalle cuando el canal informa que el pedido salió o se canceló.
- 36 preparaciones encerradas cerradas con auditoría; 67 ítems y 29 fotos conservados.

## Deuda que este rediseño no resuelve

- ~~**Dos preparaciones de pedidos ML cancelados** siguen abiertas a propósito~~ — resuelto el
  2026-09-10 con el circuito de devolución: se cierran como `cancelada_devuelta` cuando alguien
  confirma a qué estante volvió el producto. Ver
  `2026-09-10-devolucion-preparaciones-canceladas.md`.
- **Nada cierra sola una preparación cuando el canal informa la salida.** El script limpia lo
  acumulado, pero si no se automatiza el problema vuelve a crecer.
- **El lote reclama a quien aprieta el botón**, no a quien prepara: mandar pedidos desde la
  oficina los deja bloqueados a nombre del que los mandó.
