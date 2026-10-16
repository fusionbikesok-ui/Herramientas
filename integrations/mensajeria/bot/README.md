# Fusion Bikes · Chatbot omnicanal

Servicio para instalar en el VPS de Fusion Bikes. Unifica:

- Chat Web de `fusionbikes.com.ar`.
- WhatsApp Ventas (número terminado en 4819).
- WhatsApp Posventa/Taller (número terminado en 2035).
- Atención automática de “Fabri IA”.
- Derivación y respuesta humana desde el panel de WooCommerce.

El servicio no reemplaza el plugin existente: el VPS ejecuta la IA, recibe los webhooks de Meta y envía los mensajes; WordPress conserva la bandeja multiagente.

## Componentes

- `api`: recibe eventos firmados de WordPress y webhooks de Meta.
- `worker`: procesa conversaciones y ejecuta la IA fuera de la petición del cliente.
- `postgres`: idempotencia, conversaciones e historial técnico.
- `redis`: cola persistente de trabajos.
- Plugin WordPress `Fusion Bikes - Live Chat 1.4.0`: bandeja omnicanal.

El puerto local predeterminado es `8091`, elegido para no interferir con el servicio existente de Fusion Vision.

## Antes de instalar

Se necesita:

- Ubuntu 22.04/24.04 o equivalente.
- Docker Engine y Docker Compose v2.
- Nginx y un certificado válido para `bot.fusionbikes.com.ar`.
- Acceso administrador a Meta Business de Fusion Bikes.
- Los dos `Phone Number ID` de WhatsApp, el App Secret y un token permanente.
- Un modelo local con API compatible con OpenAI, o cambiar `AI_BASE_URL` por el endpoint que ya utiliza el VPS.

No pegar claves en conversaciones, capturas ni archivos ZIP. Se guardan solamente en `.env`, con permisos `600`.

## 1. Instalar el servicio

Copiar y descomprimir este paquete, por ejemplo en:

```bash
sudo mkdir -p /opt/fusion-chatbot
sudo chown "$USER":"$USER" /opt/fusion-chatbot
cd /opt/fusion-chatbot
```

Dar permisos y ejecutar:

```bash
chmod +x scripts/install.sh scripts/doctor.sh
./scripts/install.sh
```

El instalador crea `.env` con claves aleatorias y levanta los contenedores. Todavía no activa WhatsApp porque faltan los datos privados de Meta.

## 2. Completar `.env`

Editar:

```bash
nano /opt/fusion-chatbot/.env
```

Completar especialmente:

- `META_APP_SECRET`
- `WHATSAPP_ACCESS_TOKEN`
- `AI_MODEL`
- `WHATSAPP_NUMBERS_JSON`

Ejemplo de estructura para los dos números:

```dotenv
WHATSAPP_NUMBERS_JSON={"123456789012345":{"label":"Ventas","display_number":"5493515214819"},"987654321098765":{"label":"Posventa/Taller","display_number":"5493518752035"}}
```

Los números largos del ejemplo son `Phone Number ID`, no los teléfonos. Reemplazarlos por los identificadores exactos de Meta.

Después de editar:

```bash
docker compose up -d --build
./scripts/doctor.sh
```

## 3. Publicar `bot.fusionbikes.com.ar`

1. Crear el registro DNS `bot` apuntando al VPS.
2. Copiar `nginx/bot.fusionbikes.com.ar.conf` a la configuración de Nginx.
3. Ajustar las rutas del certificado si fuera necesario.
4. Validar y recargar Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

La prueba pública debe responder JSON:

```bash
curl https://bot.fusionbikes.com.ar/health
```

`configuration_ready` será `true` cuando se hayan completado todos los valores requeridos.

## 4. Configurar Meta / WhatsApp

La URL de webhook es:

```text
https://bot.fusionbikes.com.ar/webhooks/whatsapp
```

El token de verificación es el valor privado `META_VERIFY_TOKEN` del `.env`.

En Meta:

1. Vincular primero el número de Ventas mediante el flujo oficial de coexistencia, si es elegible.
2. Registrar su `Phone Number ID` en `WHATSAPP_NUMBERS_JSON`.
3. Configurar el webhook y suscribirse al campo `messages`.
4. Probar recepción y respuesta.
5. Repetir con Posventa/Taller cuando Ventas esté estable.

No migrar ni desconectar los números de la aplicación móvil hasta verificar la elegibilidad y completar correctamente el flujo de coexistencia de Meta.

## 5. Instalar el plugin WordPress

Instalar el ZIP `fusion-live-chat-v1.4.0.zip` desde Plugins > Añadir plugin > Subir plugin.

Después abrir:

```text
WooCommerce > Chatbot y WhatsApp
```

Configurar:

- URL del VPS: `https://bot.fusionbikes.com.ar`
- API Key: el valor `FUSION_API_KEY` del VPS.
- Secreto de firma: el valor `FUSION_CALLBACK_SECRET` del VPS.
- Activar conexión.
- Activar Fabri IA.

Usar “Probar conexión con el VPS” antes de enviar mensajes reales.

## 6. Prueba controlada

Hacer las pruebas en este orden:

1. Chat Web: “Hola, busco una bicicleta Polygon”.
2. Confirmar respuesta de Fabri IA en el mismo chat.
3. Escribir “quiero hablar con un vendedor”.
4. Confirmar sonido, parpadeo y motivo de derivación en WooCommerce.
5. Tomar el chat como Fabri/José/Miguel y responder.
6. Enviar un WhatsApp al número de Ventas y repetir el flujo.
7. Responder desde WooCommerce y confirmar recepción en el teléfono cliente.
8. Recién entonces agregar el segundo número.

## Funcionamiento de la derivación

- Mientras `bot_status=active`, Fabri IA responde.
- Si la IA solicita ayuda, el estado cambia a `handoff`; el panel alerta a los agentes.
- Cuando un agente toma el chat, cambia a `paused`; cualquier respuesta tardía de la IA se descarta.
- Al liberar el chat, vuelve a `active`.

Casos que se derivan: pagos rechazados, combinación de medios, reclamos, garantías, devoluciones, consultas privadas de pedidos y pedido expreso de una persona.

Esta primera versión responde conversaciones iniciadas por el cliente. Los mensajes proactivos fuera de la ventana de atención de WhatsApp requieren plantillas aprobadas por Meta y no se envían automáticamente en esta fase.

## Diagnóstico

```bash
./scripts/doctor.sh
docker compose logs -f api worker
```

Un `HTTP 405` normalmente significa que se llamó a una ruta válida con el método equivocado. En esta versión:

- `/health`: `GET`
- `/v1/events`: `POST`
- `/v1/outbound/whatsapp`: `POST`
- `/webhooks/whatsapp`: `GET` para verificación y `POST` para eventos

## Actualización y reversión

- El plugin 1.4.0 actualiza las tablas sin borrar el historial existente.
- Mantener una copia del ZIP 1.3.8 antes de instalar.
- Para pausar la IA sin perder chats, desmarcar “Fabri IA” en WooCommerce > Chatbot y WhatsApp.
- Para detener el VPS:

```bash
docker compose stop api worker
```

- No ejecutar `docker compose down -v`: la opción `-v` eliminaría las bases persistentes.
