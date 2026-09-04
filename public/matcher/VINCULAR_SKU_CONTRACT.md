# Contrato: vincularSku()

## Ubicación en el código
`public/matcher/index.html` líneas 634-646

## Firma actual (stub)
```javascript
async function vincularSku(clave, sku) {
  // Simula escritura durable con 500ms de delay
  return new Promise(resolve => {
    setTimeout(() => {
      console.log('Vincular:', { clave, sku });
      resolve({ ok: true });
    }, 500);
  });
}
```

## Contrato esperado
**Entrada:**
- `clave` (string): Clave única de la publicación ML (ej. `MLA-123456789`)
- `sku` (string): SKU del producto WooCommerce a vincular (ej. `FB-001234`)

**Salida:** Promise que resuelve a objeto con:
```json
{
  "ok": true,
  "error": null
}
```

O rechaza la promesa con un Error que contiene el mensaje de error.

## Endpoint objetivo
Una vez disponible: `POST /api/guardia-ml/casos/:id/vincular`

Pero la escritura se debe hacer directamente desde esta función para:
1. Mantener velocidad (no esperar respuesta del servidor antes de avanzar)
2. Encapsular la lógica de escritura en UN solo lugar
3. Permitir reintentos sin modificar el resto del código

## Notas de implementación
- La decisión del usuario NO debe esperar a que se escriba en el backend (optimistic UI)
- La UI muestra el status con toast (pending → ok/error)
- Si falla, el usuario puede reintentar seleccionando el mismo SKU de nuevo
- El vector de escritura es durabilidad en el backend, no en el cliente
