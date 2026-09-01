/**
 * Lógica pura de la herramienta de Preparación de pedidos:
 * - normalización de datos de envío para la planilla de Andreani
 *   (splits heurísticos de dirección y teléfono AR — editables en la UI)
 * - resolución de perfil de producto (bici / kit_transmision / sellado)
 * - requisitos de fotos por perfil y estado de embalaje
 */

// Texto que suele venir pegado al final de un `address_1` real y que NO es
// parte de la numeración de calle ("Escalada 45 depto 9" → el 9 es del depto,
// no de la calle). Se corta aparte como `referencia` antes de buscar el
// número, para no perderlo (mal) ni tragárselo en `calle`.
const SUFIJO_REFERENCIA_RE = /\b(depto\.?|dpto\.?|dto\.?|piso|local|lote|casa|manzana|mz\.?)\s*(\d+\w*)?\s*$/i;

// "Av. Siempreviva 742" → { calle: 'Av. Siempreviva', numeracion: '742', referencia: '' }
// El último bloque de dígitos al final es la numeración; sin dígitos al final,
// todo queda como calle (ej: "Camino de los Remeros s/n"). Antes de buscar el
// número se separa: (a) todo lo que sigue a la primera coma (barrio,
// referencia — "Jose Florio 4405, parque industrial pesquero" perdía el 4405
// entero porque la dirección no terminaba en dígito) y (b) un sufijo tipo
// "depto 9"/"casa 150" al final, que si no se separa se come el número real
// de calle. Ambos casos confirmados con pedidos reales de producción.
export function splitDireccion(address1) {
  const dirOriginal = String(address1 || '').trim();
  if (!dirOriginal) return { calle: '', numeracion: '', referencia: '' };

  let dir = dirOriginal;
  const partesReferencia = [];

  const coma = dir.indexOf(',');
  if (coma !== -1) {
    partesReferencia.push(dir.slice(coma + 1).trim());
    dir = dir.slice(0, coma).trim();
  }

  const suf = dir.match(SUFIJO_REFERENCIA_RE);
  if (suf) {
    partesReferencia.unshift(suf[0].trim());
    dir = dir.slice(0, suf.index).trim();
  }

  const referencia = partesReferencia.filter(Boolean).join(', ');
  const m = dir.match(/^(.+?)[,\s]+(\d+)\s*$/);
  if (!m) return { calle: dir || dirOriginal, numeracion: '', referencia };
  return { calle: m[1].trim(), numeracion: m[2], referencia };
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

// WooCommerce guarda la provincia como código corto ISO-3166-2:AR (sin el
// prefijo "AR-") en pedidos nuevos, pero pedidos viejos/manuales la traen ya
// como nombre completo — confirmado con pedidos reales de la base (mismo
// campo `state` da "S" en uno y "Buenos Aires" en otro). Por eso el mapeo es
// best-effort: si el código no está en la tabla, se devuelve tal cual llegó
// en vez de vaciarlo, para nunca ocultar el dato.
const PROVINCIAS_AR = {
  B: 'Buenos Aires', C: 'CABA', K: 'Catamarca', H: 'Chaco', U: 'Chubut',
  X: 'Córdoba', W: 'Corrientes', E: 'Entre Ríos', P: 'Formosa', Y: 'Jujuy',
  L: 'La Pampa', F: 'La Rioja', M: 'Mendoza', N: 'Misiones', Q: 'Neuquén',
  R: 'Río Negro', A: 'Salta', J: 'San Juan', D: 'San Luis', Z: 'Santa Cruz',
  S: 'Santa Fe', G: 'Santiago del Estero', V: 'Tierra del Fuego', T: 'Tucumán',
};

export function nombreProvincia(state) {
  const s = String(state || '').trim();
  if (!s) return '';
  return PROVINCIAS_AR[s.toUpperCase()] || s;
}

// Normaliza UNA sola fuente (shipping o billing) a los campos de la planilla,
// sin decidir cuál usar — eso lo hace normalizarEnvio() (fallback automático)
// o quien llame con una fuente ya elegida (confirmación manual, Fase 2).
function normalizarFuente(order, src, bill) {
  const { calle, numeracion, referencia } = splitDireccion(src.address_1);
  const { caracteristica, numero } = splitTelefonoAr(src.phone || bill.phone || '');
  const metaDni = (order.meta_data || []).find(m => /dni|cuit/i.test(m.key || ''));

  return {
    pedido: String(order.number ?? order.id ?? ''),
    nombre: src.first_name || '',
    apellido: src.last_name || '',
    calle,
    numeracion,
    piso_depto: [src.address_2 || '', referencia].filter(Boolean).join(' - '),
    localidad: src.city || '',
    provincia: nombreProvincia(src.state),
    cp: src.postcode || '',
    caracteristica,
    telefono: numero,
    email: bill.email || '',
    dni_cuit: metaDni ? String(metaDni.value ?? '') : '',
    notas: order.customer_note || '',
  };
}

// Datos de envío normalizados de un pedido WC para la planilla de Andreani.
// Por defecto usa la dirección de envío; si está vacía cae a la de
// facturación. Cuando el operario ya confirmó a mano cuál usar (Fase 2,
// direccionesDifieren), `fuenteForzada` la fuerza sin importar cuál esté
// vacía o no ('shipping' | 'billing').
export function normalizarEnvio(order, fuenteForzada = null) {
  const ship = order.shipping || {};
  const bill = order.billing || {};
  const src = fuenteForzada === 'shipping' ? ship
    : fuenteForzada === 'billing' ? bill
    : (String(ship.address_1 || '').trim() ? ship : bill);
  return normalizarFuente(order, src, bill);
}

// Compara envío vs. facturación para decidir si "difieren" de verdad — no
// alcanza con distinto texto: calle+número, localidad+provincia, nombre del
// destinatario y teléfono se comparan normalizados (sin acentos, mayúsculas,
// espacios de más) para no molestar por "Cordoba" vs "Córdoba". Si billing no
// tiene una dirección propia (mismo address_1 que shipping, o vacía), no hay
// nada que confirmar.
export function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function direccionesDifieren(order) {
  const ship = order.shipping || {};
  const bill = order.billing || {};
  if (!String(bill.address_1 || '').trim()) return { difieren: false, campos: [] };
  if (!String(ship.address_1 || '').trim()) return { difieren: false, campos: [] };

  const campos = [];
  const calleShip = splitDireccion(ship.address_1);
  const calleBill = splitDireccion(bill.address_1);
  if (normalizar(`${calleShip.calle} ${calleShip.numeracion}`) !== normalizar(`${calleBill.calle} ${calleBill.numeracion}`)) {
    campos.push('calle');
  }
  if (normalizar(`${ship.city} ${ship.state}`) !== normalizar(`${bill.city} ${bill.state}`)) {
    campos.push('localidad_provincia');
  }
  if (normalizar(`${ship.first_name} ${ship.last_name}`) !== normalizar(`${bill.first_name} ${bill.last_name}`)) {
    campos.push('nombre');
  }
  const telShip = splitTelefonoAr(ship.phone).numero;
  const telBill = splitTelefonoAr(bill.phone).numero;
  if (telShip && telBill && telShip !== telBill) campos.push('telefono');

  return { difieren: campos.length > 0, campos };
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

// Clasifica la evidencia disponible sin convertir datos faltantes en un rechazo.
// `inconcluso` es fail-open: no alcanza para habilitar una decisión logística, pero
// tampoco justifica sacar una orden de la cola. Solo valores conocidos explícitamente
// como logística externa permiten afirmar `no_elegible`.
const LOGISTICA_EXTERNA_EXPLICITA = new Set(['fulfillment', 'full']);
export function clasificarElegibilidadMl(orden, envio = null) {
  if (orden?.status !== 'paid') return { estado: 'no_elegible', motivo: 'orden_no_paga' };
  if (!orden?.shipping?.id) return { estado: 'inconcluso', motivo: 'shipping_id_faltante' };
  if (!envio?.status) return { estado: 'inconcluso', motivo: 'estado_envio_faltante' };
  if (envio.status !== 'ready_to_ship') return { estado: 'no_elegible', motivo: 'estado_envio_no_listo' };
  if (!envio.logistic_type) return { estado: 'inconcluso', motivo: 'logistica_faltante' };
  if (LOGISTICA_EXTERNA_EXPLICITA.has(String(envio.logistic_type))) {
    return { estado: 'no_elegible', motivo: 'logistica_externa' };
  }
  if (esEnvioLocal(envio.logistic_type)) return { estado: 'elegible', motivo: 'logistica_local' };
  return { estado: 'inconcluso', motivo: 'logistica_desconocida' };
}

// ─── Detección de vínculos entre pedidos (Fase 4 de Preparación) ──────────────

// Normaliza un teléfono para comparación: extrae solo los dígitos del número
// (sin característica) para comparar números normalizados entre órdenes que
// pueden venir con distintos formatos.
export function normalizarTelefonoParaComparacion(tel) {
  if (!tel) return '';
  const { numero } = splitTelefonoAr(tel);
  return numero;
}

// Detecta qué campo matchea entre dos órdenes WC, si es que hay alguno:
// - dni/cuit (mismo formato que extrae normalizarEnvio)
// - email (del billing)
// - teléfono (numero normalizado, sin característica)
// - nombre + dirección de envío (normalizado sin acentos/mayúsculas)
//
// Devuelve el nombre del campo matcheado (el primero que encuentre, en orden
// de prioridad: dni → email → telefono → nombre_direccion) o null si no hay
// coincidencia.
export function detectarVinculoEntrePedidos(order1, order2) {
  // DNI/CUIT: mismo patrón que normalizarEnvio
  const getDni = (order) => {
    const meta = (order.meta_data || []).find(m => /dni|cuit/i.test(m.key || ''));
    return meta ? String(meta.value || '').trim().toUpperCase() : '';
  };
  const dni1 = getDni(order1);
  const dni2 = getDni(order2);
  if (dni1 && dni2 && dni1 === dni2) return 'dni';

  // Email
  const email1 = String((order1.billing?.email || '').trim()).toLowerCase();
  const email2 = String((order2.billing?.email || '').toLowerCase()).toLowerCase();
  if (email1 && email2 && email1 === email2) return 'email';

  // Teléfono normalizado
  const tel1 = normalizarTelefonoParaComparacion(order1.billing?.phone || order1.shipping?.phone);
  const tel2 = normalizarTelefonoParaComparacion(order2.billing?.phone || order2.shipping?.phone);
  if (tel1 && tel2 && tel1 === tel2) return 'telefono';

  // Nombre + dirección de envío: normalizar quitando puntuación también
  const limpiarPuntuacion = (s) => String(s || '').replace(/[.,;:]/g, ' ');
  const getNombreDireccion = (order) => {
    const ship = order.shipping || {};
    const nombre = normalizar(`${ship.first_name} ${ship.last_name}`);
    const { calle, numeracion } = splitDireccion(ship.address_1);
    // Limpiar puntuación antes de normalizar la dirección
    const direccion = normalizar(`${limpiarPuntuacion(calle)} ${numeracion}`);
    return { nombre, direccion };
  };
  const nd1 = getNombreDireccion(order1);
  const nd2 = getNombreDireccion(order2);
  if (nd1.nombre && nd1.direccion && nd1.nombre === nd2.nombre && nd1.direccion === nd2.direccion) {
    return 'nombre_direccion';
  }

  return null;
}

// Elegibilidad + orden compartidos entre GET /api/preparacion/pendientes y la apertura de
// jornada (E1) — una sola fuente de verdad para "qué pedidos entran a trabajar hoy y en
// qué orden". Ver plan-maestro-v2.md §4: ML/espejo_ml primero, antigüedad después.
export function pedidosElegiblesOrdenados(db) {
  return db.prepare(
    "SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' ORDER BY CASE WHEN canal='ml' OR espejo_ml=1 THEN 0 ELSE 1 END, fecha ASC"
  ).all();
}
