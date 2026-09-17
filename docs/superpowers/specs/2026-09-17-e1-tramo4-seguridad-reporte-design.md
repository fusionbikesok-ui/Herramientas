# E1 tramo 4 — seguridad y reporte (diseño)

**Fecha:** 2026-09-17 · **Estado:** diseño, sin implementar · **Entrega:** E1, tramo 4 de 4
**Escenarios contractuales:** `E1-AUD-04`, `E1-REC-01`, `E1-WA-01` (`docs/superpowers/specs/e1/test-e1.md`)
**Decisiones previas:** PM-170 (`@simplewebauthn/server` 14.x), PM-171 (SMTP existente), PM-172 (B2 Object Lock
governance 365 días con clave sin borrado).

Los tramos 1 a 3 ya están implementados: esquema, auditoría encadenada, colas, barridos y la sombra en vivo
(Woo y ML al 100 % desde el 2026-09-17). Este tramo cierra E1 con lo que falta: firmar la evidencia, sacarla
del VPS, avisar por email y dejar las passkeys probadas sin habilitarlas.

## 0. Decisiones previas que este diseño revisa

- **PM-172** fijaba Object Lock en modo *governance*. Este diseño pasa a **compliance** (§7): governance no
  resiste a una clave administrativa de la cuenta, y la evidencia tiene que resistirla.
- **PM-170** fijaba `@simplewebauthn/server` "14.x". Este diseño exige **≥ 14.0.2** (§8), porque la 14.0.1
  arrastra dos vulnerabilidades moderadas.
- El diseño decía "sin migraciones". Son **dos** (§3), por lo que encontró la revisión externa del 2026-09-17.

## 1. Alcance

Entra: firma Ed25519, manifiesto diario de auditoría, reporte diario de sombra, subida a B2 con Object Lock,
email diario, rutas de passkeys apagadas por interruptor y la campaña contractual de 7 días.

No entra: UI, login real en dispositivos (es condición de E2/E4), dominio con HTTPS (E4), purga de
`integration_events` (sigue pendiente y anotada aparte).

## 2. Decisiones de José (2026-09-17)

| Tema | Decisión |
|---|---|
| Passkeys | Las rutas se publican en la API; con `passkeys.real` apagado responden **503** con motivo |
| Falla de B2 | Se guarda el archivo firmado en disco, se reintenta en la vuelta siguiente e **incidente si pasan 24 h** |
| Cuerpo del email | **Semáforo y sólo lo que necesita acción**; el detalle va en el JSON adjunto |
| Campaña de 7 días | Un día con faltantes sin explicar **reinicia el conteo** |
| Ejecutor | El **scheduler** de la plataforma, 07:00 ART |
| Email | La plataforma usa el **SMTP directo**, con credenciales en su propio archivo de entorno |
| Cadena de auditoría rota | Se firma y sube igual, con la rotura registrada, **más incidente crítico** |
| Clave de firma | Privada en el keyring del VPS (0600), pública en el repo |
| Usuarios | Sólo los que crean los tests; en producción no se carga ninguno (el alta real es de E4) |
| Verificación | Comando del repo `npm run verificar-informe` |
| Faltantes explicados | Sólo causas que el sistema registró; no hay explicación manual |
| Reporte que no llega | Cada reporte numera el día de la campaña; un salto se ve solo |
| Secretos de SMTP y B2 | Archivos sueltos en `secretos/`, montados 0600, leídos al arrancar |
| Retención | **Modo compliance** 365 días: nadie, ni con la clave maestra, puede borrar ni acortar (revisa PM-172) |
| Buckets | Dos: pruebas sin Object Lock (vaciable) y producción en compliance |
| Día que cubre | El **día calendario ART anterior** (00:00 a 00:00), congelado |
| Email en duda | Se **reenvía**: mejor duplicado que silencio |
| Vigilante | El legado avisa si a las 09:00 ART no hay informe del día |
| Entrega | Tabla nueva de entregas con estados; **hay migración** |
| Interruptor de passkeys | **Doble llave**: la fila de la base y una variable de entorno que en producción no existe |
| Lectura de B2 | Segunda clave de sólo lectura, separada de la de escritura |
| Recuperación de acceso | Dos passkeys registradas más 10 códigos de 128 bits guardados aparte |
| Formato firmado | **Un solo archivo** con la firma adentro |

