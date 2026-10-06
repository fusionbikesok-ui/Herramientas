# Consolidación de herramientas, pausas con sentido y eventos antes que crons (2026-10-03)

**Estado:** plan aprobado por José el 2026-10-03. El análisis se hizo en solo lectura contra el código y contra
producción (sqlite `?mode=ro`, SELECT en Postgres).

## Contexto

José, 2026-10-03:
1. "Volvamos a ver el matcher… investiga… buenas prácticas… ve guardando tu progreso."
2. "La idea es dejar de tener guardia, auditoria, identidad, matcher, conflictos… dejemos solo las necesarias;
   las sincronizaciones están pausando muchas sin sentido."
3. "¿No deberíamos tener menos crons y actuar más en función de webhooks?"

Base del plan:
- 5 investigaciones de solo lectura: código e historia, datos de producción, web, inventario de herramientas y
  pausas.
- Mis verificaciones contra el código y contra la base de producción en solo lectura.

El despliegue de la Bandeja (`fix/integracion-0028`) queda en pausa (ver el final).

## Diagnóstico (todo verificado)

### 1. Unas 12 herramientas para 3 trabajos

Matcher, Cobertura, Vínculos, Guardia ML, Identidad de productos, Conflictos GTIN, Bandeja E3, Auditoría de
publicaciones, Sync ML, Sync detalle, el Vigía y Config ML.

- **El sync real lee solo dos cosas:**
  - `sku_matcher_decisiones`;
  - el bloqueo `guardia_ml_casos.bloquea_sync` (`routes/sync.js:246-270`).
- **El mismo concepto vive en varias tablas:**
  - la decisión de vínculo en 5 (incluidas 2 de Postgres);
  - los casos en 3 colas (`guardia_ml_casos`, `identidad_casos` y PG `identity_cases`).
- **Herramientas muertas:**
  - Cobertura y Vínculos: redirigen y devuelven 410;
  - Auditoría de publicaciones: 2.868 filas, todas "sin revisar";
  - las tablas `ml_vinculos_revisados`, `guardia_ml_aprendizajes` e `identidad_notas/_excepciones/_tareas_publicacion`,
    todas con 0 filas;
  - `guardia_ml_operaciones`, sin actividad desde el 06/09;
  - dos chips del home rotos (uno pide un endpoint 410 y el otro lleva a una página que ya no existe).
- **Herramientas vivas:**
  - el sync;
  - el Vigía (683 revisiones humanas en 7 días);
  - Precios;
  - Códigos universales;
  - las ventas retenidas de Guardia;
  - el motor de Identidad.

### 2. Hoy no se puede vincular a mano por ningún camino

- Guardia está en `modo=lectura` desde el 03/09, así que `/vincular-clave` responde 409 en `guardiaMl.js:196`, antes
  de delegar a Identidad.
- Identidad tiene un canario de 1 clave y lote 1 (`lib/identidadProductos.js:1932-1944`). Por eso **21 operaciones
  están trabadas** desde el 05 y el 12/09:
  - 15 son no-op (el mismo SKU, varias duplicadas);
  - 1 está mal (op 128, un disco Centerlock reemplazado por uno de 6 tornillos; la op 135 la revierte);
  - 4 son reales: 104, 126, 127 y 130.
- La Bandeja E3 solo escribe en Postgres: lo que se decide ahí no mueve el stock.
- Además, la pantalla del Matcher tiene un bug latente: confirma sobre `filteredItems[0]` y no sobre la publicación
  que se está mirando (`public/matcher/index.html:443-447`, `:573`, `:586`). Hoy no escribe solo porque Guardia
  responde 409.

### 3. Pausas: el sync tiene motivo; el Vigía y las pausas "del vendedor", no

- **El sync escribe 0 en ML solo cuando Woo tiene 0.** En 30 días hubo 266 bajas a 0:
  - en 215 Woo sigue en ≤0;
  - las demás se repusieron, y el reactivador las volvió a activar (143 reactivaciones).
- **Hay 75 publicaciones pausadas que tienen vínculo y stock en Woo:**

  | sub_status | Publicaciones |
  |---|---|
  | `paused_by_seller` | 40 |
  | `out_of_stock,paused_by_seller` | 16 |
  | sin sub_status (pausas viejas) | 12 |
  | `out_of_stock` | 7 |

  A eso se suman 22 publicaciones sin vínculo cuyo SKU tiene stock; 9 de ellas tienen un SKU compartido que
  `autoVincularPorSellerSku` saltea (`lib/mlMapeo.js:126`).
- **Por qué no vuelven solas:** el reactivador excluye `paused_by_seller` (`sync.js:1983`). Lo que pausa el Vigía o
  cualquier persona en ML queda pausado para siempre, aunque haya stock y el caso ya esté revisado.
- **El Vigía (`lib/vigiaPausado.js`) es el único que pausa a propósito**, y lo hace demasiado:
  - pausa cuando el producto de catálogo pasa de vacío a un producto, que casi siempre es ruido de ML;
  - su tope de 5 es **por corrida**: el 24, 25 y 26/09 marcó 83, 58 y 101 pausas (es un techo, porque también marca
    las que ya estaban pausadas);
  - no registra quién pausó.
