# Corrector de etiquetas de Andreani

URL: `/herramientas/gestion-vps/corregir-etiquetas/`. Tarjeta directa en Home y Gestión; requiere administrador de la sesión existente.

Entrada y salida editables: peso (Gr), ancho, alto y largo (Cm), con los valores habituales precargados y botón para restaurarlos. Todos deben ser enteros positivos; peso hasta 6 dígitos, medidas hasta 4. Solo se corrige una página cuando coinciden los cuatro datos de entrada. Valores habituales:

```
Peso: 9000 Gr // Ancho: 20 Cm
Alto: 30 Cm // Largo: 40 Cm
```

se reemplazan por `Peso: 15000 Gr // Ancho: 25 Cm` y `Alto: 70 Cm // Largo: 150 Cm`. Se cambian los glifos/avances numéricos en los bloques originales: conserva fuentes incrustadas, páginas, orden y códigos. Si la línea se alarga, comprime su base horizontal preservando su anclaje y ancho original. Comprueba texto completo e imágenes después de escribir. Rechaza cifrado, anotaciones reales, acciones, estructuras ambiguas o fuentes/formato no compatibles. Las referencias a listas de anotaciones vacías están permitidas. No cambia pedidos ni registros del transportista.

La regla viaja en `X-Fusion-Pdf-Rule` como JSON de hasta 1024 caracteres: `{before:{weight,width,height,length},after:{weight,width,height,length}}`, con valores string. Gateway y Python validan el esquema y los números; entrada idéntica a salida da 400, sin coincidencias da 422. Sin cabecera conserva y registra los valores habituales para clientes anteriores. El worker pasa el JSON como argumento al subproceso; stdin contiene solo el PDF. Cambiar un campo o restaurar valores elimina la vista previa anterior; los campos quedan bloqueados durante corrección e impresión.

API binaria POST con `application/pdf`, Origin y CSRF existentes, 10 MiB y 300 páginas. Gateway llama sólo a `127.0.0.1:8213`, con token HMAC derivado de la clave ya existente. El worker tiene unidad propia, 384 MiB/50% CPU; cada proceso PDF limita 256 MiB y 25 s de CPU, timeout 32 s. Corrección y lectura del PDF completo comparten un único cupo; HEAD consulta sólo metadatos. SQLite espera hasta 3 s por bloqueo; proxy POST 43 s, nginx 45 s y cliente 55 s. Un resultado incierto pide revisar el historial antes de reintentar.

Desde el 15/10/2026, cada corrección exitosa guarda el PDF de salida, nombre de origen/salida, fecha UTC y día argentino, operador, regla aplicada y páginas modificadas. Archivo y metadatos se confirman en una transacción SQLite FULL antes de responder éxito. El original entrante no se persiste. Los nombres repetidos generan registros UUID distintos. No hay borrado automático ni recuperación retroactiva de archivos de versiones anteriores. Reserva mínima de disco 512 MiB más tres veces el archivo; si no se puede guardar, no se informa éxito.

Historial privado en `StateDirectory=fusion-pdf-corrector`, `/var/lib/fusion-pdf-corrector/history.sqlite3` (systemd DynamicUser, directorio 0700 y DB 0600, ubicación física bajo `/var/lib/private`). Debe incluirse en las copias de respaldo operativas; usar SQLite backup para una copia coherente mientras el servicio está activo. No incluir PDFs ni DB en Git. GET/HEAD `/corregir-etiquetas/history?q=&from=&to=&page=` y `/corregir-etiquetas/files/<uuid>` requieren la misma sesión de administrador; `?download=1` descarga. Búsqueda literal por nombre sin distinguir tildes/mayúsculas, fechas inclusivas de Argentina, 20 registros por página, últimos primero. No se acepta ruta/URL arbitraria ni identidad enviada por el navegador.

El panel empieza con Archivos listos y HOY abierto, incluso sin archivos. Las fechas anteriores se despliegan al tocarlas; no hay buscador en pantalla. Ver días anteriores agrega fechas conservando los días abiertos; completa el último día de cada página y elimina duplicados por UUID. Cada registro permite ver, imprimir o descargar sin volver a subir el original. Las descargas usan URL privada autenticada; vista e impresión reutilizan el visor existente. El formulario para corregir otro PDF queda debajo del historial. El día actual usa la fecha de Argentina.

Interfaz: carga manual, recuento/páginas modificadas, visor propio paginado PDF.js 5.6.205, impresión de todas las páginas y descarga del PDF original corregido. PDF.js se carga sólo cuando hay resultado y se sirve desde el VPS; su licencia está en assets/pdfjs/LICENSE. Para impresión genera imágenes a 288 dpi (máximo 3000 px por lado y 64 megapíxeles totales) con dimensiones físicas de cada página y abre el diálogo del navegador; imprimir al 100%. Libera imágenes al terminar/cancelar el diálogo. Si el PDF supera el presupuesto de impresión, pide descargarlo para imprimir desde un visor; el procesamiento y la descarga siguen hasta 300 páginas. La descarga conserva texto/vector originales. No se probó una impresora física.

Dependencias: pypdf 6.10.0 puro Python desde runtime Codex, empaquetado en worker/pypdf-vendor.zip; sin instalación global ni pip. Servicio `/etc/systemd/system/fusion-pdf-corrector.service`, código `/opt/fusion-pdf-corrector`.

Pruebas: `python3 pdf-corrector.test.py`; opcional `PDF_CORRECTOR_SAMPLE=/ruta/real.pdf` para muestra local, nunca copiar esa muestra al repo. `python3 -m unittest test_pdf_history test_pdf_history_http`, `node --test pdf-gateway.test.mjs pdf-history-gateway.test.mjs` y suites del gateway. `tests/labels.pdf` es sintético, sin datos personales. La prueba fuente exige sólo páginas 3/8 modificadas y 14 restantes intactas. Pruebas HTTP usan almacenamiento temporal aislado y comprueban persistencia después del reinicio.

Rollback del historial: restaurar archivos exactos y unidad del respaldo de release, daemon-reload y reiniciar sólo worker/gateway. Conservar siempre StateDirectory y su DB; no restaurar una DB antigua ni borrar archivos que se hayan guardado. Esta entrega no modifica nginx, Home, el proceso Node principal ni sus datos.

## Imprimir todos los de HOY

Impresión conjunta de HOY: botón dentro del grupo del día (deshabilitado si está vacío). Al tocarlo vuelve a consultar los archivos de esa fecha argentina y recupera cada UUID con la sesión existente, en el mismo orden de la lista y de las páginas. Prepara todos los PDFs antes de abrir un único diálogo; un error no imprime un grupo parcial. No crea otro archivo histórico ni modifica los existentes. Cancelar preparación / Volver al panel y pagehide liberan recursos; afterprint libera controles y no confirma una impresión física. Si print() no inicia beforeprint, se informa error recuperable. Impresión individual conservada.

Límites del grupo: 60 MiB de PDFs, 300 páginas, 64 megapíxeles de imágenes y 3000 px por lado. Mantiene dimensiones físicas; preferencia de 288 dpi y ajuste del grupo hasta 200 dpi antes del límite por lado. Si excede el presupuesto, pide imprimir por archivo. Recursos temporales eliminados al cerrar, cancelar o fallar. Verificado con 3 PDFs sintéticos de 16 páginas (48 en un único iframe), exclusión de ayer, cierre con Escape y error atómico con un PDF dañado. Impresora física no probada.