## 3. Arquitectura

Un módulo nuevo, `plataforma/src/informes/`, con cuatro piezas de una responsabilidad cada una, y el
scheduler encadenándolas una vez por día. Se descartó un contenedor aparte (infraestructura para algo que
corre una vez por día) y meter todo en el scheduler (mezcla colas, firma, red y email, y obliga a mocks).

| Archivo | Qué hace | De qué depende |
|---|---|---|
| `firma.ts` | firmar y verificar Ed25519 sobre JSON canónico | `node:crypto` |
| `manifiesto.ts` | arma el manifiesto del día | base (sólo lectura de `audit`) |
| `reporte.ts` | arma el reporte de sombra del día | base (`integrations`) |
| `deposito.ts` | sube a B2 con retención; si falla deja el archivo en disco | S3 API de B2 |
| `entregas.ts` | la máquina de estados durable y su `lease` (§7 bis) | base (`informes`) |
| `correo.ts` | arma el semáforo y envía con adjuntos | SMTP |
| `../auth/passkeys.ts` + rutas | registro, login, reautenticación y recuperación | `@simplewebauthn/server` ≥ 14.0.2 |

En el legado, una pieza chica más: el vigilante de las 09:00 ART que avisa si no hay informe del día.

La mayoría de las tablas ya existen desde el tramo 1 (`audit.audit_daily_manifests`,
`integrations.daily_shadow_reports`, `security.webauthn_credentials`, `security.recovery_codes`,
`security.feature_flags`), pero la revisión externa del 2026-09-17
(`evidence/e1/2026-09-17-E1-T4-revision-codex.md`) mostró dos faltantes que **sí exigen migración**:

- `informes.entregas`: el estado durable de cada artefacto (ver §7 bis). Sin él no hay dónde anotar
  "firmado pero todavía no subido", porque las tablas existentes exigen la clave del objeto de B2 y su versión.
- `security.webauthn_challenges`: el desafío de cada ceremonia, con propósito, usuario, vencimiento y consumo
  único. WebAuthn obliga a conservarlo entre el inicio y el fin, y guardarlo en memoria se rompe con dos
  procesos o un reinicio.

Más la fila del interruptor `passkeys.real` en `false`.

## 4. Firma y custodia de la clave

- **Formato:** el objeto se serializa con **JCS (RFC 8785)**, que fija sin ambigüedad el orden de las claves,
  la forma de los números y la codificación Unicode; "claves ordenadas, sin espacios" no alcanzaba para que
  otro programa llegue a los mismos bytes. Se firma con Ed25519 sobre esos bytes en UTF-8.
- **Un solo archivo por día**, con la firma adentro: `{ "version": 1, "kid": "...", "firma": "<base64>",
  "contenido": { ... } }`. Con dos archivos separados existía el corte parcial de subir uno y que falte el otro.
- **Privada:** se genera en el VPS con un comando del repo y vive en
  `/opt/fusionbikes/plataforma-prod/keyring/firma-informes.pem`, permisos 0600, montada de sólo lectura en el
  contenedor como el resto del keyring. Si es legible por grupo u otros, el arranque falla (misma guarda que
  `src/seguridad/keyring.ts`).
- **Pública:** commiteada en `docs/superpowers/specs/e1/firma-informes.pub`. En el email va sólo el `kid`, la
  huella de la clave y dónde encontrarla: una clave pegada en el mismo mensaje que firma no agrega confianza,
  porque quien falsifica el mensaje también pega su clave.
