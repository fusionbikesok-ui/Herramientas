# Corrector de etiquetas de Andreani

URL: `/herramientas/gestion-vps/corregir-etiquetas/`. Tarjeta directa en Home y Gestión; requiere administrador de la sesión existente.

Entrada y salida editables: peso (Gr), ancho, alto y largo (Cm), con los valores habituales precargados y botón para restaurarlos. Todos deben ser enteros positivos; peso hasta 6 dígitos, medidas hasta 4. Solo se corrige una página cuando coinciden los cuatro datos de entrada. Valores habituales:

```
Peso: 9000 Gr // Ancho: 20 Cm
Alto: 30 Cm // Largo: 40 Cm
```

se reemplazan por `Peso: 15000 Gr // Ancho: 25 Cm` y `Alto: 70 Cm // Largo: 150 Cm`. Se cambian los glifos/avances numéricos en los bloques originales: conserva fuentes incrustadas, páginas, orden y códigos. Si la línea se alarga, comprime su base horizontal preservando su anclaje y ancho original. Comprueba texto completo e imágenes después de escribir. Rechaza cifrado, anotaciones reales, acciones, estructuras ambiguas o fuentes/formato no compatibles. Las referencias a listas de anotaciones vacías están permitidas. No cambia pedidos ni registros del transportista.

La regla viaja en `X-Fusion-Pdf-Rule` como JSON de hasta 1024 caracteres: `{before:{weight,width,height,length},after:{weight,width,height,length}}`, con valores string. Gateway y Python validan el esquema y los números; entrada idéntica a salida da 400, sin coincidencias da 422. Sin cabecera conserva los valores habituales para clientes anteriores. El worker pasa el JSON como argumento al subproceso; stdin contiene solo el PDF. Cambiar un campo o restaurar valores elimina el resultado anterior; los campos quedan bloqueados durante corrección e impresión. No guarda reglas ni PDFs.

API binaria POST con `application/pdf`, Origin y CSRF existentes, 10 MiB y 300 páginas, un trabajo simultáneo. Gateway llama sólo a `127.0.0.1:8213`, con token HMAC derivado de la clave ya existente. El worker tiene unidad propia, 384 MiB/50% CPU; cada proceso PDF limita 256 MiB y 25 s de CPU, timeout 32 s. PDF entrante/saliente sólo en memoria. Nginx desactiva buffers de request/response en esa ruta exacta; no existe historial ni endpoint público de archivos.

Interfaz: carga manual, recuento/páginas modificadas, visor propio paginado PDF.js 5.6.205, impresión de todas las páginas y descarga del PDF original corregido. PDF.js se carga sólo cuando hay resultado y se sirve desde el VPS; su licencia está en assets/pdfjs/LICENSE. Para impresión genera imágenes a 288 dpi (máximo 3000 px por lado y 64 megapíxeles totales) con dimensiones físicas de cada página y abre el diálogo del navegador; imprimir al 100%. Libera imágenes al terminar/cancelar el diálogo. Si el PDF supera el presupuesto de impresión, pide descargarlo para imprimir desde un visor; el procesamiento y la descarga siguen hasta 300 páginas. La descarga conserva texto/vector originales. No se probó una impresora física.

Dependencias: pypdf 6.10.0 puro Python desde runtime Codex, empaquetado en worker/pypdf-vendor.zip; sin instalación global ni pip. Servicio `/etc/systemd/system/fusion-pdf-corrector.service`, código `/opt/fusion-pdf-corrector`.

Pruebas: `python3 pdf-corrector.test.py`; opcional `PDF_CORRECTOR_SAMPLE=/ruta/real.pdf` para muestra local, nunca copiar esa muestra al repo. `node --test pdf-gateway.test.mjs` y suites del gateway. `tests/labels.pdf` es sintético, sin datos personales. La prueba fuente exige sólo páginas 3/8 modificadas y 14 restantes intactas.

Rollback: restaurar archivos exactos del respaldo de release con hashes previos, nginx y Home; reiniciar sólo gateway y recargar nginx. Detener/deshabilitar el worker nuevo si se revierte. No toca el proceso Node principal ni sus datos.
