# Salida a producción de la App iOS — diseño

Decidido el 2026-09-08. Cubre cómo se gasta lo que queda de cuota de builds, por qué canal se
distribuye la app, qué capacidad nativa se compromete ahora, y en qué orden.

## El problema

La App tiene que quedar publicada y operativa para todas las áreas de la empresa, y el
roadmap de lo que cada área va a pedir **no está definido**. Al mismo tiempo, cada capacidad
nativa nueva obliga a una build, y las builds son un recurso escaso y compartido por mes.

De ahí la tensión que este documento resuelve: no se puede armar "la build completa" a partir
de una lista de funcionalidades, porque esa lista no existe todavía. Hay que armarla para que
**no haga falta otra**.

## Lo que se verificó antes de decidir

Nada de esto se asumió; se comprobó, y varias comprobaciones contradijeron lo que creíamos.

| Creencia previa | Lo que se verificó |
| --- | --- |
| "Quedan 2 builds y se acabó" | El free tier da **15 builds de iOS por mes y se renuevan**. En septiembre se usaron 10, así que quedan ~5 este mes y 15 en octubre. |
| "Las builds fallaron por el código" | Las builds 7, 8 y 9 fallaron en *Configure expo-updates* a las 14:25, 14:26 y 14:30, y la 10 salió bien a las 14:33 **sin ningún commit entre medio**. Fueron transitorias, encadenadas sobre una build en curso, con concurrencia 1. |
| "Custom App se puede pasar a pública después" | **No.** Una app aprobada con distribución privada exige un registro nuevo en App Store Connect para publicarse, o sea otro identificador y reinstalar en todos los teléfonos. |
| "La push falla a veces" | La push **nunca funcionó**, por dos causas independientes (ver §4). |

La cuenta de builds y el ciclo exacto se confirman en
`expo.dev/accounts/<cuenta>/settings/billing`; la política documentada es la citada arriba.

## 1. Canal de distribución: Unlisted

Se distribuye por **Unlisted App Distribution**: registro público de App Store, invisible en
búsquedas, categorías y rankings, accesible sólo por link directo.

Se descartó **Custom App (Apple Business Manager)** pese a encajar bien, por una única razón
decisiva: es un camino de ida. Si más adelante se quiere listar la app públicamente, hay que
crear un registro nuevo con otro identificador, y eso obliga a desinstalar y reinstalar en
todos los dispositivos. Unlisted da en la práctica la misma privacidad y deja esa puerta
abierta con un cambio de ajuste.

Se descartó **App Store pública** por el riesgo de rechazo bajo la guía 4.2 (utilidad mínima
para el público general), que es el caso típico de una app detrás de login corporativo. Apple
nombra explícitamente *employee resources* como candidato ideal de Unlisted, lo que baja ese
riesgo sin eliminarlo.

**Riesgo aceptado:** Unlisted se solicita por un formulario aparte después de enviar a
revisión, y la aprobación no es automática. Si Apple la rechaza, queda una app pública normal,
que es el escenario con más exposición a la guía 4.2.

**Requisito que Unlisted agrega:** Apple pide un mecanismo dentro de la app que impida el uso
no autorizado, porque cualquiera con el link puede descargarla. Ya está cubierto por el login
corporativo más el vínculo de dispositivo, y hay que decirlo en las notas del revisor.

El registro actual (`com.fusionbikes.operaciones`, App ID 6809237367) sirve: el método de
distribución se fija al aprobarse y la app sigue en TestFlight sin aprobar.

## 2. El criterio de sobreaprovisionamiento

> **Se sobreaprovisiona capacidad que no pide permiso. No se sobreaprovisionan permisos.**

Un módulo nativo sin permiso cuesta tamaño de app y nada más. Un permiso declarado y no usado
cuesta una pregunta del revisor cuya respuesta honesta —"por si más adelante"— no pasa
revisión. Por eso la lista de abajo es deliberadamente generosa en lo primero y estricta en lo
segundo.

## 3. Superficie nativa comprometida

### Sin permiso — entran todos (13)

`expo-print` · `expo-sharing` · `expo-file-system` · `expo-document-picker` ·
`expo-clipboard` · `expo-haptics` · `expo-keep-awake` · `expo-network` · `expo-device` ·
`expo-web-browser` · `expo-linking` · `expo-screen-orientation` · `expo-mail-composer`

Los 17 módulos evaluados existen en SDK 57; se verificó contra npm antes de comprometerlos.

Cubren: imprimir etiquetas y órdenes de trabajo, adjuntar y compartir documentos, detectar
falta de señal (precondición del offline de bandeja que quedó para E13), mantener la pantalla
encendida en un puesto de escaneo, y confirmar un escaneo con vibración.

### Con permiso — entran dos, por decisión explícita