- **`solo_local`** fuerza stock 0 en 17 publicaciones (166 SKUs configurados) sin que se vea en ningún lado.

### 4. Crons y webhooks

- Hay **31 crons**: 6 corren cada minuto, el log muestra "missed execution" y pm2 registra 55 reinicios.
- Los webhooks ya llegan:
  - ML en `server.js:554`; Woo en `server.js:316` y `server.js:381`;
  - en 7 días: 8.273 de ml.items y 652 de woo.products, guardados en `integrations.inbox_messages`.

  Pero el legado los usa solo para pedidos: el stock y las publicaciones se resuelven con barridos (la caché de ML se
  recorre entera cada 15 minutos).
- El inbox de la plataforma tiene unos 4.800 mensajes `pending` sin consumidor desde el 17–18/09: corrientes en sombra.

## Destino: 4 herramientas

| Queda | Absorbe | Se retira |
|---|---|---|
| **1. Catálogo y vínculos.** Una pantalla y **un único escritor**: el motor de Identidad | Matcher, Identidad, Conflictos GTIN, los casos y "vincular" de Guardia, la UX de la Bandeja E3 (matriz por atributo, sin preselección, deshacer, teclado) | Cobertura, Vínculos, el push viejo, el escaneo y worker de Guardia, `guardia_ml_operaciones` |
| **2. Sincronización ML.** Stock, precio, reactivación, Vigía y reservas, con **una sola protección** (casos abiertos de Identidad + contradicción) y **una sola lista de incidentes** que incluye "pausadas con stock" y "ventas retenidas" | Sync ML, Sync detalle, Config ML, el Vigía, las retenidas de Guardia | `bloquea_sync` de Guardia |
| **3. Precios ML** | — | — |
| **4. Códigos universales** | — | — |
| — | — | Auditoría de publicaciones; la tarjeta duplicada "SKU Matcher" |

**Recomendación para la Bandeja E3:** llevar su interfaz a la herramienta 1 (en el legado, escribiendo por el motor de
Identidad) y congelar la autoridad en la plataforma hasta E4. No conviene mantener dos colas.

## Fases (cada una en su propio worktree)

En todas las fases, la sesión par implementa y yo reviso, con los gates obligatorios: revisor + auditor-despliegue, y
probador-e2e si se toca `public/`. Antes de desplegar va un backup. **Cada despliegue lleva el OK de José.**

### Fase A: que no pause sin sentido (primero, porque es lo que más duele)

1. **Vigía:**
   - el cambio de producto de catálogo de vacío a un producto deja de pausar y pasa a ser solo un aviso;
   - el tope de 5 pasa a ser por corrida **y** por 24 h;
   - cuando una persona marca el cambio como revisado, se ofrece reactivar (en un clic) si hay stock;
   - `pausarPublicacionMl` registra quién pausó y desde dónde;
   - `pausada` deja de marcarse en las que ya estaban pausadas.
2. **Lista "Pausadas con stock en Woo"** en Sincronización, con su causa: vendedor, Vigía, `solo_local`, sin vínculo
   o pausa vieja. Tiene un botón "Reactivar", y Reactivar seleccionadas para los lotes. Al principio se muestran
   también las que pausó el vendedor; la reactivación automática de esas queda en manos de José, no del sistema.
3. **`solo_local`** a la vista: un contador y un filtro.
4. **`autoVincularPorSellerSku`** acepta un SKU compartido cuando el producto Woo es único (destraba 9 publicaciones).

### Fase B: destrabar el vínculo y limpiar

1. **Operaciones trabadas:**
   - cancelar con motivo las 15 no-op y la op 128 (es una escritura en producción, con backup);
   - José decide si se aplican las 4 reales;
   - al encolar, validar `sku_anterior != sku_objetivo` y deduplicar.
2. **Canario de Identidad:** un criterio de salida y una alarma de "encoladas sin ejecutar > 2 h". `restore` con
   contradicción **devuelve el stock** y abre intervención, en vez de dejar la publicación en 0.
3. **Retirar lo muerto:**
   - la pantalla del Matcher pasa a solo lectura y redirige;
   - Cobertura, Vínculos, los endpoints y chips 410, la Auditoría de publicaciones y el código muerto de
     `server.js:1121-1131`;
   - las tablas muertas, con backup.
4. **Auto-vincular las 156 publicaciones** cuyo seller_sku `FB-` existe en Woo: primero en sombra, con una muestra de
   20 revisada por José.

### Fase C: una sola protección y una sola cola

1. En `sync.js:266`, el bloqueo pasa de Guardia a "caso de Identidad abierto que bloquea". Se comparan los conteos de
   la CTE antes y después.
2. Las ventas retenidas (`guardia_ml_pedidos_retenidos`, `retenerPedidoMl`) pasan a Sincronización.
3. Se apagan el escaneo y el worker de Guardia: sus tablas quedan 30 días en solo lectura y después se retira la
   página.
