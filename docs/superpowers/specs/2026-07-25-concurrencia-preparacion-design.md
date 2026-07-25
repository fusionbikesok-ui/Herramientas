# Concurrencia y refresh automático — Preparación de Pedidos

**Fecha:** 2026-07-25
**Estado:** aprobado, pendiente de plan de implementación
**Alcance:** segundo ciclo de 6 en la lista de mejoras a Preparación de Pedidos (después de
la caché de pedidos, ya en `master`). Ataca las fricciones #1 (sin lock entre operarios) y
#8 (sin refresh automático) detectadas en el análisis original del proceso.

## Contexto y problema

Hoy no hay ningún mecanismo para que dos operarios sepan que están por pisarse: si Ana y
Juan abren la misma preparación al mismo tiempo, ninguno se entera. Tampoco hay refresh
automático de la cola de Pendientes — si Juan toma un pedido, Ana no lo ve reflejado hasta
que recarga la página a mano.

## Decisiones (confirmadas con el usuario)

1. **No bloquear, solo avisar.** Si dos operarios abren la misma preparación, cada uno ve
   un aviso ("Juan también está preparando este pedido ahora") pero puede seguir trabajando
   — coordinan entre ellos. No hay lock duro (evita el problema de "Juan cerró el navegador
   sin avisar y ahora nadie puede tocar el pedido").
2. **Refresh automático solo en la cola de Pendientes.** No dentro del detalle de una
   preparación en curso — ahí solo se actualiza la presencia (punto 1) vía el propio
   heartbeat, sin re-renderizar el trabajo en curso del operario.

## Diseño técnico

### Backend

**Tabla nueva `preparacion_vistas`** (patrón `ensureTables` local, como el resto de las
tablas de este módulo):

```sql
CREATE TABLE IF NOT EXISTS preparacion_vistas (
  preparacion_id INTEGER NOT NULL,
  usuario        TEXT NOT NULL,
  visto_en       TEXT NOT NULL,
  PRIMARY KEY (preparacion_id, usuario)
);
```

Sin limpieza explícita de filas viejas: el endpoint solo considera "activos" a los
usuarios con `visto_en` dentro de los últimos 30 segundos, así que una fila vieja
simplemente deja de contar sin que haga falta borrarla (se sobreescribe con `UPSERT` la
próxima vez que ese mismo usuario mande un heartbeat).

**`POST /:id/heartbeat`**: registra "estoy viendo esto ahora" (upsert por
`preparacion_id`+`usuario`) y devuelve quién más la está viendo en este momento
(excluyéndote a vos mismo, solo los últimos 30s):

```json
{ "ok": true, "otros": [{ "usuario": "juan", "visto_en": "2026-07-25T10:00:00.000Z" }] }
```

### Frontend

- `public/preparacion/index.html` **no llama hoy a `/api/auth/me`** (única página del
  proyecto que no lo hace) — hay que sumarlo para saber el usuario actual y poder mostrar
  "Juan también..." en vez de mostrarse a sí mismo.
- Al abrir el detalle de una preparación (`abrirDetalle`), disparar un heartbeat inmediato
  y luego cada ~15 segundos mientras esa vista siga activa (se corta el `setInterval` al
  cambiar de vista, hookeado en la función `ir(v)` ya existente que centraliza el cambio de
  pantalla).
- Si `otros.length > 0`, mostrar un banner no bloqueante (mismo patrón visual ya usado en
  otros ciclos — aviso, no error) con los nombres.
- Cola de Pendientes: `setInterval` cada ~25 segundos que vuelve a llamar
  `cargarPendientes()` solo si la vista activa sigue siendo `'pendientes'` y no hay un
  request anterior todavía en vuelo (flag simple `pendientesEnVuelo`).

## Fuera de alcance de este ciclo

- Auditoría por paso (quién escaneó/subió cada foto), corrección de tracking erróneo,
  escritura transaccional a Woo, heurística de `kit_transmision`: ciclos siguientes.
- Lock duro o cualquier mecanismo que impida a un segundo operario entrar — decisión ya
  tomada explícitamente en contra.
- Refresh automático dentro del detalle de una preparación (más allá del heartbeat de
  presencia) — decisión ya tomada explícitamente en contra, para no interrumpir el trabajo
  en curso del operario con re-renders no pedidos.

## Siguiente paso

Invocar `superpowers:writing-plans` para el plan de implementación: tabla
`preparacion_vistas` + `POST /:id/heartbeat` (TDD), y ajustes de frontend (auth/me,
heartbeat periódico con banner, polling de Pendientes).