- **`expo-location`** — reparto y despacho. Requiere `NSLocationWhenInUseUsageDescription` y
  declaración de privacidad de datos.
- **`expo-background-task` + `expo-task-manager`** — sincronización con la app cerrada.
  Requiere `UIBackgroundModes` / `BGTaskSchedulerPermittedIdentifiers`.

### Obligatorio para revisión

- **`ios.privacyManifests`** (`PrivacyInfo.xcprivacy`), declarando las *required reason APIs*
  que ya se usan: `expo-secure-store`, `expo-file-system`, acceso a disco y `expo-device`. Su
  ausencia es rechazo automático en el envío, y va dentro del binario.

### Deliberadamente fuera

**Bluetooth** (`react-native-ble-plx`, para impresoras de etiquetas tipo Zebra). No es módulo
de Expo, necesita config plugin y `NSBluetoothAlwaysUsageDescription`.

**Riesgo aceptado:** si el depósito adopta impresión Bluetooth, cuesta una build.

### Se aprovecha el viaje

Como la build va a hacerse igual, se actualizan las dependencias de Expo pendientes
(`expo@57.0.20`, `expo-constants`, `expo-dev-client`, `expo-notifications`,
`expo-secure-store`). Cualquiera de ellas por separado habría costado una build propia.

## 4. Push: causa raíz y por qué va primero

La push **nunca llegó**, y son dos fallas independientes. Ninguna se arregla con una build.

**4.1 El token nunca llega al backend.** En `routes/mobileAuth.js:70` la rama de `device_uid`
se evalúa antes que la de `push_token` y retorna temprano. El login manda `device_uid`, así
que guarda `uid:<...>` y termina ahí. Los 10 registros de `device_tokens` son de login; de la
ruta de push no hay ninguno. Aunque el emisor funcionara, no tendría destino.

**4.2 El backend no puede entregar a iOS.** `validarConfiguracionPush` sólo resuelve entre
`mock` y `fcm`; no hay camino APNs ni Expo Push. La app no tiene Firebase iOS configurado —no
hay `googleServicesFile` ni dependencia de Firebase—, así que FCM no puede alcanzar un iPhone.
En `mock`, `enviarNotificacion` devuelve `ok: true` sin enviar nada, que es la razón de que el
backend se viera sano todo este tiempo.

**Consecuencia para el plan:** la build 10 ya instalada **puede recibir push** —el entitlement
y `expo-notifications` están puestos—. Se arregla el emisor en el VPS, se corrige el registro
del token, se publica por OTA sobre la build 10 y se verifica en el teléfono. Todo eso ocurre
**antes** de gastar cuota, lo que convierte la mayor incógnita de la app en algo probado en
lugar de algo que se descubre durante la revisión de Apple.

## 5. Secuencia

| Paso | Qué | Build |
| --- | --- | --- |
| **0** | Arreglar push (backend + OTA) y verificarla de punta a punta en la build 10 | No |
| **A** | Development client con toda la superficie nativa nueva | Sí |
| **B** | Producción completa → TestFlight → revisión + solicitud de unlisted | Sí |
| **C** | Reservada, sólo para lo que devuelva la revisión | Sólo si hace falta |

El development build es lo que hace que la de producción no falle. Hoy dudar de algo nativo
cuesta un ciclo de build de producción; con un dev client actualizado cuesta cero, y por eso
se gasta una build en algo que no se publica.

En paralelo, y **sin consumir ninguna build**: política de privacidad publicada en una URL
accesible, declaraciones de privacidad de datos, capturas, descripción, clasificación por
edad, cuenta de demo para el revisor, y notas declarando la intención unlisted y el acceso
corporativo.

## 6. Reglas de proceso

Valen más que el contenido: 3 de 10 builds se perdieron por no seguirlas.

1. **Una build por vez, esperando a que termine.** La concurrencia del free tier es 1.
2. **Antes de cada build:** `expo-doctor` limpio, `tsc --noEmit` limpio, suite verde, y
   verificar que el fingerprint del runtime cambió como se espera.
3. **Nada de reintentar a ciegas.** Ante una falla se lee el log de la fase que falló antes de
   volver a lanzar.

## 7. Criterios de éxito

- Una push enviada desde el VPS llega a un iPhone real y su acción rápida funciona, **sobre la
  build 10**, antes de gastar cuota.
- El dev client carga los 16 módulos nativos nuevos (13 sin permiso + `expo-location` +
  `expo-background-task` + `expo-task-manager`) y cada permiso pide lo que corresponde.
- La build de producción se envía a revisión con el manifiesto de privacidad y la solicitud de
  unlisted, sin rechazos por configuración.
- Ninguna capacidad nativa prevista queda fuera obligando a una build no planificada.