4. El orquestador del refresco de ML sale de `routes/matcher.js:69-140` y pasa a `lib/refrescoMl.js`.
5. **El GTIN compartido por una familia** pasa a ser una señal débil: deja de abrir casos urgentes (hoy son 16 de 26).
6. **Las decisiones pasan a un log de eventos que solo agrega**, con el método, el actor y el motivo. Deshacer es un
   evento nuevo. De ahí sale el set dorado para medir aciertos.

### Fase D: la pantalla única "Catálogo y vínculos"

Lleva la UX de la Bandeja (spec `2026-09-24-e3-bandeja-flujo-ux.md`) más:
- la cola ordenada por impacto (ventas en ML × stock en Woo);
- una matriz por atributo con veto rojo (color, talle, rodado, transmisión, medida) y el puntaje desglosado;
- lote por familia, solo cuando todo está en verde;
- "Saltear" separado de "No sincronizar con motivo";
- el estado real de la ejecución en cada caso (encolada → aplicada en ML, o frenada);
- en el encabezado: cobertura, cola y trabadas.

Se retiran las tarjetas "Identidad de productos", "Guardia ML", "SKU Matcher" y "Bandeja".

### Fase E: primero los webhooks; los crons se reducen, no se eliminan

José: "No sé si los eliminaría a todos pero sí los reduciría, no me gusta dejar cosas al azar."

1. **El evento actúa primero.**
   - Un webhook `items` de ML → releer ese item → actualizar la caché, correr el Vigía y sincronizar el stock **de
     esa clave**.
   - Un webhook `product` de Woo → sincronizar ese SKU.
   - Las dos cosas son idempotentes.
2. **Cada proceso conserva su barrido de control, más espaciado.** Por ejemplo:
   - stock: cada 10 minutos → cada hora;
   - refresco de ML: cada 15 minutos → cada 2 horas, más la conciliación nocturna completa.

   El barrido ya no "hace el trabajo": **verifica y mide**. Cuenta cuántas diferencias encontró que el webhook no
   había cubierto.
   - Si encuentra alguna, la corrige y **avisa** ("se perdieron N avisos de ML hoy").
   - Si encuentra muchas, sube solo su frecuencia hasta que se normalice.

   Así nada queda librado a que el webhook llegue.
3. **Se unifican los crons que hacen lo mismo con distinto nombre.** Guardia, la auditoría de Identidad y la
   reconciliación de stock recorren el mismo universo: pasan a ser un solo barrido. Los de cada minuto se agrupan en
   un único bucle de trabajos.

   **Meta orientativa:** de 31 a unos 12–15, todos con una función clara y con su métrica de "diferencias
   encontradas".
4. **Cada cambio de frecuencia, de a uno:**
   1. el evento corre en paralelo;
   2. una semana comparando evento contra barrido;
   3. recién entonces se baja la frecuencia;
   4. nunca se apaga un barrido de control.
4. Para las corrientes en sombra que la plataforma no consume (pedidos, envíos, preguntas): consumirlas o dejar de
   guardarlas. Lo decide José (en E1).

## Primer paso al aprobar

1. Guardar este análisis en el repo, en un worktree con su commit:
   - `docs/superpowers/specs/2026-10-03-consolidacion-herramientas.md`;
   - una memoria con las causas raíz: el canario, el modo `lectura` de Guardia, el bug del índice y el Vigía.
2. Pasarle la Fase A a la sesión par con su spec, revisarla y desplegarla con el OK de José.

## Verificación por fase

- **A:**
  - tests del Vigía (vacío→producto no pausa; tope por 24 h);
  - un E2E de la lista "Pausadas con stock";
  - en producción, al día siguiente, Vigía con `pausada=1` cerca de 0 y la lista con causas.
- **B:** `identidad_operaciones` sin no-op y con las 4 reales decididas; un test de validación al encolar.
- **C:** el conteo de la CTE del sync, antes y después, es igual salvo diferencias explicadas; las retenidas
  funcionan.
- **D:** el recorrido de teclado de 11 pasos de la spec, más un vínculo real aplicado en ML y visible como "aplicada".
- **E:** por cada frecuencia que se baja, una semana con la métrica "diferencias encontradas por el barrido" en 0
  o explicada, y la alarma de avisos perdidos probada.
- **En todas:** suite dirigida, y la suite completa al cerrar cada entrega.

## Despliegue de la Bandeja (en pausa)

- **Procedimiento:**
  1. `cd /opt/fusionbikes/herramientas && docker compose -f plataforma/deploy/compose.yml -p fusion-plataforma
     --env-file /opt/fusionbikes/plataforma-prod/plataforma.env build`;
  2. `migrate` (de 0027 a 0029);
  3. recrear api, worker y scheduler.
- **Verificar** contra `core.schema_migrations`.
- **Rollback:** etiquetar antes `local`=e67761ded868, api=8b785766dbdf y scheduler=b91861153819.
- **Falta:**
  - mi revisión de 5ac01095, 1235797d y 52993d05;
  - el auditor-despliegue;
  - el backup de sqlite y de Postgres.
- Con la recomendación de llevar la UX al legado, este despliegue se replantea: posiblemente solo la migración 0028
  y las correcciones de catálogo.
