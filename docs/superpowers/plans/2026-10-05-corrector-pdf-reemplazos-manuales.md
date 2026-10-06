# Reemplazos manuales de etiquetas

1. Agregar ocho campos editables: peso (Gr), ancho, alto y largo (Cm), separados en entrada y salida, precargados con la regla actual; botón para restaurar esos valores. Valores enteros positivos, peso hasta seis dígitos y medidas hasta cuatro. Coincidencia conjunta exacta de los cuatro datos por página.
2. Enviar la regla como JSON acotado en X-Fusion-Pdf-Rule junto al PDF binario. Validar en gateway y proceso Python; sin cabecera conservar la regla anterior para clientes abiertos. Rechazar vacío, inválido o entrada idéntica a salida. Mantener aislamiento, auth, CSRF, límites y procesamiento en memoria.
3. Parametrizar los bloques de texto originales; ajustar horizontalmente la línea si se alarga para conservar su ancho original. Nunca producir salida parcial. Informar sin coincidencias según valores elegidos. Cambiar cualquier campo invalida la salida anterior.
4. Probar reglas personalizadas, extremos, sin cambios, inválidos, preservación de otras páginas e imágenes; revisar código y probar formulario responsive. Mantener ver/imprimir/descargar. Publicar con backup y rollback sólo de archivos del corrector, sin cambios del Home ni aplicación principal. Actualizar memoria y fuentes locales/remotas.

Aceptación: configurar manualmente entrada y salida, corregir las páginas coincidentes, ver texto elegido en el resultado y conservar el resto del PDF.