- **Rotación:** cada firma lleva `kid`; la verificación acepta un mapa de claves conocidas, así que rotar es
  agregar una nueva y conservar la vieja para verificar lo antiguo.
- **Permisos:** al abrirla se verifica dueño esperado, que sea un archivo regular (no enlace), y que ni el
  archivo ni su directorio sean escribibles por otros. Sólo mirar los bits de grupo y otros dejaba pasar un
  enlace simbólico o un directorio padre abierto.
- **Generación y respaldo:** el comando la crea en un temporal, hace `fsync` y renombra, para que no quede una
  clave a medio escribir. Su respaldo lo guarda José fuera del VPS; si se pierde, se rota y los informes viejos
  se siguen verificando con la pública anterior.
- **Pruebas sin red:** una firma válida verifica; un byte alterado no; el mismo objeto con las claves en otro
  orden da los mismos bytes; un archivo con permisos amplios, con dueño ajeno o un enlace no arranca.

## 5. Manifiesto diario de auditoría (`E1-AUD-04`)

- **Ventana:** el día calendario **ART** anterior, `[00:00, 00:00)`, la misma que usa el reporte. Antes decía
  UTC mientras el envío era a las 07:00 ART, así que no quedaba claro qué día se reportaba.
- **Contenido:** la fecha, primer y último `chain_seq`, cantidad de eventos, hash del último evento, resultado
  de `audit.verify_chain` y `retention_until` a 365 días.
- **Snapshot consistente:** todo se lee en una transacción `REPEATABLE READ` que primero fija el último
  `chain_seq` del día y después verifica exactamente hasta ese valor. Sin eso, con eventos entrando en paralelo,
  el conteo, los extremos y la verificación podían describir tres estados distintos.
- **Por qué existe:** la cadena de hashes detecta que alguien modificó o borró un evento del medio, pero no
  que borró el último. El manifiesto fija ese extremo fuera de la base y firmado.
- **Cadena rota:** se registra el `chain_seq` donde aparece, se firma y se sube igual, y se abre un incidente
  crítico. La evidencia de la rotura importa tanto como el aviso.
- **Día sin eventos:** se emite igual, con `event_count` en 0, `first_chain_seq` y `last_chain_seq` en nulo y
  `last_hash` igual al último hash conocido de la cadena (el del día anterior). Queda fijado así en el formato
  firmado y en el test, porque la columna del hash no admite nulos. Un día faltante no se distingue de un día
  ocultado.

## 6. Reporte diario de sombra (`E1-REC-01`)

- **Ventana congelada:** el día calendario ART anterior, `[desde, hasta)`, y **todas** las métricas se
  consultan con esos mismos límites. El resumen que ya guarda el scheduler no sirve como fuente firmable: mide
  ventanas móviles de 24 h y sobrescribe la fila del día, así que firmarlo no demuestra el día cerrado. El
  reporte recalcula con la ventana fija y el resumen queda como dato operativo.
- **Fuente:** las consultas de paridad, cobertura y convergencia por tópico del tramo 2, más las alertas
  registradas del día.
- **Contenido del JSON:** por tópico, señales del legado, señales del núcleo, faltantes con explicación y
  faltantes **sin** explicación, cobertura, convergencia, latencia de la sombra y copias descartadas; más las
  alertas del día y el resultado del manifiesto.
- **Semáforo:** verde si no hay faltantes sin explicar ni alertas altas; amarillo con alertas medias; rojo con
  faltantes sin explicar, alerta alta o cadena rota.
- **Email:** asunto con fecha y semáforo; cuerpo con el estado, lo que necesita acción y la clave pública;
  adjuntos `reporte.json` y `reporte.json.sig`. Sale 07:00 ART a `ALERTAS_EMAIL`.
