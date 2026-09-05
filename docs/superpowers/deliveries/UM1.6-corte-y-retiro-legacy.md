# UM1.6 — SKU canónico, corte estricto y retiro legacy

**Estado:** planificada. **Dependencia:** UM1.1–UM1.5 aceptadas. **Superficie:** VPS/web/App.

## Resultado

Corregir SKU fuera de `FB-{id_woo}`, activar el núcleo estricto y retirar motores/pantallas heredados sin perder auditoría ni reactivar escrituras inseguras.

## Gates

- Canario designado y lotes posteriores de diez; fallos aislados permanecen bloqueados.
- `shadow → enforced` solo con urgencias limpias y salud vigente.
- Escritura directa con stock Woo fresco; rechazo o verificación fallida pasa a intervención y nunca activa fallback automático con stock cero.
- Mutaciones legacy deshabilitadas; GET conservados 30 días con deprecación y métricas.
- Rollback probado en copia sanitaria y producción read-only; vuelve a sombra sin revertir efectos remotos confirmados.
- Jornada comercial completa observada y aceptación explícita del usuario.

## Un solo escritor por clave ML — 2026-09-05

Primer paso del retiro de Guardia, sin desagendar todavía su worker.

Problema: `POST /api/guardia-ml/vincular-clave` (el botón «vincular» del Matcher, enlazado desde
el home) encolaba siempre una operación de Guardia. Con el worker de identidad corriendo cada
minuto y el de Guardia cada cinco, dos schedulers podían escribir el mismo `SELLER_SKU`. La
colisión no era teórica: 26 operaciones de Guardia en `conflicto` («el responsable del caso
cambió», «la versión del caso cambió», «caso ya no está pendiente»), frenadas sólo por el
control de versión.

Se **delega** en vez de rechazar, para no romper el botón: si Identidad gobierna la clave, el
endpoint llama a `decidirCasoIdentidad` y responde el mismo 202 con `motor: 'identidad'`. El
usuario hace lo mismo y la escritura sale por un único camino verificado. Si no la gobierna,
sigue por Guardia.

Detalles que importan:

- El freno por variaciones hermanas devuelve 409 apuntando a Identidad. Confirmarlo a ciegas
  desde el Matcher vaciaría el freno: la pantalla es la que muestra cuántas son y sobre qué
  publicación.
- El worker de Guardia lleva una segunda guarda para operaciones encoladas antes de este cambio;
  terminan en `conflicto`, no en reintento — no es un fallo transitorio, la operación ya no le
  corresponde.

Evidencia:

```
npx vitest run test/guardia-ml.test.js test/identidad-productos.test.js \
  test/um1-coverage-matrix.test.js test/matcher-candidatos.test.js \
  test/cobertura-legacy-retirada.test.js test/invariantes-esquema.test.js
  Test Files  6 passed (6)
  Tests  104 passed (104)
```

Impacto medido contra la base de producción (solo lectura):

```
casos de Guardia vivos: 67 | los gobierna UM1: 0 | quedan para Guardia: 67
operaciones de Guardia pendientes que el interlock frenaria: 0
```

**Hoy no frena nada: la guarda es preventiva.** Los 67 casos vivos de Guardia son links de pago
de Mercado Pago (`canales_json` sin `marketplace`, stock 99999), que UM1 excluye de su universo
por decisión previa. No hay hueco de cobertura.

### Handoff

Desagendar `procesarOperacionesGuardia` sigue pendiente y necesita antes decidir qué se hace con
esos 67 links de pago: hoy son el único trabajo vivo de Guardia. Sin desplegar.
