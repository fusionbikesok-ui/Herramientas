# Evaluación externa del diseño de E1 T4 (Codex, gpt-5.6-sol, esfuerzo bajo) — 2026-09-17

Sólo lectura, sin cambios en el repo. Diseño evaluado: `specs/2026-09-17-e1-tramo4-seguridad-reporte-design.md` en el commit `ed8c220`.

La especificación no está lista para implementar. Los problemas más graves son la falta de una máquina de estados durable para firma/B2/email, la custodia insuficiente de claves y un diseño WebAuthn que omite el estado de los challenges.

## Críticos

1. **La persistencia contradice explícitamente el manejo de fallos de B2.**  
   Se promete conservar el archivo local y reintentarlo si B2 falla (§7, líneas 112–116), pero las tablas existentes obligan a tener `b2_object_key`, `b2_version_id` y retención no nulos tanto para manifiestos como reportes ([schema.sql:200](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/schema.sql:200), [schema.sql:522](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/schema.sql:522)). No existe un estado “generado/firmado pero aún no subido”.  
   Resultado: o no se registra el día hasta que B2 responda —perdiendo idempotencia durable— o se inventan identificadores. Hace falta estado explícito, por ejemplo `generated → uploaded → emailed`, con payload o ruta local, hash, intentos y timestamps.