- **Faltante explicado:** sólo cuando la causa quedó registrada por el sistema — recurso borrado en el canal,
  recurso fuera de la ventana de la corrida, tópico sin historial consultable (se acepta por convergencia), o
  copia descartada ya contada. No existe la explicación manual: un faltante que nadie puede explicar con datos
  cuenta como sin explicar y rompe la campaña. Es lo que evita auto-engañarse para cerrar la entrega.
- **Continuidad:** el asunto y el JSON llevan el número de día de la campaña y la fecha del reporte anterior.
  Un día que no llegó se nota por el salto, sin necesidad de un vigilante externo.
- **Verificación independiente:** `npm run verificar-informe <archivo.json> <archivo.sig>` responde válido o
  inválido usando la pública del repo. Se prueba con un reporte bueno y con uno alterado.
- **Email en duda:** si el servidor aceptó el mensaje y el proceso cayó antes de anotarlo, se **reenvía**. Se
  acepta el duplicado: el asunto lleva la fecha, así que se ve que es el mismo día, y un día sin aviso es peor
  que un aviso repetido. El envío es "al menos una vez" y así queda declarado.
- **Vigilante externo:** el legado consulta a la plataforma a las 09:00 ART y, si no hay informe del día, manda
  una alerta por el canal que ya funciona. Es el único aviso que sobrevive a que la plataforma se caiga entera;
  la numeración de días sólo detecta el salto cuando llega un informe posterior.

## 7. Depósito en B2

- **Claves de objeto:** `e1/manifiestos/<fecha>.json` y `e1/reportes/<fecha>.json` (un archivo por día y por
  tipo, con la firma adentro).
- **Retención:** Object Lock modo **compliance** con 365 días. Governance protegía contra alguien que entrara al
  VPS, pero una clave administrativa de la cuenta podía acortar la retención, y la evidencia tiene que resistir
  eso. **Revisa PM-172**, que fijaba governance. Es irreversible: lo subido ocupa lugar hasta 2027.
- **`retain_until`:** se calcula sobre la hora **confirmada de la subida** más 365 días y un margen, no sobre la
  generación. Si se calculara antes de la cola y los reintentos, el objeto podía terminar con menos de 365 días
  reales. Después de subir se lee la retención y se compara con lo esperado.
- **Dos buckets:** producción en compliance, y uno de pruebas **sin** Object Lock, que se puede vaciar. Contra B2
  real sólo se hace una verificación al configurar el bucket (que Object Lock esté habilitado, que la subida
  devuelva la versión, que la retención leída sea la esperada y que la clave no pueda borrar ni acortar); los
  tests de la suite no salen a internet.
- **Dos credenciales:** una de escritura (`writeFiles`, `writeFileRetentions`, sin `deleteFiles` ni
  `bypassGovernance`) y una segunda de **sólo lectura** (`readFiles`, `readFileRetentions`), necesaria para
  resolver una subida en duda. Ambas acotadas al bucket y al prefijo `e1/`, creadas por CLI porque la consola
  web de B2 no permite quitar el permiso de borrado. José las crea y las deja en el VPS con permisos 0600.
- **Falla:** el artefacto firmado queda en `/opt/fusionbikes/plataforma-prod/informes-pendientes/` (escritura a
  temporal, `fsync` y renombre, para que nunca quede un archivo a medias) y se reintenta con espera creciente.
  Si lleva más de 24 h sin subir, incidente crítico. El email sale igual: avisar no depende de B2.
- **Subida en duda:** ante un timeout no se reintenta a ciegas. Primero se consulta el objeto con la clave de
  lectura: si ya está con la retención esperada, se anota su versión y se cierra; si no está, se sube. Repetir el
  PUT a ciegas crearía otra versión del mismo objeto, y con compliance esa copia queda un año.
- **Pruebas:** contra un simulador S3 local, más el bucket de pruebas. Se verifica que la retención viaja en la
  subida, que un fallo deja el pendiente sin perder el día, que el reintento lo sube y limpia el pendiente, y
  que una subida en duda se resuelve consultando en lugar de duplicar.

## 7 bis. Entrega con estado durable

