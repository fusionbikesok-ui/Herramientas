# Agente Windows de etiquetas internas

Agente local para la cola `POST /api/etiquetas/cola/reclamar`. No abre el navegador ni
marca un trabajo como impreso hasta que el comando configurado devuelve código cero.

## Instalación

1. Copiar esta carpeta a la PC del depósito.
2. Copiar `config.example.json` como `config.json` y completar la URL, el agente, el
   token secreto del agente y el comando del driver de la impresora. El token se envía
   como `Authorization: Bearer`; no debe guardarse en el repositorio ni compartirse.
3. Ejecutar `install-task.ps1` como administrador para registrar la tarea programada al
   arrancar Windows (o ejecutar `node agent.mjs --config config.json` manualmente durante
   la prueba inicial).

El comando recibe la ruta de un JSON temporal con el trabajo y debe devolver `0` si la
impresión fue aceptada por el spooler. Así se evita asumir marca o lenguaje de etiquetas:
el adaptador puede producir ZPL, TSPL, ESC/POS o usar el driver instalado.

Para la primera validación en la PC se puede ejecutar `node agent.mjs --config config.json
--once`: hace un único reclamo, intenta imprimirlo y confirma el resultado; devuelve código
distinto de cero ante error de conexión, autenticación o impresión. La tarea programada
omite `--once` y mantiene el servicio continuo.

## Recuperación

El servidor mantiene un lease de 60 segundos. Si Windows o la red caen, el trabajo vuelve
a estar disponible. Un error de impresora queda en `error` y se puede reintentar desde la
cola; la aprobación de la preparación no se revierte.
