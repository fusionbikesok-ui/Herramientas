# Matcher unificado: una sola herramienta de vínculos, en las dos direcciones

Fecha: 2026-08-11 · **Retomado el 2026-08-14**
Rama: `worktree-matcher-unificado-v2`, en el worktree `.claude/worktrees/matcher-unificado`
(base `9681c9b` = master local + Seguimientos)

> **Nota al retomar (2026-08-14).** La rama original (`worktree-matcher-unificado`, base
> `3ba2140`) quedó tres commits atrás y se abandonó: rebasar arrastraba un conflicto en
> `docs/api-contrato.md`, que cambió en las entregas de Preparación y Seguimientos. Este
> worktree parte del trabajo actual.
>
> **El punto 1 del alcance (conflicto de marca) YA SE ENTREGÓ** en el commit `2164283`, que
> está en producción: de 74 falsos a 4, con los dos límites documentados (menciones de
> compatibilidad y marcas madre tipo Bontrager/Trek). Se deja escrito abajo como registro,
> pero **no hay que volver a hacerlo**.
>
> Lo que queda de esta entrega: **el motor unificado (2), la pantalla única (3) y el retiro
> de lo que reemplaza (4)**.

## Por qué

Hoy hay **dos herramientas de tamaño casi idéntico haciendo el mismo trabajo en direcciones
opuestas**:

| | Matcher (ML→WC) | Cobertura (WC→ML) |
|---|---|---|
| Líneas | 2404 | 2334 |
| Parte de | una publicación sin SKU | un producto sin publicación |
| Motor | `getCandidatos` (bolsa de palabras + bonus color/talle) | `candidatosDeWC` (tokens discriminantes, confianza, conflicto de marca) |

Ya comparten la tabla `sku_matcher_decisiones`, la caché `ml_publicaciones_cache`, el mecanismo
de push (`pushSkusPendientes`) y, desde el 2026-08-10, el candado de refresco.

**El argumento decisivo no es estético.** El Matcher no tiene ninguna de las defensas que se
construyeron para Cobertura: ni peso de tokens discriminantes, ni diff estructurado, ni los tres
niveles de confianza, ni fricción en los dudosos, ni conflicto de marca. Portarlas por separado
crearía **una segunda copia** del cálculo de confianza, del resaltado y de la fricción — que es
exactamente el patrón que se eliminó dos veces el 2026-08-10 (el frontend recalculando la
confianza, y los dos motores divergiendo), y las dos veces era una fuente de errores futuros.
**Si hay que tocar el Matcher igual, unificar sale más barato que portar.**

### Lo que la auditoría de los vínculos existentes mostró

Se auditaron los **2619 vínculos ya hechos** con el motor nuevo:
- **74 (2,8%) darían conflicto de marca**, pero **70 de esos 74 son falsas alarmas**: el título
  de ML simplemente no menciona la marca ("Cámara Chaoyang R29" vs "Cámara Bicicleta Rodado 29").
  Solo 4 mencionan otra marca, y hasta esos se explican ("Para Shimano y Tektro" es
  compatibilidad; **Bontrager es la marca propia de Trek**).
- 1733 (66,2%) tienen alguna contradicción de discriminante — consistente con la tasa de
  confianza `alta` del 23,6%.
- **No hay evidencia de errores masivos** en el trabajo ya hecho con el motor viejo.

## Decisiones del usuario (entrevista completa, nada asumido)

**Forma**
- **Una sola herramienta**, con las dos direcciones adentro. Se llama **Matcher**; Cobertura
  pasa a ser una de sus vistas. La URL `/cobertura` **no** necesita seguir funcionando.
- **La dirección se elige al entrar**: "productos sin publicación" (693) o "publicaciones sin
  producto" (3638), cada una con su cola.
- **Todas** las secciones de Cobertura se mudan: Hay que publicarlo, Sin stock,
  Multi-publicación y Problemas.
- Los filtros propios del Matcher (`necesitan atención`, `sin mapeo`) **se reemplazan por la cola
  priorizada** — si la cola hace bien su trabajo, dejan de hacer falta.

**Prioridad del lado ML→WC**, las cuatro señales: publicaciones **activas y vendiendo** primero
(una activa sin SKU es la que puede sobrevender sin que se vea), **las más nuevas**, **las que
tienen stock cargado**, y **agrupadas por marca** igual que del otro lado.

