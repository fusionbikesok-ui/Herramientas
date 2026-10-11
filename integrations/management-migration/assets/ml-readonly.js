  function mlShell(){return `<div class="fa-title-row"><div><h1>Mercado Libre</h1><p>Historial del Facturador conservado en el VPS.</p></div></div><div class="fa-help"><strong>Conexión pendiente de traslado</strong><p>Las ventas de esta pantalla son la copia del historial. La autorización de Mercado Libre todavía sigue en la tienda: aquí no se buscan ventas nuevas, actualizan envíos ni emiten comprobantes.</p></div><div id="fa-ml-panel" aria-live="polite">Cargando historial…</div>`;}
  async function loadMl(){
    clearTimeout(mlPoll);const el=root.querySelector('#fa-ml-panel');if(!el)return;const request=++mlRequest;
    const data=await api('ml/activity?'+new URLSearchParams({page:mlPage,...mlFilters}));
    if(!el.isConnected||request!==mlRequest)return;
    if(!Array.isArray(data.rows))throw Error('No se pudo leer el historial de Mercado Libre.');
    el.innerHTML=`<section class="fa-card fa-ml-sales"><div class="fa-section-head"><h2>Ventas conservadas · ${Number(data.archive_count)||0}</h2><button class="fa-btn secondary" data-action="ml-refresh">Releer historial local</button></div>${mlFilterForm()}<div class="fm-ml-records">${data.rows.map(r=>{
      const cells=mlCells(r);
      return `<article class="fm-ml-record"><header>${cells.order}<span class="fa-state">${esc(mlStates[r.state]||r.state)}</span></header><div class="fm-ml-grid"><div>${cells.products}</div><div>${cells.total}</div><div><small>Envío registrado</small>${cells.shipment}</div><div><small>Comprador</small>${cells.buyer}</div></div>${Number(r.invoice_id)>0?`<button class="fa-btn secondary small" data-open="${Number(r.invoice_id)}">Ver comprobante</button>`:''}<small class="fm-ml-archive-date">Registro copiado · ${esc(r.updated_at||'sin fecha')}</small></article>`;
    }).join('')||'<p class="fa-empty">No hay ventas en la copia con estos filtros.</p>'}</div><div class="fa-pagination">${mlPage>1?'<button class="fa-btn small" data-action="ml-prev">Anterior</button>':''}<span>Página ${mlPage}</span>${data.has_more?'<button class="fa-btn small" data-action="ml-next">Siguiente</button>':''}</div></section>`;
  }
