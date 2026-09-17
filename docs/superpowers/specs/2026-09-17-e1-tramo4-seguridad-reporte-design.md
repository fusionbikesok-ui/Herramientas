# E1 tramo 4 — seguridad y reporte (diseño)

**Fecha:** 2026-09-17 · **Estado:** diseño, sin implementar · **Entrega:** E1, tramo 4 de 4
**Escenarios contractuales:** `E1-AUD-04`, `E1-REC-01`, `E1-WA-01` (`docs/superpowers/specs/e1/test-e1.md`)
**Decisiones previas:** PM-170 (`@simplewebauthn/server` 14.x), PM-171 (SMTP existente), PM-172 (B2 Object Lock
governance 365 días con clave sin borrado).

Los tramos 1 a 3 ya están implementados: esquema, auditoría encadenada, colas, barridos y la sombra en vivo
(Woo y ML al 100 % desde el 2026-09-17). Este tramo cierra E1 con lo que falta: firmar la evidencia, sacarla
del VPS, avisar por email y dejar las passkeys probadas sin habilitarlas.

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
| `correo.ts` | arma el semáforo y envía con adjuntos | SMTP |
| `../auth/passkeys.ts` + rutas | registro, login, reautenticación y recuperación | `@simplewebauthn/server` |

Las tablas ya existen desde el tramo 1 (`audit.audit_daily_manifests`, `integrations.daily_shadow_reports`,
`security.webauthn_credentials`, `security.recovery_codes`, `security.feature_flags`): este tramo no agrega
migraciones de esquema, sólo la fila del interruptor `passkeys.real` en `false`.

## 4. Firma y custodia de la clave

- **Formato:** el objeto se serializa canónicamente (claves ordenadas, sin espacios) y se firma con Ed25519.
  Por día se suben dos archivos: `<nombre>.json` y `<nombre>.json.sig` en base64. Cualquiera verifica con la
  clave pública sin nuestro código.
- **Privada:** se genera en el VPS con un comando del repo y vive en
  `/opt/fusionbikes/plataforma-prod/keyring/firma-informes.pem`, permisos 0600, montada de sólo lectura en el
  contenedor como el resto del keyring. Si es legible por grupo u otros, el arranque falla (misma guarda que
  `src/seguridad/keyring.ts`).
- **Pública:** commiteada en `docs/superpowers/specs/e1/firma-informes.pub` y en el cuerpo de cada email.
- **Rotación:** cada firma lleva `kid`; la verificación acepta un mapa de claves conocidas, así que rotar es
  agregar una nueva y conservar la vieja para verificar lo antiguo.
- **Pruebas sin red:** una firma válida verifica; un byte alterado no; la serialización canónica da lo mismo
  con las claves en otro orden; un archivo con permisos amplios no arranca.

## 5. Manifiesto diario de auditoría (`E1-AUD-04`)

- **Contenido:** día en UTC, primer y último `chain_seq`, cantidad de eventos, hash del último evento,
  resultado de `audit.verify_chain` y `retention_until` a 365 días.
- **Por qué existe:** la cadena de hashes detecta que alguien modificó o borró un evento del medio, pero no
  que borró el último. El manifiesto fija ese extremo fuera de la base y firmado.
- **Cadena rota:** se registra el `chain_seq` donde aparece, se firma y se sube igual, y se abre un incidente
  crítico. La evidencia de la rotura importa tanto como el aviso.
- **Día sin eventos:** se emite igual, con cero eventos y el último hash conocido. Un día faltante no se
  distingue de un día ocultado.

## 6. Reporte diario de sombra (`E1-REC-01`)

- **Fuente:** `integrations.shadow_daily_summaries` (que ya escribe el scheduler) más las consultas de
  paridad, cobertura y convergencia por tópico del tramo 2.
- **Contenido del JSON:** por tópico, señales del legado, señales del núcleo, faltantes con explicación y
  faltantes **sin** explicación, cobertura, convergencia, latencia de la sombra y copias descartadas; más las
  alertas del día y el resultado del manifiesto.
- **Semáforo:** verde si no hay faltantes sin explicar ni alertas altas; amarillo con alertas medias; rojo con
  faltantes sin explicar, alerta alta o cadena rota.
