import { construirWCIndex } from './matcherEngine.js';
import { candidatosParaDoc, autoAplicable } from './ingresoMatcher.js';
import { buscarAliasVigente } from './recepcionAliases.js';

export function construirIndiceRecepcion(rows) { return construirWCIndex(rows); }

// Razones estructuradas {tipo, resultado, documento?, producto?} — nunca strings sueltos (plan
// Task 3: "objetos con tipo (sku/marca/modelo/talle/color/capacidad/titulo) y resultado").
function razonesParaCandidato(c, linea) {
  const razones = [];
  if (c.diff?.conflicto_marca) razones.push({ tipo: 'marca', resultado: 'contradice', documento: linea.marca || null, producto: c.marca ?? null });
  if (c.talle_ok === false) razones.push({ tipo: 'talle', resultado: 'contradice', documento: linea.talle || null, producto: c.wc_talle ?? null });
  else if (c.talle_ok === true) razones.push({ tipo: 'talle', resultado: 'coincide', documento: linea.talle || null, producto: c.wc_talle ?? null });
  if (c.color_ok === false) razones.push({ tipo: 'color', resultado: 'contradice', documento: linea.color || null, producto: c.wc_color ?? null });
  else if (c.color_ok === true) razones.push({ tipo: 'color', resultado: 'coincide', documento: linea.color || null, producto: c.wc_color ?? null });
  if (!razones.length) razones.push({ tipo: 'titulo', resultado: 'similar', documento: linea.nombre_doc || null, producto: c.nombre ?? null });
  return razones;
}

export function resolverLineaRecepcion(db, proveedor, linea, indice) {
  const base = { linea_id: linea.linea_id, estado: 'sin_match', auto_aplicable: false, origen: 'ninguno', candidato: null, candidatos: [], ambiguo: false, sin_candidato: true };

  const alias = buscarAliasVigente(db, { ...linea, proveedor });
  if (alias) {
    const c = indice.wcItems.find(x => x.id_woo === alias.id_woo);
    if (c) return { ...base, estado: 'resuelto', auto_aplicable: true, origen: 'alias_proveedor', candidato: { ...c, confianza: 'alta', razones: [{ tipo: 'sku', resultado: 'alias_vigente' }] }, candidatos: [c], sin_candidato: false };
    // Alias huérfano (el producto ya no está en catálogo): no rompe, cae al resto del pipeline.
  }

  const sku = String(linea.codigo_proveedor || '').toLowerCase();
  const skuMatches = indice.wcItems.filter(x => String(x.sku || '').toLowerCase() === sku);
  if (sku && skuMatches.length > 1) {
    return { ...base, estado: 'sku_duplicado', origen: 'sku_exacto', candidatos: skuMatches.map(x => ({ ...x, confianza: 'revisar', razones: [{ tipo: 'sku', resultado: 'duplicado_en_catalogo' }] })), ambiguo: true, sin_candidato: false };
  }
  if (sku && skuMatches.length === 1) {
    return { ...base, estado: 'resuelto', auto_aplicable: true, origen: 'sku_exacto', candidato: { ...skuMatches[0], confianza: 'alta', razones: [{ tipo: 'sku', resultado: 'exacto_unico' }] }, candidatos: skuMatches, sin_candidato: false };
  }

  const m = candidatosParaDoc({ descripcion: `${linea.nombre_doc || ''} ${linea.variacion || ''}`, marca: linea.marca, color: linea.color, talle: linea.talle }, indice);
  const cs = m.candidatos.map(x => ({
    ...x,
    stock: indice.wcItems.find(w => w.id_woo === x.id_woo)?.stock ?? null,
    razones: razonesParaCandidato(x, linea),
  }));
  const top = cs.find(c => !c.filtrado_por_atributo) || cs[0] || null;
  const contradiccionTop = !!(top && top.contradiccion_atributo);
  // auto_aplicable es false siempre que haya contradicción de atributo o ambigüedad, sin
  // excepción — invariante exigida por el plan (nunca mostrar ambiguo/contradictorio como asignado).
  // Bug 4 (piloto Pedalar #205): color_ok===false nunca es auto_aplicable, aunque el gate de
  // contradiccion_atributo (estructurado) no lo haya detectado — cOk/tOk se calculan en un
  // camino separado en candidatosParaDoc y pueden divergir. color_ok===null (sin dato) no bloquea.
  const ok = autoAplicable(m) && skuMatches.length <= 1 && !contradiccionTop && top?.color_ok !== false;

  // La contradicción manda: un candidato que contradice talle/color es información útil para
  // revisar a mano, así que no se lo puede confundir con "no hay nada parecido" (sin_match) ni
  // esconderlo detrás de un genérico "revisar". m.sin_candidato solo aplica cuando lo que sobra
  // no contradice nada — simplemente no alcanza confianza.
  let estado;
  if (contradiccionTop) estado = 'contradiccion';
  else if (!top || m.sin_candidato) estado = 'sin_match';
  else estado = ok ? 'resuelto' : 'revisar';

  const sinCandidato = !top || (m.sin_candidato && !contradiccionTop);
  return { ...base, estado, auto_aplicable: ok, origen: top ? 'matcher' : 'ninguno', candidato: top, candidatos: cs, ambiguo: m.ambiguo, sin_candidato: sinCandidato };
}

export function resolverLoteRecepcion(db, proveedor, lineas) {
  // Plan Task 3 Step 3 especifica esta query exacta. sku<>'' se mantiene: el matcher fuzzy
  // trabaja sobre el catálogo vendible con SKU (universo del alias/código); tipo IN
  // ('simple','variation') excluye los padres variables, que no son vendibles ni recibibles.
  const rows = db.prepare("SELECT id_woo,id_padre,sku,nombre,tipo,stock,atributos_json,marca FROM catalogo_cache WHERE COALESCE(sku,'') <> '' AND tipo IN ('simple','variation') ORDER BY id_woo").all();
  const indice = construirIndiceRecepcion(rows);
  return lineas.map(l => resolverLineaRecepcion(db, proveedor, l, indice));
}
