# E1 T4 · tarea 16 — avance de la puesta en producción (2026-09-18)

Estado: **informes encendidos el 2026-09-18 a las 12:29 UTC**, con autorización de José. La primera vuelta subió y
avisó los dos artefactos del 2026-09-17 (ver "Primera vuelta real" al final).

## Lo que ya está hecho

| Paso | Estado |
|---|---|
| Buckets en B2 | `bucket-produccion` y `bucket-verificacion`, privados, región `us-east-005`, endpoint `https://s3.us-east-005.backblazeb2.com`. Object Lock **habilitado** en los dos y cifrado por omisión SSE-B2 |
| Credenciales de B2 | `e1-escritura` (`listBuckets,listFiles,writeFiles,readFileRetentions,writeFileRetentions`) y `e1-lectura` (`listBuckets,listFiles,readFiles,readFileRetentions`), las dos acotadas a `bucket-produccion`, **sin** `deleteFiles` ni `bypassGovernance`. En `/opt/fusionbikes/plataforma-prod/secretos/b2-{escritura,lectura}-{id,clave}`, uid 1000, 0400 (ver "el dueño de los secretos" abajo) |
| Clave de firma | `kid e1-2026-09`, privada en `/opt/fusionbikes/plataforma-prod/keyring/firma-informes.pem` (uid 1000, 0400); pública commiteada en `specs/e1/firma-informes/e1-2026-09.pub`, huella SHA-256 `vxWdZOUP21/br6qbfukLe50pNE76GAwjBo50krnYYoE=` |
| Verificación contra B2 real | hecha en `bucket-verificacion` con una credencial temporal, ya borrada |
| Email | remitente y destinatario: los mismos del canal de alertas del legado (`SMTP_FROM` y `ALERTAS_EMAIL`) |

## Lo que la verificación contra B2 real encontró

Las dos cosas se corrigieron en `4929051`, con sus tests.

**1. Backblaze rechaza la subida con Object Lock si no lleva suma de verificación.** Respuesta textual:
`400 InvalidRequest — Content-MD5 OR x-amz-checksum- HTTP header is required for Put Object requests with
Object Lock parameters`. Nuestro código no la mandaba y el simulador de los tests no la exigía: **el primer
informe de producción habría fallado**. Es el caso que justifica que esta verificación no se haga con un doble.

**2. La credencial de escritura puede OCULTAR un objeto.** Un `DELETE` con esa credencial devolvió 204, aunque
no tiene `deleteFiles`: en B2 el permiso de escritura incluye ocultar. Comprobado qué pasa en realidad:

- `b2_list_file_versions` muestra dos entradas para la clave: `hide` (0 bytes, sin retención) y `upload`
  (52 bytes, `lock: compliance`). O sea que **no se destruyó nada**.
- Un `GET` sin versión devuelve **404**; el mismo `GET` con `versionId` explícito devuelve **200** y el
  contenido completo, con la credencial de lectura.

Conclusión: la evidencia es indestructible, pero se puede volver invisible para quien no sepa pedir la versión.
No se puede prevenir con permisos. Decisión de José: **hacerlo detectable**. La vuelta diaria lista las versiones
de los últimos 7 días, marca la entrega oculta (`informes.entregas.oculto_en`, migración 0012) y la ruta interna
`/internal/v1/informes/estado` la expone.

Lo que **sí** quedó verificado como rechazado: acortar la retención con la credencial de escritura devuelve
`405 MethodNotAllowed`.

## Lo que falta para terminar la tarea 16

Hechos el 2026-09-18: el vigilante alerta por informes ocultos (`3b0cf53`), el scheduler recibe la configuración y
los montajes (`d1dd0cf`), las migraciones 0009 a 0012 están aplicadas, y el primer email real salió. Queda:

1. **La campaña de 7 días verdes seguidos.** El primer reporte (17/09) salió amarillo; cuenta desde el primer día
   limpio.
2. **Rotar la clave maestra de Backblaze**, que apareció en la salida de un comando.

## Limpieza hecha

- Credencial temporal `e1-verificacion-temporal` **borrada** de B2.
- Quedó un objeto de prueba en `bucket-verificacion` y dos en `bucket-produccion`, bajo `e1/verificacion/`, con
  retención compliance hasta 2027-09-20: no se pueden borrar, y no molestan (son 52 bytes cada uno).
- La clave maestra de Backblaze está en el `.env` del legado y **apareció completa en la salida de un comando
  durante esta sesión**: conviene rotarla desde el panel de B2.

## Encendido (2026-09-18)

| Paso | Resultado |
|---|---|
| Backup de la base `plataforma` | `/root/plataforma-pgdump-antes-t4-20260918T122323Z.dump` (72 MB) |
| Imagen reconstruida y migraciones | `0009` a `0012` aplicadas; `passkeys.real=false`, `PASSKEYS_HABILITADAS` ausente |
| Servicios recreados con los informes apagados | `/api/v2/health` ok en los cuatro componentes; las rutas de passkeys responden **503** |
| Configuración de informes | 17 variables en `plataforma.env` (backup previo en `/root/plataforma-env-backup-informes-*`); montajes archivo por archivo en `deploy/compose.yml` (`d1dd0cf`), para que el scheduler no vea la contraseña del migrador |
| Credenciales de SMTP | copiadas del `.env` del legado a `secretos/smtp-{usuario,clave}`, sin mostrarlas |
| Vigilante del legado | `VIGILANTE_INFORMES_ENABLED=true` en el `.env` del legado, con un reinicio a las 15:38:30 UTC |

### Lo que el diseño decía mal: el dueño de los secretos

El diseño (§9 bis) y el plan decían que los secretos quedan **0600 root**. El primer arranque con los informes
encendidos falló con `EACCES` al abrir `b2-escritura-id`: el `entrypoint` baja los privilegios con `gosu` y **node
corre como uid 1000**, así que un archivo de root no se puede leer. Es la misma razón por la que el keyring del
tramo 3 ya era de uid 1000 con 0400. Las guardas de `src/seguridad/secreto.ts` exigen además que el dueño sea el
usuario del proceso. Corregido: los siete archivos que lee node (cuatro de B2, dos de SMTP y la privada de firma)
son de uid 1000 con permisos 0400; el directorio de pendientes es de uid 1000 con 0700. La única contraseña que
sigue siendo de root es la de PostgreSQL, que el `entrypoint` lee como root antes de bajar los privilegios.

## Primera vuelta real

| Qué | Resultado, verificado en su fuente |
|---|---|
| Entregas | `manifiesto` y `reporte` del 2026-09-17 en `subido` + `avisado`, retención hasta **2027-09-20** |
| Tablas canónicas del tramo 1 | `audit_daily_manifests` con `retention_mode=compliance`, `signing_key_id=e1-2026-09`, 3 eventos; `daily_shadow_reports` con `email_sent_at` y sin error |
| Objetos en B2 | bajados con la credencial de lectura: `e1/manifiestos/2026-09-17.json` (448 bytes) y `e1/reportes/2026-09-17.json` (802 bytes) |
| Firma | `npm run verificar-informe` sobre los dos archivos bajados de B2: **válido (kid e1-2026-09)** |
| Manifiesto | 3 eventos, cadena íntegra |
| Reporte | **amarillo**, 0 faltantes sin explicar, día de campaña 0. Motivo: `convergencia_no_declarada` en `ml.shipments`, porque el 17 la cuenta de ML no estaba en el worker y no hubo barrido. Es el reporte diciendo la verdad sobre el día del incidente |

La campaña de 7 días cuenta sólo días verdes: arranca a contar desde el primer día limpio.