2. **La PK por fecha no vuelve idempotentes los efectos externos.**  
   §6 líneas 102–103 y §10 líneas 158–160 afirman que evita reenvíos y resuelve dos schedulers. No evita estos cortes:

   - B2 acepta el PUT y el proceso cae antes de guardar `version_id`: el reintento crea otra versión del mismo objeto.
   - SMTP acepta el mensaje y el proceso cae antes de `email_sent_at`: se reenvía.
   - Se guarda `email_sent_at` antes del envío: una caída pierde el correo.
   - Se sube `.json` pero no `.sig`, o viceversa.

   B2 versiona sucesivos PUT del mismo nombre; incluso advierte que varias versiones en el mismo segundo pueden quedar procesadas fuera de orden ([API S3 compatible](https://www.backblaze.com/docs/en/cloud-storage-call-the-s3-compatible-api)). SMTP no ofrece exactly-once. Se necesitan IDs deterministas de entrega, estados por cada artefacto, reconciliación mediante `HEAD/GetObjectRetention` y aceptar/documentar “al menos una vez” para correo.

3. **El lock global existente no garantiza la exclusión durante el efecto externo.**  
   Ya hay un advisory lock de sesión ([exclusion.ts:9](/opt/fusionbikes/herramientas/plataforma/src/scheduler/exclusion.ts:9)), pero al perder la conexión el callback pasado por `main.ts` no hace nada ([main.ts:31](/opt/fusionbikes/herramientas/plataforma/src/scheduler/main.ts:31)). La vuelta en curso puede seguir firmando/subiendo/enviando mientras otro scheduler obtiene el lock. La PK sólo evita dos filas, no dos PUT ni dos emails.  
   Hace falta fencing durable por ejecución/día, o que cada efecto sea reclamado mediante lease/token verificado inmediatamente antes y después del side effect.

4. **WebAuthn no tiene dónde guardar el estado indispensable de la ceremonia.**  
   §8 sólo enumera rutas y credenciales. No define persistencia, TTL ni consumo único de challenges, ni su vínculo con usuario, sesión, propósito y RP. Las tablas existentes no incluyen challenges. SimpleWebAuthn exige conservar el challenge generado y pasarlo como `expectedChallenge` al verificar ([documentación 14.x](https://simplewebauthn.dev/docs/packages/server)). Guardarlo en memoria fallaría con múltiples procesos, reinicios y solicitudes concurrentes. Esto contradice “sin migraciones” (§3 líneas 53–55).

5. **“Recuperación” puede convertirse en un bypass total de WebAuthn.**  
   §8 líneas 129–132 sólo dice HMAC y un solo uso. Faltan:

   - autorización y semántica exacta de `/recuperacion`;
   - rate limiting por cuenta, IP y global;
   - protección contra enumeración de usuarios;
   - transacción que consuma el código y emita la sesión;
   - longitud/entropía del código;
   - custodia y rotación de la clave HMAC;
   - invalidación tras cambio de credenciales o sospecha de compromiso.

   Un HMAC no protege contra intentos online y, si los códigos tienen poca entropía, tampoco contra fuerza bruta tras comprometer base y clave.

## Altos

6. **Custodia de claves sin separación de privilegios.**  
   §4 y §9 bis montan en el scheduler la clave Ed25519, B2 y SMTP. Una RCE en ese proceso permite firmar evidencia falsa, subirla y enviar el correo correspondiente. Los archivos separados y `0600` no reducen ese blast radius si el mismo UID/contenedor puede leerlos todos. Debe definirse el modelo de amenaza y, como mínimo, separar el firmante o sus credenciales del componente de red, limitar UID/capabilities y restringir la clave B2 al bucket y prefijo `e1/`.

7. **La verificación de permisos es demasiado débil.**  
   §4 línea 64 sólo rechaza bits de grupo/otros, copiando la guarda actual. No verifica dueño esperado, tipo de archivo, hardlinks/symlink, ubicación real ni que el directorio padre no sea escribible por otro usuario. Tampoco define generación atómica, backup offline, recuperación por pérdida, revocación o ceremonia de rotación de la clave privada.

8. **La firma no tiene un formato interoperable definido.**  
   “Claves ordenadas, sin espacios” (§4 líneas 59–61) no define canonicalización de números, Unicode, claves anidadas ni bytes exactos. Por eso es falsa la afirmación de que “cualquiera verifica” sin el código propio. Debe fijarse un estándar, por ejemplo RFC 8785/JCS, codificación UTF-8 exacta, formato de firma, significado de `kid` y un envelope versionado.

9. **Object Lock está probado sólo contra un simulador.**  
   El diseño no exige comprobar en B2 real:

   - que el bucket tenga Object Lock habilitado;
   - región/endpoint y SigV4;
   - que la respuesta contenga `x-amz-version-id`;
   - que `GetObjectRetention` devuelva GOVERNANCE y la fecha esperada;
   - que la clave no pueda borrar ni acortar retención.

   B2 sólo aplica retención si el bucket tiene Object Lock habilitado, y una retención governance puede alterarse con capacidades adecuadas ([Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)). El PUT usa `x-amz-object-lock-mode` y `x-amz-object-lock-retain-until-date`, y devuelve el version ID por header ([S3 Put Object](https://www.backblaze.com/apidocs/s3-put-object)). El simulador sólo prueba que el cliente mandó algo parecido.

10. **Governance no equivale a inmutabilidad frente al dueño de la cuenta.**  
    Quitar `deleteFiles` y `bypassGovernance` a la clave de la app es correcto para limitar esa credencial, pero no impide que una clave administrativa cree otra con esos permisos o cambie la retención. La documentación de B2 confirma que governance puede ser anulada por una credencial con capacidad apropiada ([capacidades](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities)). Si el requisito es evidencia resistente al administrador comprometido, corresponde `COMPLIANCE`, otra cuenta o una copia independiente. La spec debe declarar qué atacante cubre.

11. **Falta lectura de retención para verificar lo almacenado.**  
    La clave propuesta sólo tiene escritura (§7 líneas 109–111). Para reconciliar un timeout ambiguo y demostrar que el objeto quedó bloqueado necesita al menos acceso acotado de lectura/`readFileRetentions`, posiblemente mediante una segunda clave verificadora. Las capacidades S3 de retención son separadas ([app keys S3](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys)).

12. **“365 días” puede quedar por debajo de 365 días reales.**  
    Si `retain_until` se calcula antes de colas/reintentos, al momento de subir ya quedan menos de 365 días. Además, la restricción SQL compara contra `created_at`, no contra el timestamp efectivo del PUT. Debe definirse `retain_until = hora confirmada de subida + 365 días` —con margen— y verificarlo contra B2.

13. **La versión “14.x” es demasiado abierta para seguridad.**  
    Debe fijarse como mínimo `14.0.2`: esa versión corrigió dos vulnerabilidades moderadas de validación de cadenas de certificados ([changelog oficial](https://github.com/MasterKale/SimpleWebAuthn/blob/master/CHANGELOG.md)). “14.x” permitiría instalar 14.0.0 o 14.0.1.

14. **Faltan parámetros de seguridad WebAuthn.**  
    No están definidos `rpID`, `expectedOrigin`, política de `userVerification`, attestation, resident credentials, `userHandle`, protección CSRF de registro/reautenticación ni qué sesión autoriza registrar una credencial. SimpleWebAuthn 14 espera verificar origin, RP ID y challenge, y usa un `WebAuthnCredential` con clave pública y contador ([documentación 14.x](https://simplewebauthn.dev/docs/packages/server)). La tabla tampoco conserva explícitamente el WebAuthn user ID recomendado.

15. **La regla del contador está formulada como un requisito universal falso.**  
    §8 línea 132 exige que “no retrocede”. Algunos autenticadores mantienen siempre contador `0`, especialmente credenciales multidispositivo; SimpleWebAuthn ya aplica la regla condicional cuando alguno de los contadores es mayor que cero ([código oficial](https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/authentication/verifyAuthenticationResponse.ts)). El test debe seguir la semántica de la biblioteca, no exigir incremento universal. También deben actualizarse transaccionalmente contador y flags de backup después de autenticar.

## Medios y casos borde

16. **El día del manifiesto y el día del reporte no usan la misma zona.**  
    El manifiesto usa UTC (§5 línea 74); el scheduler corre 07:00 ART (§2 línea 28); el resumen existente usa `America/Argentina/Buenos_Aires` ([sombra.ts:132](/opt/fusionbikes/herramientas/plataforma/src/observabilidad/sombra.ts:132)). No se define si a las 07:00 se reporta el día ART anterior, el UTC anterior o las últimas 24 horas. Tampoco qué ocurre en el primer día o tras varios días caído.

17. **El resumen existente no representa un día calendario cerrado.**  
    `medirPlataforma` consulta ventanas móviles de 24 horas y 30 minutos, y `guardarResumenDiario` sobrescribe continuamente la fila del día ([sombra.ts:40](/opt/fusionbikes/herramientas/plataforma/src/observabilidad/sombra.ts:40), [sombra.ts:136](/opt/fusionbikes/herramientas/plataforma/src/observabilidad/sombra.ts:136)). Firmarlo a las 07:00 no demuestra paridad del día anterior. Hay que congelar límites `[desde, hasta)` y consultar todas las métricas con esos mismos límites.

18. **No hay snapshot consistente para el manifiesto.**  
    §5 no exige una transacción `REPEATABLE READ` ni fija el extremo de la cadena antes de verificar. Inserciones concurrentes pueden hacer que conteo, primer/último sequence, último hash y `verify_chain` describan estados distintos. Debe capturarse `last_chain_seq` y verificar exactamente hasta ese valor dentro del mismo snapshot.

19. **El caso “día sin eventos” es ambiguo.**  
    §5 línea 80 pide “último hash conocido”, pero no define si `first_chain_seq`/`last_chain_seq` son nulos, pertenecen al día anterior o delimitan un rango vacío. La FK admite nulos, pero `last_hash` no. Eso debe formar parte del formato firmado y del test.

20. **Los reintentos están acoplados incorrectamente al día siguiente.**  
    B2 se reintenta “en cada vuelta” (§7), SMTP “al día siguiente” (§10). Con vueltas cada 30 segundos, faltan backoff, jitter, clasificación de errores terminales, límites y protección contra una credencial inválida que genere tráfico continuo. Esperar un día para SMTP tampoco cumple un aviso operativo oportuno.

21. **El pendiente local no tiene garantías de durabilidad.**  
    No se especifican escritura temporal + `fsync` + rename atómico, permisos y dueño del directorio, cuota/disco lleno, verificación de firma antes de reintentar ni qué ocurre si la base y el directorio discrepan. Limpiar el archivo inmediatamente después del PUT también es inseguro hasta persistir el version ID y comprobar retención.

22. **“Un salto se ve solo” no sustituye monitoreo.**  
    §6 líneas 98–99 sólo permite detectar un correo faltante cuando llega uno posterior; una caída definitiva no se detecta nunca. Además contradice el incidente a las 24 h prometido para B2/DB. Hace falta heartbeat externo o monitor que no dependa del mismo scheduler.

23. **No se define tamaño ni sensibilidad de adjuntos.**  
    Falta límite de tamaño, timeout SMTP, rechazo por tamaño y política sobre identificadores incluidos. Si el JSON contiene IDs operativos, el email crea una copia adicional fuera de B2 sin retención ni control equivalente.

## ¿Quedan demostrados los escenarios?

- **E1-AUD-04: no.** El gate sólo exige un día con eventos, firma, retención y simulador ([test-e1.md:50](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/test-e1.md:50)). No demuestra snapshot consistente, día vacío, cadena rota, corte entre los dos objetos, reintento ambiguo, permisos reales de B2 ni imposibilidad de borrar/acortar.

- **E1-REC-01: no.** Un “día simulado” con S3 y SMTP simulados ([test-e1.md:78](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/test-e1.md:78)) prueba ensamblaje, no paridad real, límites diarios, continuidad de siete días, entrega SMTP real, Object Lock real ni recuperación después de fallos parciales. Tampoco prueba que cada faltante “explicado” esté respaldado por evidencia durable.

- **E1-WA-01: sólo parcialmente.** Puede probar llamadas de biblioteca con un autenticador virtual y que el flag devuelva 503, pero no la seguridad del challenge, concurrencia, reinicio, RP/origin, sesión, rate limits ni navegador/origen HTTPS reales. Además, si todas las rutas públicas devuelven 503, las pruebas funcionales necesariamente usan un bypass o configuración distinta; el gate debe probar explícitamente ambos modos y que el bypass no exista en producción.

## YAGNI

- Implementar ahora login, reautenticación y recuperación completos detrás de un flag permanentemente apagado, sin dominio, HTTPS, usuarios ni UI (§8), adelanta decisiones de E4 y obliga a inventar contratos que aún no existen. Para E1 alcanzaría fijar dependencia/versiones, modelo de datos y un arnés aislado; la exposición de rutas reales debería esperar.
- Incluir la clave pública completa en cada correo (§4 y §6) no agrega confianza: quien recibe el correo necesita una clave anclada por un canal independiente. Basta `kid`, fingerprint y ubicación estable.
- Dos archivos por artefacto (`.json` y `.sig`) duplican los cortes parciales. Un envelope firmado único sería más simple, salvo que exista un consumidor contractual que requiera firma separada.
- “Cuatro piezas de una responsabilidad” (§3) no es el problema; lo que sobra es diseñar módulos antes de definir el estado transaccional común. Sin una única máquina durable de entrega, esa separación aumenta los puntos de fallo.

No modifiqué archivos ni ejecuté servidores o pruebas.
tokens used
82,723
La especificación no está lista para implementar. Los problemas más graves son la falta de una máquina de estados durable para firma/B2/email, la custodia insuficiente de claves y un diseño WebAuthn que omite el estado de los challenges.

## Críticos

1. **La persistencia contradice explícitamente el manejo de fallos de B2.**  
   Se promete conservar el archivo local y reintentarlo si B2 falla (§7, líneas 112–116), pero las tablas existentes obligan a tener `b2_object_key`, `b2_version_id` y retención no nulos tanto para manifiestos como reportes ([schema.sql:200](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/schema.sql:200), [schema.sql:522](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/schema.sql:522)). No existe un estado “generado/firmado pero aún no subido”.  
   Resultado: o no se registra el día hasta que B2 responda —perdiendo idempotencia durable— o se inventan identificadores. Hace falta estado explícito, por ejemplo `generated → uploaded → emailed`, con payload o ruta local, hash, intentos y timestamps.

2. **La PK por fecha no vuelve idempotentes los efectos externos.**  
   §6 líneas 102–103 y §10 líneas 158–160 afirman que evita reenvíos y resuelve dos schedulers. No evita estos cortes:

   - B2 acepta el PUT y el proceso cae antes de guardar `version_id`: el reintento crea otra versión del mismo objeto.
   - SMTP acepta el mensaje y el proceso cae antes de `email_sent_at`: se reenvía.
   - Se guarda `email_sent_at` antes del envío: una caída pierde el correo.
   - Se sube `.json` pero no `.sig`, o viceversa.

   B2 versiona sucesivos PUT del mismo nombre; incluso advierte que varias versiones en el mismo segundo pueden quedar procesadas fuera de orden ([API S3 compatible](https://www.backblaze.com/docs/en/cloud-storage-call-the-s3-compatible-api)). SMTP no ofrece exactly-once. Se necesitan IDs deterministas de entrega, estados por cada artefacto, reconciliación mediante `HEAD/GetObjectRetention` y aceptar/documentar “al menos una vez” para correo.

3. **El lock global existente no garantiza la exclusión durante el efecto externo.**  
   Ya hay un advisory lock de sesión ([exclusion.ts:9](/opt/fusionbikes/herramientas/plataforma/src/scheduler/exclusion.ts:9)), pero al perder la conexión el callback pasado por `main.ts` no hace nada ([main.ts:31](/opt/fusionbikes/herramientas/plataforma/src/scheduler/main.ts:31)). La vuelta en curso puede seguir firmando/subiendo/enviando mientras otro scheduler obtiene el lock. La PK sólo evita dos filas, no dos PUT ni dos emails.  
   Hace falta fencing durable por ejecución/día, o que cada efecto sea reclamado mediante lease/token verificado inmediatamente antes y después del side effect.

4. **WebAuthn no tiene dónde guardar el estado indispensable de la ceremonia.**  
   §8 sólo enumera rutas y credenciales. No define persistencia, TTL ni consumo único de challenges, ni su vínculo con usuario, sesión, propósito y RP. Las tablas existentes no incluyen challenges. SimpleWebAuthn exige conservar el challenge generado y pasarlo como `expectedChallenge` al verificar ([documentación 14.x](https://simplewebauthn.dev/docs/packages/server)). Guardarlo en memoria fallaría con múltiples procesos, reinicios y solicitudes concurrentes. Esto contradice “sin migraciones” (§3 líneas 53–55).

5. **“Recuperación” puede convertirse en un bypass total de WebAuthn.**  
   §8 líneas 129–132 sólo dice HMAC y un solo uso. Faltan:

   - autorización y semántica exacta de `/recuperacion`;
   - rate limiting por cuenta, IP y global;
   - protección contra enumeración de usuarios;
   - transacción que consuma el código y emita la sesión;
   - longitud/entropía del código;
   - custodia y rotación de la clave HMAC;
   - invalidación tras cambio de credenciales o sospecha de compromiso.

   Un HMAC no protege contra intentos online y, si los códigos tienen poca entropía, tampoco contra fuerza bruta tras comprometer base y clave.

## Altos

6. **Custodia de claves sin separación de privilegios.**  
   §4 y §9 bis montan en el scheduler la clave Ed25519, B2 y SMTP. Una RCE en ese proceso permite firmar evidencia falsa, subirla y enviar el correo correspondiente. Los archivos separados y `0600` no reducen ese blast radius si el mismo UID/contenedor puede leerlos todos. Debe definirse el modelo de amenaza y, como mínimo, separar el firmante o sus credenciales del componente de red, limitar UID/capabilities y restringir la clave B2 al bucket y prefijo `e1/`.

7. **La verificación de permisos es demasiado débil.**  
   §4 línea 64 sólo rechaza bits de grupo/otros, copiando la guarda actual. No verifica dueño esperado, tipo de archivo, hardlinks/symlink, ubicación real ni que el directorio padre no sea escribible por otro usuario. Tampoco define generación atómica, backup offline, recuperación por pérdida, revocación o ceremonia de rotación de la clave privada.

8. **La firma no tiene un formato interoperable definido.**  
   “Claves ordenadas, sin espacios” (§4 líneas 59–61) no define canonicalización de números, Unicode, claves anidadas ni bytes exactos. Por eso es falsa la afirmación de que “cualquiera verifica” sin el código propio. Debe fijarse un estándar, por ejemplo RFC 8785/JCS, codificación UTF-8 exacta, formato de firma, significado de `kid` y un envelope versionado.

9. **Object Lock está probado sólo contra un simulador.**  
   El diseño no exige comprobar en B2 real:

   - que el bucket tenga Object Lock habilitado;
   - región/endpoint y SigV4;
   - que la respuesta contenga `x-amz-version-id`;
   - que `GetObjectRetention` devuelva GOVERNANCE y la fecha esperada;
   - que la clave no pueda borrar ni acortar retención.

   B2 sólo aplica retención si el bucket tiene Object Lock habilitado, y una retención governance puede alterarse con capacidades adecuadas ([Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)). El PUT usa `x-amz-object-lock-mode` y `x-amz-object-lock-retain-until-date`, y devuelve el version ID por header ([S3 Put Object](https://www.backblaze.com/apidocs/s3-put-object)). El simulador sólo prueba que el cliente mandó algo parecido.

10. **Governance no equivale a inmutabilidad frente al dueño de la cuenta.**  
    Quitar `deleteFiles` y `bypassGovernance` a la clave de la app es correcto para limitar esa credencial, pero no impide que una clave administrativa cree otra con esos permisos o cambie la retención. La documentación de B2 confirma que governance puede ser anulada por una credencial con capacidad apropiada ([capacidades](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities)). Si el requisito es evidencia resistente al administrador comprometido, corresponde `COMPLIANCE`, otra cuenta o una copia independiente. La spec debe declarar qué atacante cubre.

11. **Falta lectura de retención para verificar lo almacenado.**  
    La clave propuesta sólo tiene escritura (§7 líneas 109–111). Para reconciliar un timeout ambiguo y demostrar que el objeto quedó bloqueado necesita al menos acceso acotado de lectura/`readFileRetentions`, posiblemente mediante una segunda clave verificadora. Las capacidades S3 de retención son separadas ([app keys S3](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys)).

12. **“365 días” puede quedar por debajo de 365 días reales.**  
    Si `retain_until` se calcula antes de colas/reintentos, al momento de subir ya quedan menos de 365 días. Además, la restricción SQL compara contra `created_at`, no contra el timestamp efectivo del PUT. Debe definirse `retain_until = hora confirmada de subida + 365 días` —con margen— y verificarlo contra B2.

13. **La versión “14.x” es demasiado abierta para seguridad.**  
    Debe fijarse como mínimo `14.0.2`: esa versión corrigió dos vulnerabilidades moderadas de validación de cadenas de certificados ([changelog oficial](https://github.com/MasterKale/SimpleWebAuthn/blob/master/CHANGELOG.md)). “14.x” permitiría instalar 14.0.0 o 14.0.1.

14. **Faltan parámetros de seguridad WebAuthn.**  
    No están definidos `rpID`, `expectedOrigin`, política de `userVerification`, attestation, resident credentials, `userHandle`, protección CSRF de registro/reautenticación ni qué sesión autoriza registrar una credencial. SimpleWebAuthn 14 espera verificar origin, RP ID y challenge, y usa un `WebAuthnCredential` con clave pública y contador ([documentación 14.x](https://simplewebauthn.dev/docs/packages/server)). La tabla tampoco conserva explícitamente el WebAuthn user ID recomendado.

15. **La regla del contador está formulada como un requisito universal falso.**  
    §8 línea 132 exige que “no retrocede”. Algunos autenticadores mantienen siempre contador `0`, especialmente credenciales multidispositivo; SimpleWebAuthn ya aplica la regla condicional cuando alguno de los contadores es mayor que cero ([código oficial](https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/authentication/verifyAuthenticationResponse.ts)). El test debe seguir la semántica de la biblioteca, no exigir incremento universal. También deben actualizarse transaccionalmente contador y flags de backup después de autenticar.

## Medios y casos borde

16. **El día del manifiesto y el día del reporte no usan la misma zona.**  
    El manifiesto usa UTC (§5 línea 74); el scheduler corre 07:00 ART (§2 línea 28); el resumen existente usa `America/Argentina/Buenos_Aires` ([sombra.ts:132](/opt/fusionbikes/herramientas/plataforma/src/observabilidad/sombra.ts:132)). No se define si a las 07:00 se reporta el día ART anterior, el UTC anterior o las últimas 24 horas. Tampoco qué ocurre en el primer día o tras varios días caído.

17. **El resumen existente no representa un día calendario cerrado.**  
    `medirPlataforma` consulta ventanas móviles de 24 horas y 30 minutos, y `guardarResumenDiario` sobrescribe continuamente la fila del día ([sombra.ts:40](/opt/fusionbikes/herramientas/plataforma/src/observabilidad/sombra.ts:40), [sombra.ts:136](/opt/fusionbikes/herramientas/plataforma/src/observabilidad/sombra.ts:136)). Firmarlo a las 07:00 no demuestra paridad del día anterior. Hay que congelar límites `[desde, hasta)` y consultar todas las métricas con esos mismos límites.

18. **No hay snapshot consistente para el manifiesto.**  
    §5 no exige una transacción `REPEATABLE READ` ni fija el extremo de la cadena antes de verificar. Inserciones concurrentes pueden hacer que conteo, primer/último sequence, último hash y `verify_chain` describan estados distintos. Debe capturarse `last_chain_seq` y verificar exactamente hasta ese valor dentro del mismo snapshot.

19. **El caso “día sin eventos” es ambiguo.**  
    §5 línea 80 pide “último hash conocido”, pero no define si `first_chain_seq`/`last_chain_seq` son nulos, pertenecen al día anterior o delimitan un rango vacío. La FK admite nulos, pero `last_hash` no. Eso debe formar parte del formato firmado y del test.

20. **Los reintentos están acoplados incorrectamente al día siguiente.**  
    B2 se reintenta “en cada vuelta” (§7), SMTP “al día siguiente” (§10). Con vueltas cada 30 segundos, faltan backoff, jitter, clasificación de errores terminales, límites y protección contra una credencial inválida que genere tráfico continuo. Esperar un día para SMTP tampoco cumple un aviso operativo oportuno.

21. **El pendiente local no tiene garantías de durabilidad.**  
    No se especifican escritura temporal + `fsync` + rename atómico, permisos y dueño del directorio, cuota/disco lleno, verificación de firma antes de reintentar ni qué ocurre si la base y el directorio discrepan. Limpiar el archivo inmediatamente después del PUT también es inseguro hasta persistir el version ID y comprobar retención.

22. **“Un salto se ve solo” no sustituye monitoreo.**  
    §6 líneas 98–99 sólo permite detectar un correo faltante cuando llega uno posterior; una caída definitiva no se detecta nunca. Además contradice el incidente a las 24 h prometido para B2/DB. Hace falta heartbeat externo o monitor que no dependa del mismo scheduler.

23. **No se define tamaño ni sensibilidad de adjuntos.**  
    Falta límite de tamaño, timeout SMTP, rechazo por tamaño y política sobre identificadores incluidos. Si el JSON contiene IDs operativos, el email crea una copia adicional fuera de B2 sin retención ni control equivalente.

## ¿Quedan demostrados los escenarios?

- **E1-AUD-04: no.** El gate sólo exige un día con eventos, firma, retención y simulador ([test-e1.md:50](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/test-e1.md:50)). No demuestra snapshot consistente, día vacío, cadena rota, corte entre los dos objetos, reintento ambiguo, permisos reales de B2 ni imposibilidad de borrar/acortar.

- **E1-REC-01: no.** Un “día simulado” con S3 y SMTP simulados ([test-e1.md:78](/opt/fusionbikes/herramientas/docs/superpowers/specs/e1/test-e1.md:78)) prueba ensamblaje, no paridad real, límites diarios, continuidad de siete días, entrega SMTP real, Object Lock real ni recuperación después de fallos parciales. Tampoco prueba que cada faltante “explicado” esté respaldado por evidencia durable.

- **E1-WA-01: sólo parcialmente.** Puede probar llamadas de biblioteca con un autenticador virtual y que el flag devuelva 503, pero no la seguridad del challenge, concurrencia, reinicio, RP/origin, sesión, rate limits ni navegador/origen HTTPS reales. Además, si todas las rutas públicas devuelven 503, las pruebas funcionales necesariamente usan un bypass o configuración distinta; el gate debe probar explícitamente ambos modos y que el bypass no exista en producción.

## YAGNI

- Implementar ahora login, reautenticación y recuperación completos detrás de un flag permanentemente apagado, sin dominio, HTTPS, usuarios ni UI (§8), adelanta decisiones de E4 y obliga a inventar contratos que aún no existen. Para E1 alcanzaría fijar dependencia/versiones, modelo de datos y un arnés aislado; la exposición de rutas reales debería esperar.
- Incluir la clave pública completa en cada correo (§4 y §6) no agrega confianza: quien recibe el correo necesita una clave anclada por un canal independiente. Basta `kid`, fingerprint y ubicación estable.
- Dos archivos por artefacto (`.json` y `.sig`) duplican los cortes parciales. Un envelope firmado único sería más simple, salvo que exista un consumidor contractual que requiera firma separada.
- “Cuatro piezas de una responsabilidad” (§3) no es el problema; lo que sobra es diseñar módulos antes de definir el estado transaccional común. Sin una única máquina durable de entrega, esa separación aumenta los puntos de fallo.

No modifiqué archivos ni ejecuté servidores o pruebas.
