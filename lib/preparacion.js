/**
 * Lógica pura de la herramienta de Preparación de pedidos:
 * - normalización de datos de envío para la planilla de Andreani
 *   (splits heurísticos de dirección y teléfono AR — editables en la UI)
 * - resolución de perfil de producto (bici / kit_transmision / sellado)
 * - requisitos de fotos por perfil y estado de embalaje
 */

// "Av. Siempreviva 742" → { calle: 'Av. Siempreviva', numeracion: '742' }
// El último bloque de dígitos al final es la numeración; sin dígitos al final,
// todo queda como calle (ej: "Camino de los Remeros s/n").
export function splitDireccion(address1) {
  const dir = String(address1 || '').trim();
  if (!dir) return { calle: '', numeracion: '' };
  const m = dir.match(/^(.+?)[,\s]+(\d+)\s*$/);
  if (!m) return { calle: dir, numeracion: '' };
  return { calle: m[1].trim(), numeracion: m[2] };
}

// Split best-effort de teléfono argentino en característica + número.
// Con separadores usa el primer grupo como característica; sin separadores
// asume 11 (CABA) o característica de 3 dígitos. Siempre editable en la UI.
export function splitTelefonoAr(tel) {
  if (!tel) return { caracteristica: '', numero: '' };
  const grupos = String(tel).replace(/\+/g, ' ').split(/[^\d]+/).filter(Boolean);
  if (!grupos.length) return { caracteristica: '', numero: '' };

  // prefijos de país / celular que no aportan: 54, 9, 0 sueltos
  while (grupos.length > 1 && (grupos[0] === '54' || grupos[0] === '9' || grupos[0] === '0')) grupos.shift();

  if (grupos.length > 1) {
    let area = grupos.shift().replace(/^0/, '');
    if (area.startsWith('549')) area = area.slice(3);
    else if (area.startsWith('54') && area.length > 4) area = area.slice(2);
    if (grupos[0] === '15') grupos.shift(); // prefijo de celular local
    return { caracteristica: area, numero: grupos.join('') };
  }

  // un solo bloque de dígitos
  let d = grupos[0].replace(/^0+/, '');
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54') && d.length > 10) d = d.slice(2);
  if (d.startsWith('11')) return { caracteristica: '11', numero: d.slice(2) };
  if (d.length >= 10) return { caracteristica: d.slice(0, 3), numero: d.slice(3) };
  return { caracteristica: '', numero: d };
}

// Datos de envío normalizados de un pedido WC para la planilla de Andreani.
// Usa la dirección de envío; si está vacía cae a la de facturación.
export function normalizarEnvio(order) {
  const ship = order.shipping || {};
  const bill = order.billing || {};
  const src = String(ship.address_1 || '').trim() ? ship : bill;

  const { calle, numeracion } = splitDireccion(src.address_1);
  const { caracteristica, numero } = splitTelefonoAr(src.phone || ship.phone || bill.phone || '');

  const metaDni = (order.meta_data || []).find(m => /dni|cuit/i.test(m.key || ''));

  return {
    pedido: String(order.number ?? order.id ?? ''),
    nombre: src.first_name || '',
    apellido: src.last_name || '',
    calle,
    numeracion,
    piso_depto: src.address_2 || '',
    localidad: src.city || '',
    provincia: src.state || '',
    cp: src.postcode || '',
    caracteristica,
    telefono: numero,
    email: bill.email || '',
    dni_cuit: metaDni ? String(metaDni.value ?? '') : '',
    notas: order.customer_note || '',
  };
}

// Perfil de preparación según categoría(s) y nombre del producto.
// `categorias` puede ser array o string. Heurística base; los overrides por
// categoría viven en la tabla preparacion_perfiles (ver routes/preparacion.js).
export function resolverPerfil({ categorias, nombre }) {
  const cats = (Array.isArray(categorias) ? categorias.join(' ') : String(categorias || '')).toUpperCase();
  const nom = String(nombre || '').toUpperCase();

  if (/BICICLETA/.test(cats) || /^BICICLETA/.test(nom)) return 'bici';
  // "Kit"/"Grupo" solos no alcanzan (hay kit purgado, kit tubeless, etc.):
  // tiene que ser de transmisión por categoría o por nombre.
  const nomSinAcentos = nom.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/TRANSMISION/.test(cats) || (/\b(GRUPO|KIT)\b/.test(nom) && /TRANSMISION/.test(nomSinAcentos))) return 'kit_transmision';
  return 'sellado';
}

