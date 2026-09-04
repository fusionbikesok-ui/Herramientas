# Atajos de teclado del Matcher

## Navegación por publicaciones

| Atajo | Acción |
|-------|--------|
| `↓` / `j` | Ir a la siguiente publicación |
| `↑` / `k` | Ir a la publicación anterior |

## Decisión

| Atajo | Acción |
|-------|--------|
| `Enter` | Aprobar/Confirmar el SKU seleccionado |
| `s` | Omitir la publicación actual |

## Búsqueda

| Atajo | Acción |
|-------|--------|
| Escribir en el buscador | Filtrar por título o variaciones (no dispara otros atajos) |

## Notas de implementación

- Los atajos NO se disparan mientras se escribe en inputs (`input[type="text"]`, `input[type="search"]`, `textarea`)
- Los atajos son case-insensitive (`j` o `J` funcionan igual)
- Cada decisión avanza automáticamente al siguiente item pendiente
- Cuando se agota el filtro actual, se muestra un estado "filtro completado"

## Flujo de uso rápido

```
1. Abrir matcher
2. Seleccionar un filtro (click en chip)
3. Navegar con ↓/↑ o j/k
4. Para cada item:
   - Si es un candidato obvio: Enter para aprobar
   - Si no hay candidatos: escribir SKU manual + Enter
   - Si quiero omitir: s
5. Cuando termina el filtro: cambiar a otro filtro o ver "Ver todos"
```

## Ejemplos de trabajo veloz

### Asignar SKUs rápido
```
↓ ↓ ↓ Enter  (skip 3 items, aprobar el 4to)
    ↓ s      (ir al siguiente, omitir)
    ↓ ↓ Enter (ir 2, aprobar)
```

### Verificar con confianza baja
```
# Filtrar "Conf. baja"
↓ Enter  (1er item, ver SKU actual, dar Enter para confirmar)
↓ ↓ s    (ir 2, omitir el 3ro)
↓ Enter  (ir al siguiente, confirmar)
```
