export function csvEscape(celda) {
  const s = String(celda ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function filasToCSV(filas) {
  return filas.map(fila =>
    (typeof fila === 'string') ? fila : fila.map(csvEscape).join(',')
  ).join('\n');
}

// Exportación de "Hay que publicarlo" (Cobertura accionable) a Excel/CSV.
export function generarCSVHayQuePublicar(items) {
  const headers = ['SKU', 'Nombre', 'Marca', 'Valor inmovilizado', 'Tachado', 'Agregado el'];
  const filas = (items || []).map((it) => [
    it.sku || '', it.nombre || '', it.marca || '',
    Number(it.valor || 0).toFixed(2), it.tachado ? 'si' : 'no', it.creado_en || '',
  ]);
  return filasToCSV([headers, ...filas]);
}

export function generarCSVStock(itemsConfirmados) {
  const headers = ['ID', 'Inventario'];
  const filas = itemsConfirmados.map(item => [
    item.id,
    String((parseFloat(item.stockActual) || 0) + (parseInt(item.cantidadSumar) || 0))
  ]);
  return filasToCSV([headers, ...filas]);
}

export function determinarEnvioYDimensiones(nombreCompleto, categoriaStr) {
  const texto = (String(nombreCompleto) + ' ' + String(categoriaStr)).toLowerCase();
  const esBici = /\bbicicleta(s)?\b/.test(texto) || /\bbici\b/.test(texto);
  if (esBici) return { clase: 'bicicleta', peso: 15, largo: 90, ancho: 70, alto: 20 };
  return { clase: 'casco', peso: 1, largo: 10, ancho: 20, alto: 30 };
}

export function expandirCategoriasConPadre(categoriasArr) {
  const vistas = {};
  const resultado = [];
  (categoriasArr || []).forEach(c => {
    if (!c) return;
    if (!vistas[c]) { vistas[c] = 1; resultado.push(c); }
    const partes = String(c).split('>').map(p => p.trim()).filter(Boolean);
    if (partes.length > 1) {
      const padreSolo = partes[0];
      if (!vistas[padreSolo]) { vistas[padreSolo] = 1; resultado.push(padreSolo); }
    }
  });
  return resultado;
}

const CSV_NUEVOS_HEADERS = [
  'ID','Tipo','SKU','Nombre','Publicado','¿Está destacado?','Visibilidad en el catálogo',
  'Descripción corta','Descripción',
  'Día en que empieza el precio rebajado','Día en que termina el precio rebajado',
  'Estado del impuesto','Clase de impuesto',
  '¿Existencias?','Inventario','Cantidad de bajo inventario',
  '¿Permitir reservas de productos agotados?','¿Vendido individualmente?',
  'Peso (kg)','Longitud (cm)','Anchura (cm)','Altura (cm)',
  '¿Permitir valoraciones de clientes?','Nota de compra',
  'Precio rebajado','Precio normal',
  'Categorías','Etiquetas','Clase de envío','Imágenes',
  'Límite de descargas','Días de caducidad de la descarga',
  'Superior','Productos agrupados','Ventas dirigidas','Ventas cruzadas',
  'URL externa','Texto del botón','Posición','Swatches Attributes','Marcas',
  'Nombre del atributo 1','Valor(es) del atributo 1','Atributo visible 1','Atributo global 1',
  'Nombre del atributo 2','Valor(es) del atributo 2','Atributo visible 2','Atributo global 2',
  'Nombre del atributo 3','Valor(es) del atributo 3','Atributo visible 3','Atributo global 3',
  'Atributo por defecto 1','Atributo por defecto 2','Atributo por defecto 3',
  'Nombre del atributo 4','Valor(es) del atributo 4','Atributo visible 4','Atributo global 4','Atributo por defecto 4'
];

export function generarCSVNuevos(productosNuevos) {
  const headers = CSV_NUEVOS_HEADERS;
  const filas = [];

  productosNuevos.forEach((prod, idx) => {
    const ficha = prod.fichaGemini;
    const skuBase = prod.skuBase || ('FB-' + Date.now() + '-' + String(idx + 1).padStart(3, '0'));

    const catsArr = expandirCategoriasConPadre(ficha.categorias || []);
    const cats = catsArr.join(', ');

    const marca = ficha.marca || prod.marca || '';
    const nombreFicha = ficha.nombre || prod.nombreDoc;
    const desc = '';

    const envio = determinarEnvioYDimensiones(nombreFicha, cats);

    const attrs = ficha.atributos || [];
    const marcaAttr = { nombre: 'Marca', valores: [marca], visible: 0, global: 1 };
    const todosAttrs = [...attrs, marcaAttr].slice(0, 3);

    function getAttr(i) {
      if (i >= todosAttrs.length) return ['', '', '', ''];
      const a = todosAttrs[i];
      return [a.nombre, (a.valores || []).join(', '), a.visible, a.global];
    }

    const [an1, av1, avis1, ag1] = getAttr(0);
    const [an2, av2, avis2, ag2] = getAttr(1);
    const [an3, av3, avis3, ag3] = getAttr(2);

    if (ficha.tipo === 'variable' && (ficha.variaciones || []).length > 0) {
      const padre = new Array(headers.length).fill('');
      const set = (col, val) => { const i = headers.indexOf(col); if (i >= 0) padre[i] = val ?? ''; };

      set('Tipo', 'variable'); set('SKU', skuBase);
      set('Nombre', nombreFicha);
      set('Publicado', '0'); set('¿Está destacado?', '0');
      set('Visibilidad en el catálogo', 'visible');
      set('Descripción', desc);
      set('Estado del impuesto', 'taxable');
      set('¿Existencias?', '1');
      set('¿Permitir reservas de productos agotados?', '0');
      set('¿Vendido individualmente?', '0');
      set('¿Permitir valoraciones de clientes?', '0');
      set('Peso (kg)', String(envio.peso));
      set('Longitud (cm)', String(envio.largo));
      set('Anchura (cm)', String(envio.ancho));
      set('Altura (cm)', String(envio.alto));
      set('Clase de envío', envio.clase);
      set('Categorías', cats); set('Marcas', marca); set('Posición', '0');
      set('Nombre del atributo 1', an1); set('Valor(es) del atributo 1', av1);
      set('Atributo visible 1', avis1); set('Atributo global 1', ag1);
      set('Nombre del atributo 2', an2); set('Valor(es) del atributo 2', av2);
      set('Atributo visible 2', avis2); set('Atributo global 2', ag2);
      set('Nombre del atributo 3', an3); set('Valor(es) del atributo 3', av3);
      set('Atributo visible 3', avis3); set('Atributo global 3', ag3);
      filas.push(padre);

      ficha.variaciones.forEach((v, vi) => {
        const varFila = new Array(headers.length).fill('');
        const setv = (col, val) => { const i = headers.indexOf(col); if (i >= 0) varFila[i] = val ?? ''; };
        const varKeys = Object.keys(v);
        const skuVar = skuBase + '-VAR-' + (vi + 1);
        const nombreVar = nombreFicha + ' - ' + varKeys.map(k => v[k]).join(', ');

        setv('Tipo', 'variation'); setv('SKU', skuVar); setv('Nombre', nombreVar);
        setv('Publicado', '1'); setv('Visibilidad en el catálogo', 'visible');
        setv('Estado del impuesto', 'taxable'); setv('Clase de impuesto', 'parent');
        setv('¿Existencias?', '1');
        setv('Inventario', String(Math.floor((prod.cantidad || 1) / ficha.variaciones.length) || 0));
        setv('¿Permitir reservas de productos agotados?', '0');
        setv('¿Vendido individualmente?', '0');
        setv('Superior', skuBase); setv('Posición', String(vi));

        varKeys.forEach((k, ki) => {
          if (ki < 3) {
            const nm = k.charAt(0).toUpperCase() + k.slice(1);
            setv('Nombre del atributo ' + (ki + 1), nm);
            setv('Valor(es) del atributo ' + (ki + 1), v[k]);
            setv('Atributo global ' + (ki + 1), '1');
          }
        });
        filas.push(varFila);
      });
    } else {
      const fila = new Array(headers.length).fill('');
      const set = (col, val) => { const i = headers.indexOf(col); if (i >= 0) fila[i] = val ?? ''; };

      set('Tipo', 'simple'); set('SKU', skuBase);
      set('Nombre', nombreFicha);
      set('Publicado', '0'); set('¿Está destacado?', '0');
      set('Visibilidad en el catálogo', 'visible');
      set('Descripción', desc);
      set('Estado del impuesto', 'taxable');
      set('¿Existencias?', '1'); set('Inventario', String(prod.cantidad || 1));
      set('¿Permitir reservas de productos agotados?', '0');
      set('¿Vendido individualmente?', '0');
      set('¿Permitir valoraciones de clientes?', '0');
      set('Peso (kg)', String(envio.peso));
      set('Longitud (cm)', String(envio.largo));
      set('Anchura (cm)', String(envio.ancho));
      set('Altura (cm)', String(envio.alto));
      set('Clase de envío', envio.clase);
      set('Categorías', cats); set('Marcas', marca); set('Posición', '0');
      set('Nombre del atributo 1', an1); set('Valor(es) del atributo 1', av1);
      set('Atributo visible 1', avis1); set('Atributo global 1', ag1);
      set('Nombre del atributo 2', an2); set('Valor(es) del atributo 2', av2);
      set('Atributo visible 2', avis2); set('Atributo global 2', ag2);
      set('Nombre del atributo 3', an3); set('Valor(es) del atributo 3', av3);
      set('Atributo visible 3', avis3); set('Atributo global 3', ag3);
      filas.push(fila);
    }
  });

  return filasToCSV([headers, ...filas]);
}

export function generarCSVNuevosCompleto(payload) {
  const variacionesPadre = payload.variacionesPadre || [];
  const productosNuevos = payload.productosNuevos || [];
  const headers = CSV_NUEVOS_HEADERS;

  function cel(row, col, val) {
    const i = headers.indexOf(col);
    if (i >= 0) row[i] = val ?? '';
  }

  const filas = [];

  variacionesPadre.forEach(v => {
    const fila = new Array(headers.length).fill('');
    cel(fila, 'Tipo', 'variation');
    cel(fila, 'SKU', v.skuVar);
    cel(fila, 'Nombre', v.variacion || '');
    cel(fila, 'Publicado', '1');
    cel(fila, 'Visibilidad en el catálogo', 'visible');
    cel(fila, 'Estado del impuesto', 'taxable');
    cel(fila, 'Clase de impuesto', 'parent');
    cel(fila, '¿Existencias?', '1');
    cel(fila, 'Inventario', String(parseInt(v.cantidad) || 1));
    cel(fila, '¿Permitir reservas de productos agotados?', '0');
    cel(fila, '¿Vendido individualmente?', '0');
    cel(fila, 'Superior', 'id:' + v.idPadre);
    cel(fila, 'Posición', '0');

    const partes = (v.variacion || '').split('/').map(p => p.trim());
    const attrNames = ['Color', 'Talle', 'Medida'];
    partes.forEach((p, pi) => {
      if (pi < 3 && p) {
        cel(fila, 'Nombre del atributo ' + (pi + 1), attrNames[pi] || ('Atributo ' + (pi + 1)));
        cel(fila, 'Valor(es) del atributo ' + (pi + 1), p);
        cel(fila, 'Atributo global ' + (pi + 1), '1');
      }
    });

    filas.push(fila);
  });

  if (productosNuevos.length > 0) {
    const csvNuevos = generarCSVNuevos(productosNuevos);
    const lineasNuevos = csvNuevos.split('\n');
    lineasNuevos.slice(1).forEach(linea => {
      if (linea.trim()) filas.push(linea);
    });
  }

  return [headers.join(','), ...filas.map(f => (typeof f === 'string' ? f : f.map(csvEscape).join(',')))].join('\n');
}