// Slots de foto obligatorios para un ítem según su perfil y (en bicis) el
// estado de embalaje. Cada slot: { tipos: [...aceptados], min, etiqueta }.
export function requisitosFoto(perfil, estadoEmbalaje) {
  if (perfil === 'bici') {
    if (estadoEmbalaje === 're_embalada') {
      return [
        { tipos: ['lado_a'], min: 1, etiqueta: 'Lado A del embalaje' },
        { tipos: ['lado_b'], min: 1, etiqueta: 'Lado B del embalaje' },
        { tipos: ['caja_accesorios'], min: 1, etiqueta: 'Caja de accesorios' },
      ];
    }
    return [{ tipos: ['articulo', 'etiqueta'], min: 1, etiqueta: 'Foto de la bici / caja' }];
  }
  if (perfil === 'kit_transmision') {
    return [{ tipos: ['piezas'], min: 1, etiqueta: 'Set completo con las piezas sueltas visibles' }];
  }
  // sellado / default
  return [{ tipos: ['articulo', 'etiqueta'], min: 1, etiqueta: 'Artículo o etiqueta' }];
}

// Fotos generales del paquete (no atadas a ningún ítem particular): DOS obligatorias,
// no una. La de artículo previene el
// error (¿es el producto correcto?); las del paquete resuelven el reclamo (¿salió todo de
// acá, bien cerrado?):
//   - contenido a la vista, antes de cerrar la caja (todo lo que va adentro, junto);
//   - paquete ya cerrado, con la etiqueta puesta (prueba de que ese envío es ese pedido).
// Fijas, no dependen de perfil ni de estado_embalaje.
export function requisitosPaquete() {
  return [
    { tipos: ['paquete_abierto'], min: 1, etiqueta: 'Paquete abierto, con todo el contenido a la vista antes de cerrar' },
    { tipos: ['paquete_cerrado'], min: 1, etiqueta: 'Paquete ya cerrado, con la etiqueta puesta' },
  ];
}

// Anota en la etiqueta de un slot de foto la cantidad esperada, cuando es mayor a 1 —
// pedido explícito del usuario tras plantearle que escanear 5 veces el mismo código no
// prueba que haya 5 unidades en la caja (se puede escanear la misma unidad cinco veces).
// OJO, esto NO es una validación: el sistema no puede comprobar que la foto realmente
// muestre las N unidades (se podría fotografiar 5 piezas sueltas y empacar 1 igual). Es
// una nota para el operario en el enunciado del requisito — el control real lo hace la
// persona que mira la foto después, ante un reclamo. No confundir con un chequeo
// automático.
//
// Preferimos anotar el/los slot(s) cuyo `tipos` sugiere que son "de artículo" (`articulo`
// o `piezas`). Pero si NINGUNO matchea por nombre —caso real: la bici `re_embalada` usa
// `lado_a`/`lado_b`/`caja_accesorios`, y cualquier `requisitos_json` custom por SKU o
// categoría (que es justo el mecanismo para pedir fotos EXTRA en lo delicado) puede traer
// tipos propios— la nota no puede desaparecer en silencio: se anota el PRIMER slot como
// fallback, en vez de depender de que el nombre del tipo coincida (hallazgo del revisor).
export function requisitosConCantidad(slots, cantidadEsperada) {
  if (!(cantidadEsperada > 1)) return slots;
  const lista = slots || [];
  const nota = ` — que se vean las ${cantidadEsperada} unidades (control humano, no verificable por el sistema)`;
  let anotadoAlguno = false;
  const anotados = lista.map(slot => {
    if (!slot.tipos.some(t => t === 'articulo' || t === 'piezas')) return slot;
    anotadoAlguno = true;
    return { ...slot, etiqueta: `${slot.etiqueta}${nota}` };
  });
  if (!anotadoAlguno && anotados.length) {
    anotados[0] = { ...anotados[0], etiqueta: `${anotados[0].etiqueta}${nota}` };
  }
  return anotados;
}

// Dado los requisitos y las fotos existentes ([{tipo}]), devuelve los slots
// que todavía no se cumplen.
export function fotosFaltantes(requisitos, fotos) {
  const porTipo = {};
  for (const f of fotos || []) porTipo[f.tipo] = (porTipo[f.tipo] || 0) + 1;
  return (requisitos || []).filter(slot => {
    const total = slot.tipos.reduce((acc, t) => acc + (porTipo[t] || 0), 0);
    return total < (slot.min || 1);
  });
}

// ¿El envío de ML lo despacha el local? (Flex o colecta/drop-off; Full lo
// despacha MercadoLibre desde su depósito y no pasa por acá.)
const LOGISTICA_LOCAL = new Set(['self_service', 'cross_docking', 'drop_off', 'xd_drop_off']);
export function esEnvioLocal(logisticType) {
  return LOGISTICA_LOCAL.has(String(logisticType || ''));
}