Firmar, subir y avisar son tres efectos externos, y ninguno es idempotente por sí solo. La clave primaria por
fecha evita dos filas, pero no dos subidas ni dos emails. Por eso hay una tabla `informes.entregas`, una fila
por artefacto y día, con el estado y lo necesario para retomar:

`generado → firmado → subido → avisado`, más `hash` del contenido, `kid`, ruta del pendiente local, cantidad de
intentos, último error y la hora de cada transición. La fila avanza de estado **después** de confirmar cada
efecto, nunca antes, y las tablas del tramo 1 (`audit_daily_manifests`, `daily_shadow_reports`) se escriben
recién cuando hay clave de objeto y versión reales.

**Dos schedulers a la vez:** el candado de exclusión que ya existe no alcanza, porque al perder la conexión el
proceso en curso puede seguir subiendo y enviando. Cada efecto se reclama con un `lease` sobre la fila, con un
testigo que se verifica inmediatamente antes y después del efecto; si el testigo cambió, el proceso viejo se
detiene sin escribir.

## 8. Passkeys (`E1-WA-01`)

- **Rutas:** `POST /api/v2/auth/passkeys/registro/inicio` y `/fin`, `POST /api/v2/auth/passkeys/login/inicio` y
  `/fin`, `POST /api/v2/auth/passkeys/reautenticacion` y `POST /api/v2/auth/passkeys/recuperacion`.
- **Interruptor de doble llave:** hacen falta las dos para que funcionen — la fila `passkeys.real` en `true`
  **y** la variable de entorno `PASSKEYS_HABILITADAS`, que en producción no existe. Con una sola llave, un
  `UPDATE` en la base habilitaba autenticación real sin dominio ni HTTPS. Con cualquiera de las dos apagada,
  **todas** las rutas responden 503 con `{ error: 'passkeys_deshabilitadas' }`. La guarda vive en un solo lugar,
  un plugin del grupo de rutas; hay un test que recorre la lista de rutas del grupo y exige 503 en todas, y otro
  que enciende la fila sin la variable y verifica que sigue en 503. Los tests encienden las dos en su entorno.
- **Desafíos:** cada ceremonia guarda su desafío en `security.webauthn_challenges`, con propósito (registro,
  login o reautenticación), usuario cuando aplica, vencimiento corto y consumo de un solo uso, y al verificar se
  exige exactamente ese desafío. En memoria no sirve: se rompe con dos procesos, un reinicio o dos pedidos a la
  vez.
- **Parámetros fijados:** `rpID` y origen esperado vienen de la configuración y no del pedido; se exige
  verificación de usuario, y se guardan el identificador WebAuthn del usuario, el contador y las banderas de
  respaldo, actualizados en la misma transacción del login.
- **Versión:** `@simplewebauthn/server` **≥ 14.0.2**. La 14.0.1 arrastra dos vulnerabilidades moderadas de
  validación de cadenas de certificados; "14.x" las permitía. Ajusta PM-170 en el mínimo.
- **Exposición:** la API sigue escuchando sólo en loopback. Publicarla hacia un navegador es E4.
- **Usuarios:** los crean los tests; en producción E1 no carga ninguno. Sin usuarios no hay credencial que
  robar, y el alta real llega con E4 junto al dominio y la UI.
- **Recuperar el acceso:** lo primero son **dos passkeys registradas** (teléfono y computadora): si se pierde
  una, se entra con la otra. Los **10 códigos de un solo uso, de 128 bits**, son el último recurso y se guardan
  fuera del sistema (impresos o en un gestor de claves). No son un segundo factor ni reemplazan a la passkey.
- **Límite de intentos:** 5 por hora por cuenta, más un límite por IP y uno global; la respuesta es la misma
  exista o no el usuario, para no revelar quién tiene cuenta. Usar un código lo consume, cierra las sesiones
  abiertas y avisa por email, todo en una transacción.
