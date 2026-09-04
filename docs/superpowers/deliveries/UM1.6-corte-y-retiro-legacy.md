# UM1.6 — SKU canónico, corte estricto y retiro legacy

**Estado:** planificada. **Dependencia:** UM1.1–UM1.5 aceptadas. **Superficie:** VPS/web/App.

## Resultado

Corregir SKU fuera de `FB-{id_woo}`, activar el núcleo estricto y retirar motores/pantallas heredados sin perder auditoría ni reactivar escrituras inseguras.

## Gates

- Canario designado y lotes posteriores de diez; fallos aislados permanecen bloqueados.
- `shadow → enforced` solo con urgencias limpias y salud vigente.
- Mutaciones legacy deshabilitadas; GET conservados 30 días con deprecación y métricas.
- Rollback vuelve a sombra/read-only sin revertir efectos remotos confirmados.