- **Email:** asunto con fecha y semáforo; cuerpo con el estado, lo que necesita acción y la clave pública;
  adjuntos `reporte.json` y `reporte.json.sig`. Sale 07:00 ART a `ALERTAS_EMAIL`.
- **Idempotencia:** `report_date` es clave primaria. Repetir el día no duplica ni reenvía; `email_sent_at`
  y `email_error` registran el envío.

## 7. Depósito en B2

- **Claves de objeto:** `e1/manifiestos/<fecha>.json` y `e1/reportes/<fecha>.json`, cada uno con su `.sig`.
- **Retención:** Object Lock modo governance con 365 días, fijada en la subida.
- **Credencial:** clave de aplicación propia con `writeFiles` y `writeFileRetentions`, **sin** `deleteFiles`
  ni `bypassGovernance` (PM-172). Como la consola web de B2 no permite quitar el permiso de borrado, la clave
  se crea por CLI. José la crea y la deja en el VPS con permisos 0600; el diseño no incluye su valor.
- **Falla:** el archivo firmado queda en `/opt/fusionbikes/plataforma-prod/informes-pendientes/` y se reintenta
  en cada vuelta. Si un archivo lleva más de 24 h sin subir, se abre un incidente crítico. El email sale igual:
  avisar no depende de B2.
- **Pruebas:** contra un simulador S3 local. Se verifica que la retención viaja en la subida, que un fallo deja
  el archivo pendiente y no pierde el día, y que el reintento lo sube y limpia el pendiente.

## 8. Passkeys (`E1-WA-01`)

- **Rutas:** `POST /api/v2/auth/passkeys/registro/inicio` y `/fin`, `POST /api/v2/auth/passkeys/login/inicio` y
  `/fin`, `POST /api/v2/auth/passkeys/reautenticacion` y `POST /api/v2/auth/passkeys/recuperacion`.
- **Interruptor:** con `passkeys.real` en `false` (su estado en E1) **todas** responden 503 con
  `{ error: 'passkeys_deshabilitadas' }`. La guarda se aplica en un solo lugar, un plugin del grupo de rutas,
  para que no pueda quedar una ruta sin ella; hay un test que recorre la lista de rutas del grupo y exige 503
  en todas.
- **Exposición:** la API sigue escuchando sólo en loopback. Publicarla hacia un navegador es E4.
- **Códigos de recuperación:** de un solo uso, guardados como HMAC-SHA256 (`security.recovery_codes`); el
  código en claro sólo existe en la respuesta que lo entrega.
- **Pruebas:** autenticador virtual WebAuthn, con las cuatro etapas (registro, login, reautenticación,
  recuperación), más el contador de firmas que no retrocede y un código de recuperación que no se reusa.

## 9. Campaña contractual de 7 días

- **Arranque:** con ML ya en canario y el reporte firmado funcionando, después del 2026-09-23.
- **Criterio:** 7 días **seguidos** sin faltantes sin explicar en los tópicos enumerables, cobertura 100 % en
  envíos con convergencia declarada, y reportes firmados verificados por hash.
- **Un día malo:** se corrige la causa y el conteo **reinicia**. No se acepta la entrega con un día sucio
  adentro.
- **Evidencia:** los 7 reportes firmados, su verificación y la revisión de José. Nada se declara cumplido sin
  comando, salida, commit y fecha.

## 10. Errores y bordes

| Situación | Comportamiento |
|---|---|
| PostgreSQL caído a la hora del informe | No se emite; se reintenta en la vuelta siguiente; incidente si pasan 24 h |
| SMTP rechaza el envío | Queda en `email_error` y se reintenta al día siguiente; el objeto en B2 ya es la fuente de verdad |
| Reloj corrido o día repetido | La clave primaria por fecha hace idempotente todo el proceso |
| Clave de firma ausente o con permisos amplios | El servicio no arranca: mejor caer que emitir sin firmar |
| Dos schedulers a la vez | La clave primaria por fecha evita el duplicado; el segundo no reenvía el email |

## 11. Qué prueba el gate

`E1-AUD-04`, `E1-REC-01` y `E1-WA-01` en `npm run test:e1`, más el gate de escenarios
(`scripts/qa/gate-e1.mjs`). Nada sale a internet en los tests: B2 se simula y el SMTP también.