- **Contador de firmas:** se aplica la regla de la librería, que sólo exige avance cuando alguno de los dos
  contadores es mayor que cero. Exigir que nunca retroceda era falso: hay autenticadores, sobre todo los que
  sincronizan entre dispositivos, que informan siempre 0.
- **Pruebas:** autenticador virtual WebAuthn con las cuatro etapas (registro, login, reautenticación,
  recuperación), más: un desafío no se puede reusar, uno vencido se rechaza, un desafío de otro propósito no
  sirve, un código de recuperación no se reusa, el límite de intentos corta, y el contador sigue la regla de la
  librería.

## 9. Campaña contractual de 7 días

- **Arranque:** con ML ya en canario y el reporte firmado funcionando, después del 2026-09-23.
- **Criterio:** 7 días **seguidos** sin faltantes sin explicar en los tópicos enumerables, cobertura 100 % en
  envíos con convergencia declarada, y reportes firmados verificados por hash.
- **Un día malo:** se corrige la causa y el conteo **reinicia**. No se acepta la entrega con un día sucio
  adentro.
- **Evidencia:** los 7 reportes firmados, su verificación y la revisión de José. Nada se declara cumplido sin
  comando, salida, commit y fecha.

## 9 bis. Secretos

Cada secreto en su propio archivo bajo `/opt/fusionbikes/plataforma-prod/secretos/` (0600, montado de sólo
lectura), leído al arrancar: es el patrón que la plataforma ya usa. No van en `plataforma.env`, porque ahí
quedan visibles en `docker inspect` y en el entorno de cualquier proceso del contenedor. Los archivos nuevos
son los de SMTP (usuario y clave) y los de B2: id y clave de la credencial de escritura, e id y clave de la de
sólo lectura, en archivos distintos. Ningún secreto se registra en logs
ni viaja en la línea de comando.

## 10. Errores y bordes

| Situación | Comportamiento |
|---|---|
| PostgreSQL caído a la hora del informe | No se emite; se reintenta en la vuelta siguiente; incidente si pasan 24 h |
| SMTP rechaza el envío | Queda en `email_error` y se reintenta con espera creciente dentro del día; el objeto en B2 ya es la fuente de verdad |
| SMTP acepta y el proceso cae antes de anotarlo | Se reenvía; se acepta el duplicado |
| Subida a B2 en duda | Se consulta con la clave de lectura antes de reintentar, para no crear otra versión inmutable |
| Reloj corrido o día repetido | Fecha como clave primaria más la tabla de entregas: cada efecto se hace una vez |
| Clave de firma ausente, con permisos amplios, dueño ajeno o enlace | El servicio no arranca: mejor caer que emitir sin firmar |
| Dos schedulers a la vez | `lease` con testigo por artefacto, verificado antes y después de cada efecto |
| Disco lleno en los pendientes | Falla la escritura y el día queda sin subir, con incidente a las 24 h; el email sale igual |
| Varios días caído | Se emite un informe por cada día faltante, del más viejo al más nuevo, con su propia ventana |

## 11. Qué prueba el gate

`E1-AUD-04`, `E1-REC-01` y `E1-WA-01` en `npm run test:e1`, más el gate de escenarios
(`scripts/qa/gate-e1.mjs`). Nada sale a internet en los tests: B2 se simula y el SMTP también.

La revisión externa señaló, con razón, que el enunciado de esos tres IDs en `test-e1.md` es más flojo que lo que
este diseño exige: pide un día con eventos, firma y retención, pero no el día vacío, la cadena rota, la subida en
duda, el desafío reusado ni el interruptor de doble llave. Los tres IDs se **amplían** con esos casos al
implementar; el gate queda verde sólo con la versión ampliada. Lo que no entra en la suite y se hace una vez, con
salida pegada como evidencia: la verificación contra B2 real (Object Lock habilitado, versión devuelta, retención
leída, y que la clave de escritura no pueda borrar ni acortar) y un envío real de email.