**Huérfanos** (decisiones que apuntan a publicaciones que ya no existen): **las dos cosas** —
que se limpien solas y avisen, **y** que exista la sección para entrar a mirarlas.

**Push masivo de SKUs:** **automático e invisible.** Ya corre solo cada 10 minutos; el botón
desaparece y solo se ve un contador **si hay algo trabado**.

**Las 2362 omitidas:** fuera del trabajo normal, **pero con una sección para revisarlas** cuando
se quiera.

**Revisar lo que quedó mal:** las tres formas — buscar un producto puntual, recorrer el listado,
y mirar los que el sistema marca como problemáticos.

**Permisos**
- **Un solo permiso** (`matcher`) para toda la herramienta. Joaco, que hoy tiene `matcher` pero
  no `cobertura`, **pasa a tener acceso a todo**.
- **Excepción:** pausar una publicación y desvincular son **solo para administradores**. Joaco
  entra a toda la herramienta y trabaja la cola completa, pero esas dos acciones le quedan
  bloqueadas. *(Interpretación de dos respuestas que se tensionan entre sí — confirmada con el
  usuario.)*

**Entrega:** **todo junto**, una sola entrega, como la vez anterior.

## Decisiones nuevas del usuario (2026-08-14, tras el diseño de flujo)

El diseño de flujo encontró que **son tres herramientas, no dos**: existe además
`public/vinculos/index.html` (704 líneas, montada en `/vinculos`), con las pestañas *Buscar
producto* y *Sospechosos* más reasignar/desvincular. El plan original la daba por
descartable, pero es justamente la que cubre "revisar lo que quedó mal", que el usuario
marcó como no negociable. Se le preguntó y decidió:

- **Vínculos se absorbe dentro del Matcher.** Sus dos pestañas pasan a ser secciones;
  *Sospechosos* se junta con *Problemas*, que es el mismo tipo de trabajo ("cosas que el
  sistema marca como raras", no un flujo de decidir sí/no). No se reconstruye: se mueve lo
  que ya funciona, incluidas las dos acciones admin-only.

- **Publicación de ML sin ningún producto candidato en la web: se ofrecen las dos salidas y
  elige el operario, caso por caso.** Esto completa la simetría que faltaba:

  | | Falta del otro lado | Nunca corresponde |
  |---|---|---|
  | **Producto de Woo → ML** | "Hay que publicarlo" | "Solo local" |
  | **Publicación de ML → Woo** | **"Hay que crearlo en la web"** | **"Solo ML"** |

  Las dos de la fila nueva son secciones nuevas. No se elige una por diseño porque los dos
  casos son reales: hay huecos del catálogo web que conviene llenar, y hay cosas que se
  venden únicamente en ML.

- **El push de SKUs lleva una línea calma siempre visible**, no invisible: texto chico y
  mudo ("sincronizando sola cada 10 min · SKUs al día") en el mismo lugar donde hoy va
  "última actualización", y ese mismo renglón pasa a aviso si hay algo trabado. El motivo es
  el que planteó el diseño: algo que desaparece cuando todo está bien deja sin dónde mirar
  el día que alguien dude de si sigue funcionando — y Joaco no participó de estas
  decisiones.

- **`/cobertura` y `/vinculos` redirigen al Matcher con un aviso** de que la herramienta se
  unificó. Un acceso directo viejo no puede terminar en un 404 crudo.

## Las dos entregas (decidido el 2026-08-14)

Se corta **por valor**, no por capa: cada entrega tiene que ser una mejora usable sola.

**Entrega 1 — la herramienta se unifica y Joaco entra.** Dirección **Woo→ML**, la que hoy ya
funciona y está desplegada. Incluye: permiso único `matcher` (Joaco gana acceso a la cola de
cobertura), absorción de Vínculos (Buscar + Sospechosos + las dos acciones admin-only),
sesión por usuario, concurrencia optimista, chips persistentes, línea calma del push y
redirects con aviso desde `/cobertura` y `/vinculos`.

**Ya se llama Matcher, y la dirección ML→Woo aparece deshabilitada con un "próximamente"**
(decisión del usuario). Así el rebautizo pasa una sola vez y la pantalla de elegir dirección
no queda coja.

Vale sola: Joaco gana trabajo que hoy no puede hacer, hay una herramienta menos donde buscar,
revisar lo que quedó mal deja de vivir aparte, y dos personas pueden trabajar sin pisarse. Y
**no toca el motor ML→Woo**, así que lo que Joaco usa a diario queda idéntico hasta que el
motor esté probado.

**Entrega 2 — la dirección ML→Woo con el motor unificado.** Cuando el motor llegue a la vara
(no antes: ver abajo). El Matcher gana las defensas que hoy no tiene y la cola priorizada
reemplaza la carga por Excel. Acá va el aviso de primera visita.

**La vara del motor no se negocia:** no puede recuperar menos vínculos reales que el motor
viejo (95,0% en top-8 sobre 2634 pares). Se itera hasta alcanzarla; no hay plan B de dos
motores.

Todo el riesgo incierto queda en la entrega 2, y la entrega 1 puede salir sin depender de él.

## Alcance

### 1. ~~Corrección pendiente: el conflicto de marca~~ — YA ENTREGADO (`2164283`)

**No rehacer.** Queda el registro de qué era y cómo se resolvió, porque el resultado
condiciona el motor unificado: el conflicto de marca ya cuenta solo cuando el título de ML
menciona **otra** marca conocida, y `marcaEnConflicto` **lanza** si recibe la lista de marcas
sin filtrar por `otrasMarcasPosibles` (error que se cometió midiendo y devolvía resultados
plausibles pero falsos). Al unificar, ese contrato se respeta tal cual.


**Defecto real, introducido el 2026-08-10 y ya desplegado.** `marcaEnConflicto` marca conflicto
cuando la marca de WC no aparece en el título de ML — pero **la mitad de los títulos de ML omiten
la marca**, así que marca "poco parecido" en coincidencias correctas. Medido: 70 de 74 casos son
falsas alarmas.

No es peligroso (el error es conservador: pide un toque de más, nunca vincula mal), pero rompe la
señal — si el rojo aparece cuando no corresponde, se deja de creerle.

**Arreglo:** el conflicto de marca cuenta **solo cuando el título de ML menciona OTRA marca
conocida**, no cuando la omite. Ojo con el caso Bontrager/Trek: hay marcas propias que pertenecen
a otra marca, así que "menciona otra marca" no puede ser una comparación ingenua contra la lista
de marcas. Revalidar contra los 2619 pares y reportar la curva.

### 2. El motor, unificado

Un solo camino de puntuación y confianza para las dos direcciones. `getCandidatos` (ML→WC) tiene
que pasar por las mismas defensas: tokens discriminantes, diff estructurado, tres niveles de
confianza, conflicto de marca, stoplist de relleno.

**Cuidado:** el desempate por color/talle de `candidatosDeWC` y el bonus de color/talle de
`getCandidatos` resuelven el mismo problema por caminos distintos. Unificarlos, no dejar los dos.

#### Lo que falta del lado ML→WC para poder unificar (medido el 2026-08-14)

Las dos funciones tienen **la misma forma** (tokenizar, contar contra el índice, top-50,
puntuar con `tsr`, ordenar, top-8), así que la unificación es viable. Pero el lado viejo no
tiene con qué alimentar las defensas nuevas:

- **`construirWC` no calcula `df` ni `corpusSize` ni el set de `tokens` por ítem**
  (`lib/matcherEngine.js:87-101`), y `diffTokens` los necesita para saber qué token es
  discriminante. `construirML` sí los calcula. Sin esto no hay tokens discriminantes ni
  contradicción del lado ML→WC.
- **Los ítems de `construirWC` no traen la marca.** El conflicto de marca no puede evaluarse
  sin ella.
- **La asimetría que rompe una optimización existente:** en WC→ML la marca fija es la del
  producto de Woo, así que `otrasMarcasPosibles()` se calcula **una vez** por producto — el
  revisor midió que hacerlo dentro del loop costaba +30% por página. En ML→WC la marca fija
  está del lado de ML y **cada candidato de Woo tiene la suya**, así que ese cálculo cae
  dentro del loop. Hay que resolverlo (cachear por marca, o precalcular el conjunto una vez
  para todas las marcas del catálogo), no descubrirlo cuando la página se ponga lenta.

**El orden de resultados va a cambiar en ML→WC, y está bien.** Hoy `getCandidatos` ordena
**primero por coincidencia de color/talle** y recién después por score, y mete el bonus
**dentro** del score (`sm * (1 + bonus) / 2` en variantes). El motor nuevo ordena por
confianza, después score, y usa color/talle **solo como último desempate**, sin tocar el
score. Es el cambio buscado — un candidato con score alto pero con contradicción no puede
ganarle a uno limpio más bajo—, pero hay que decirlo en vez de que aparezca como "el matcher
ahora ordena raro".

### 3. La pantalla

Una sola, con la tarjeta de comparación ya diseñada y probada, funcionando en las dos
direcciones (producto→publicación y publicación→producto). El flujo de Cobertura
(`docs/superpowers/plans/2026-08-10-cobertura-flujo-ux.md`) es la base: elegir dirección, elegir
marca, resolver de a una, progreso de dos niveles, historial con deshacer.

### 4. Lo que se retira

`public/vinculos/index.html` y las rutas del Matcher que la cola priorizada reemplaza. **No se
retira nada sin verificar** que su función esté cubierta.

### 5. Pendientes de Cobertura que se absorben acá

Quedaron abiertos de la entrega de Cobertura (`3ba2140`) y se arreglan en esta, porque esa
pantalla pasa a ser una vista del Matcher y hacerlos por separado sería trabajo tirado:

- **`cobertura_sesion` es global, no por usuario.** Con Cobertura sola y un solo usuario no
  molestaba. **Con este cambio deja de ser menor:** Joaco pasa a tener acceso, así que dos
  personas trabajando la cola al mismo tiempo compartirían una única sesión — se pisarían el
  "seguir donde quedé" y el progreso mutuamente. Tiene que ser por usuario.
- **"Seguir donde quedé" muestra solo lo pendiente, no el progreso.** Al entrar conviene ver
  lo hecho, no solo lo que falta: es la diferencia entre sentir que avanzás y sentir que la
  pila no baja.
- **El encabezado se parte a 375px.** Se usa desde el celular.

### Dónde caen las dos salidas nuevas (resuelto por simetría, 2026-08-14)

El diseño visual marcó que las dos secciones nuevas no estaban en la lista de chips. Se
resuelve mirando qué hace hoy su equivalente, no inventando:

- **"Solo local" no es una sección con chip:** es una **exclusión terminal**
  (`cobertura_exclusiones` con `motivo='solo_local'`, `routes/cobertura.js:342`). Saca el
  producto del universo y no genera trabajo pendiente. Por lo tanto **"Solo ML" tampoco
  lleva chip**: es su espejo exacto, una exclusión, visible desde la superficie de revisión
  junto con las demás.
- **"Hay que crearlo en la web" sí es cola de trabajo**, igual que "Hay que publicarlo": son
  huecos del catálogo que alguien tiene que llenar.

**Y eso resuelve el problema de espacio en la tira de chips:** las dos colas son
**excluyentes por dirección** — "Hay que publicarlo" solo aplica trabajando de Woo hacia ML,
y "Hay que crearlo en la web" solo al revés. Se muestra **la que corresponde a la dirección
activa**, así que los chips frecuentes siguen siendo cuatro y no cinco. No hay que apretar
nada en 375px.

## Flujo cerrado (diseño, 2026-08-14)

- **La entrada no es un peaje.** Arriba, "Seguir donde quedé" (por usuario y por dirección)
  resuelve el caso normal en un toque. Debajo, **las dos direcciones siempre visibles con su
  conteo**, para que nunca se esconda que hay trabajo del otro lado. Cambiar de dirección a
  mitad de sesión es un click desde el subheader, no "volver, elegir, entrar de nuevo".
- **La tarjeta NO se espeja según la dirección.** Web siempre en el mismo lugar, ML siempre
  en el mismo lugar; lo único que cambia es cuál lado está fijo y cuál es candidato. Quien
  alterna entre direcciones no tiene que reaprender dónde mirar. Es la decisión de diseño
  más importante de la entrega.
- **La tira de chips de secciones es persistente**, visible sobre la cola y sobre cualquier
  vista secundaria (hoy en Cobertura solo vive en la entrada, y para ir de Historial a
  Multi-publicación hay que volver al inicio). Cuatro chips de uso frecuente sueltos y los
  dos de uso raro (Huérfanos, Omitidas) detrás de "Más".
- **El buscador puntual es un ícono fijo en la barra superior**, alcanzable desde cualquier
  pantalla: es la más frecuente de las tres formas de revisar.
- **Dos personas sobre el mismo ítem: concurrencia optimista, sin locks.** Al confirmar, el
  backend revalida que siga pendiente; si otro lo resolvió, la respuesta dice **quién y qué
  decidió**, y la pantalla muestra "Ya lo resolvió Fulano: vinculado a MLA123 [Ver]
  [Deshacer]" y avanza sola. Un lock por ítem es sobre-ingeniería para dos personas y deja
  candados huérfanos si alguien cierra la pestaña. Esto además cubre gratis el caso más
  común: la misma persona con el celular y la compu abiertos a la vez.
- **Aviso de primera visita.** El Matcher viejo tiene un paso de carga (Excel/API) que
  desaparece por completo — no es solo otra pantalla, es que **deja de existir una decisión
  que Joaco toma hoy**. Sin un cartel de primera visita que diga "ya no subís nada, la cola
  se arma sola", el primer día va a buscar el dropzone y no lo va a encontrar.
- **Publicación que se borró en ML mientras estaba en la cola:** decirlo y avanzar ("ya no
  existe, se movió a Huérfanos"), nunca dejar la tarjeta rota.
- **Acciones admin-only (pausar, desvincular) se muestran deshabilitadas con el motivo**, no
  ocultas: si Joaco no las ve, va a creer que es un bug.

## Riesgos

1. **Es la segunda reestructuración grande en dos días**, sobre una herramienta que el usuario
   usa para trabajar. El Matcher hoy **funciona**: se retira algo que anda para poner algo nuevo.
2. **Joaco usa el Matcher.** Un cambio de pantalla lo afecta directo y no participó de las
   decisiones. *Planteado al usuario: avisa él. No se frena por esto, pero queda escrito que la
   herramienta se rediseñó sin consultar a uno de sus dos usuarios.*
3. Los 3184 vínculos existentes se hicieron con el motor viejo. Cambiar el motor **no** los
   toca, pero sí cambia cómo se ven los que se revisen de ahora en más.

## Regla de despliegue

`npm test` verde + revisor OK + `probador-e2e` + auditor 🟢. Toca UX y UI, así que van
`disenador-ux` y `disenador-ui` antes del código. Merge y `pm2 restart` los autoriza el usuario;
el push al repo lo hace él.

## Estado de la entrega 1 y lo que quedó afuera (2026-08-14)

**Decidido:** el **progreso es del equipo**, y la pantalla lo dice ("resueltos hoy por el
equipo"). Hacerlo por persona hoy solo es posible para los confirmados (`confirmado_por`,
migración 013); `cobertura_exclusiones` y `cobertura_hay_que_publicar` no tienen columna de
usuario, y agregarla es churn de esquema que no paga en un equipo de dos o tres personas.

**Postergado por presupuesto de cuota, no por criterio** (queda escrito para no perderlo):

- **"Seguir donde quedé" sigue mostrando solo lo pendiente, no el progreso de esa marca.** El
  backend no devuelve "hechas de esta marca" en ningún endpoint, así que la pantalla no tiene
  con qué. Era un pendiente absorbido de Cobertura; se hace cuando haya cuota.
- **Faltan los casos 403 de `solo-ml/:clave/pausar` y `multi-publicacion/:clave/desvincular`**
  en los tests. `multi-publicacion/:clave/pausar` sí está cubierto, así que la regla está
  probada; falta la cobertura de las hermanas.
- **Deuda de capas:** `routes/cobertura.js` (1022 líneas) importa lógica de dominio desde
  `routes/sync.js` (`filasDeVinculos`, `cargarDescartes`, `senalesVigentes`, `logSync`). Eso
  va en `lib/`. **Se hace en la entrega 2**, que suma la otra dirección al mismo archivo: ahí
  se ve el alcance completo y se mueve una sola vez.
