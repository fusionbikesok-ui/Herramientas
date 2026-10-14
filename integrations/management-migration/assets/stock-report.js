(()=>{'use strict';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
function resultMatches(r,f={}){
 if(f.stockState==='positive'&&!(finite(r.stock)&&r.stock>0))return false;
 if(f.stockState==='zero'&&r.stock!==0)return false;
 if(f.stockState==='negative'&&!(finite(r.stock)&&r.stock<0))return false;
 if(f.stockState==='unknown'&&finite(r.stock))return false;
 for(const[key,min,max]of[['stock',f.stockMin,f.stockMax],['units',f.unitsMin,f.unitsMax],['coverage_days',null,f.coverMax]]){
  if(min!=null&&(!finite(r[key])||r[key]<min))return false;
  if(max!=null&&(!finite(r[key])||r[key]>max))return false;
 }return true;
}
function compareResults(a,b,key='default',direction='asc',view='critical'){
 const byName=()=>String(a.name).localeCompare(String(b.name),'es',{sensitivity:'base',numeric:true})||a.id-b.id;
 if(key==='default')return view==='ranking'?b.units-a.units||byName():view==='critical'?priority[a.alert]-priority[b.alert]||((a.coverage_days??Infinity)-(b.coverage_days??Infinity))||b.units-a.units||byName():byName();
 const av=a[key],bv=b[key],missing=v=>v==null||v===''||(typeof v==='number'&&!Number.isFinite(v));
 if(missing(av)||missing(bv))return missing(av)&&missing(bv)?byName():missing(av)?1:-1;
 const comparison=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'es',{sensitivity:'base',numeric:true});
 return comparison*(direction==='desc'?-1:1)||byName();
}
const priority={critical:0,negative:1,missing:2,review:3,no_sales:4,healthy:5};
function viewRows(rows,view){return view==='critical'?rows.filter(r=>['missing','critical','negative'].includes(r.alert)):view==='ranking'?rows.filter(r=>r.units>0):rows;}
function summarizeRows(rows){
 const countable=rows.filter(r=>finite(r.stock)&&!r.issue);
 return{count:rows.length,inStock:countable.filter(r=>r.stock>0).length,excluded:rows.length-countable.length,negative:countable.filter(r=>r.stock<0).length,units:rows.reduce((n,r)=>n+r.units,0),critical:viewRows(rows,'critical').length};
}
if(typeof module!=='undefined'&&module.exports)module.exports={resultMatches,compareResults,viewRows,summarizeRows};
if(typeof document==='undefined')return;
const $=id=>document.getElementById(id),C=window.FusionSales,N=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const number=new Intl.NumberFormat('es-AR',{maximumFractionDigits:1}),fmt=n=>number.format(n),date=s=>s?s.slice(0,10).split('-').reverse().join('/'):'—',stamp=s=>s?new Date(s).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false}):'Sin dato';
const labels={missing:'Sin stock informado',critical:'Cobertura baja',healthy:'Con cobertura',no_sales:'Sin ventas en el período',negative:'Stock negativo',review:'Stock para revisar'};
let data=null,view='critical',page=0,filtered=[],busy=false,pageSize=20;
const bound=id=>$(id).value===''?null:Number($(id).value);
function resultFilters(){return{stockState:$('fs-stock-state').value,stockMin:bound('fs-stock-min'),stockMax:bound('fs-stock-max'),unitsMin:bound('fs-units-min'),unitsMax:bound('fs-units-max'),coverMax:bound('fs-cover-max')};}
function resultFilterError(f){if(![...document.querySelectorAll('#fs-result-ranges input')].every(e=>e.validity.valid))return'Revisá los valores ingresados; se conserva el resultado anterior.';if((f.stockMin!=null&&f.stockMax!=null&&f.stockMin>f.stockMax)||(f.unitsMin!=null&&f.unitsMax!=null&&f.unitsMin>f.unitsMax))return'El mínimo no puede superar el máximo; se conserva el resultado anterior.';return '';}
function resetResults(){for(const id of['fs-stock-state','fs-stock-min','fs-stock-max','fs-units-min','fs-units-max','fs-cover-max'])$(id).value='';$('fs-sort').value='default';$('fs-direction').value='asc';}
function activeFilters(){
 const parts=[];for(const[id,label]of[['fs-search','Búsqueda'],['fs-brand','Marca'],['fs-category','Categoría'],['fs-situation','Situación'],['fs-stock-state','Stock']]){const e=$(id);if(e.value)parts.push(label+': '+(e.selectedOptions?e.selectedOptions[0].textContent:e.value));}
 for(const[id,label]of[['fs-stock-min','Stock mínimo'],['fs-stock-max','Stock máximo'],['fs-units-min','Ventas mínimas'],['fs-units-max','Ventas máximas'],['fs-cover-max','Cobertura máxima']])if($(id).value!=='')parts.push(label+': '+$(id).value);
 return parts.length?'Filtros activos en las tres vistas: '+parts.join(' · '):'Sin filtros adicionales. Cada vista selecciona sus productos del mismo catálogo.';
}
function options(id,values,empty){const select=$(id),value=select.value;select.replaceChildren();const first=N('option',empty);first.value='';select.append(first);for(const v of [...new Set(values)].sort((a,b)=>a.localeCompare(b,'es'))){const o=N('option',v);o.value=v;select.append(o);}if([...select.options].some(o=>o.value===value))select.value=value;}
function matches(r){const brand=$('fs-brand').value,category=$('fs-category').value,situation=$('fs-situation').value,words=C.norm($('fs-search').value).split(' ').filter(Boolean),hay=C.norm([r.name,r.model,r.brand,r.sku,r.variant].join(' '));return(!brand||r.brand===brand)&&(!category||r.categories.includes(category))&&(!situation||r.alert===situation)&&words.every(w=>hay.includes(w));}
function render(){
 if(!data)return;const f=resultFilters(),error=resultFilterError(f);$('fs-filter-status').textContent=error;if(error){$('fs-export').disabled=true;return;}
 const rows=data.rows.filter(r=>matches(r)&&resultMatches(r,f));
 for(const v of ['critical','ranking','catalog'])$('fs-count-'+v).textContent=fmt(viewRows(rows,v).length);
 $('fs-active-filters').textContent=activeFilters();
 document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
 const key=$('fs-sort').value,direction=$('fs-direction').value;$('fs-direction').disabled=key==='default';
 filtered=[...viewRows(rows,view)].sort((a,b)=>compareResults(a,b,key,direction,view));
 const summary=summarizeRows(filtered),viewLabel={critical:'Stock crítico',ranking:'Más vendidos',catalog:'Todo el catálogo'}[view];
 $('fs-summary-context').textContent='Resumen de '+viewLabel+' · todas las filas de esta vista, no sólo esta página';
 const stockNote='Variantes con cantidad positiva; unidades en la tabla'+(summary.excluded?` · ${fmt(summary.excluded)} con stock a revisar`:'');
 $('fs-summary').replaceChildren();for(const[label,value,note,attention]of[['Productos / variantes',summary.count,'Coinciden con la tabla de '+viewLabel,false],['Variantes con stock',summary.inStock,stockNote,false],['Unidades vendidas',summary.units,`Últimos ${data.period.days} días · productos de esta vista`,false],['Para revisar reposición',summary.critical,'Cobertura baja, cantidad cero con ventas o stock negativo',true]]){const card=N('div',undefined,'fs-stat'+(attention?' attention':''));card.append(N('span',label),N('strong',fmt(value)),N('small',note));$('fs-summary').append(card);}
 page=Math.min(page,Math.max(0,Math.ceil(filtered.length/pageSize)-1));
 $('fs-title').textContent=view==='critical'?'Productos para revisar':view==='ranking'?'Ranking de productos vendidos':'Consulta rápida de stock';
 $('fs-view-note').textContent=view==='critical'?`Menos de ${data.period.cover} días de cobertura, sin stock informado con ventas o stock negativo. Cada talle/color se evalúa por separado.`:view==='ranking'?`Productos con ventas en los últimos ${data.period.days} días, con detalle por variante. El orden recomendado muestra primero los más vendidos.`:'Incluye productos sin ventas. Buscá por modelo, marca, talle, color o SKU.';
 $('fs-filter-status').textContent=`${fmt(filtered.length)} resultados · Orden: ${$('fs-sort').selectedOptions[0].textContent}${key==='default'?'':direction==='desc'?' ↓':' ↑'} · Los filtros y el orden se aplican también al CSV.`;
 drawTable();$('fs-export').disabled=!filtered.length||busy;
}
function drawTable(){
 const target=$('fs-table');target.replaceChildren();$('fs-pagination').replaceChildren();
 if(!filtered.length){const empty=N('div',undefined,'fs-empty');empty.append(N('strong',view==='critical'?'No hay alertas calculables para este filtro':'No encontramos productos para esta búsqueda'),N('p',view==='critical'?'Podés revisar «Todo el catálogo» para ver productos sin ventas o con datos de stock a revisar.':'Probá quitar la marca o categoría, o buscar una parte del nombre.'));target.append(empty);return;}
 const scroll=N('div',undefined,'fs-table-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Productos, stock y ventas');const table=N('table'),head=N('thead'),tr=N('tr');
 for(const[key,text]of[['name','Producto / variante'],['stock','Stock informado'],['units','Unidades vendidas'],['daily','Promedio diario'],['coverage_days','Cobertura estimada'],['last_sale','Última venta']]){
  const th=N('th'),active=$('fs-sort').value===key,dir=$('fs-direction').value,b=N('button',text+' '+(active?(dir==='asc'?'↑':'↓'):'↕'),'fs-sort-column');th.scope='col';th.setAttribute('aria-sort',active?(dir==='asc'?'ascending':'descending'):'none');b.type='button';b.dataset.sortKey=key;b.setAttribute('aria-label','Ordenar por '+text);b.title='Clic para cambiar el orden';
  b.onclick=()=>{$('fs-sort').value=key;$('fs-direction').value=active?(dir==='asc'?'desc':'asc'):['units','daily','last_sale'].includes(key)?'desc':'asc';page=0;render();document.querySelector(`[data-sort-key="${key}"]`)?.focus({preventScroll:true});};th.append(b);tr.append(th);
 }head.append(tr);table.append(head);const body=N('tbody');
 filtered.slice(page*pageSize,(page+1)*pageSize).forEach((r,index)=>{
  const row=N('tr'),cell=N('td'),product=N('div',undefined,'fs-product');
  if(r.image){const img=N('img');img.src=r.image;img.alt='';img.loading='lazy';img.width=54;img.height=54;img.onerror=()=>img.remove();product.append(img);}
  const description=N('div'),link=N('a',(view==='ranking'?`${page*pageSize+index+1}. `:'')+r.name);link.href=r.url;link.target='_blank';link.rel='noopener noreferrer';description.append(link,N('small',r.brand+(r.sku?' · '+r.sku:'')),N('span',labels[r.alert],'fs-badge '+r.alert));if(r.variant)description.append(N('small',r.variant));product.append(description);cell.append(product);row.append(cell);
  const stock=N('td');stock.append(N('strong',r.stock===null?'—':fmt(r.stock),'fs-cell-value'));let note=r.issue==='shared'?'Revisar stock del padre':r.issue==='duplicate'?'SKU repetido':r.issue==='unknown'?'Cantidad no disponible':r.stock_stale?'Dato desactualizado':'Cantidad local';stock.append(N('small',note,'fs-cell-note'));stock.title='Dato del catálogo: '+stamp(r.stock_at);row.append(stock);
  const units=N('td');units.append(N('strong',fmt(r.units),'fs-cell-value'),N('small',`Web ${fmt(r.web_units)} · ML ${fmt(r.ml_units)}`,'fs-cell-note'));row.append(units);
  const daily=N('td');daily.textContent=r.units>0?new Intl.NumberFormat('es-AR',{maximumFractionDigits:3}).format(r.daily):'—';row.append(daily);
  const coverage=N('td');coverage.append(N('strong',r.coverage_days===null?'—':(r.coverage_days>999?'> 999':fmt(r.coverage_days))+' días','fs-cell-value'));if(r.coverage_days===null)coverage.append(N('small',r.issue?'Requiere revisión':'Sin ventas para estimar','fs-cell-note'));row.append(coverage,N('td',date(r.last_sale)));body.append(row);
 });table.append(body);scroll.append(table);target.append(scroll);
 const nav=$('fs-pagination');nav.append(N('span',`${page*pageSize+1}–${Math.min((page+1)*pageSize,filtered.length)} de ${filtered.length}`));for(const[text,delta]of[['Anterior',-1],['Siguiente',1]]){const b=N('button',text,'fs-button');b.type='button';b.disabled=page+delta<0||(page+delta)*pageSize>=filtered.length;b.onclick=()=>{page+=delta;drawTable();};nav.append(b);}
}
async function load(){if(busy)return;busy=true;$('fs-load').disabled=true;$('fs-export').disabled=true;$('fs-progress').textContent='Cruzando ventas y stock del VPS…';
 try{const q=new URLSearchParams({mode:'stock',days:$('fs-days').value,cover:$('fs-cover').value}),response=await fetch('/herramientas/gestion-vps/ventas/api?'+q,{credentials:'same-origin'});let result;try{result=await response.json();}catch{throw Error('No se pudo leer el informe. Volvé a intentar.');}if(!response.ok||result.success!==true)throw Error(result.data||result.error||'No se pudo cargar el informe.');data=result.data;page=0;
  options('fs-brand',data.rows.map(r=>r.brand),'Todas las marcas');options('fs-category',data.rows.flatMap(r=>r.categories),'Todas las categorías');$('fs-result').hidden=false;
  $('fs-period').textContent=`${date(data.period.from)} al ${date(data.period.to)} · ${data.period.days} días de ventas · Web/POS + Mercado Libre · Alerta por debajo de ${data.period.cover} días de stock`;
  const warnings=[];if(!data.snapshot.web_complete||!data.snapshot.ml_complete)warnings.push('El histórico tiene cobertura parcial en '+[!data.snapshot.web_complete?'Web/POS':'',!data.snapshot.ml_complete?'Mercado Libre':''].filter(Boolean).join(' y ')+'. La cobertura de stock se estima con las ventas disponibles y puede resultar mayor que la real.');if(data.snapshot.stale)warnings.push('La copia de ventas web está atrasada.');if(data.quality.unmatched_lines)warnings.push(`${data.quality.unmatched_lines} líneas de venta no pudieron vincularse a una variante vigente y quedan fuera del cálculo.`);if(data.quality.stale_stock)warnings.push(`${data.quality.stale_stock} productos tienen un dato de stock de más de 24 horas o sin fecha.`);
  $('fs-warning').textContent=warnings.join(' ');$('fs-warning').hidden=!warnings.length;
  $('fs-sources').textContent=`Ventas web actualizadas: ${stamp(data.snapshot.orders_at)}. Mercado Libre: ${stamp(data.snapshot.ml_at)}. Stock: fechas por producto entre ${stamp(data.snapshot.stock_oldest_at)} y ${stamp(data.snapshot.stock_latest_at)}.`;
  $('fs-quality').textContent=`${data.quality.review_lines} líneas para conciliar excluidas; ${data.quality.unmatched_lines} líneas sin variante vinculada; ${data.quality.shared_stock} variantes con stock en el padre; ${data.quality.duplicate_skus} variantes con SKU repetido. Revisá estas últimas en «Todo el catálogo».`;
  $('fs-progress').textContent='Informe actualizado · '+stamp(data.snapshot.generated_at);render();
 }catch(error){$('fs-progress').textContent=error.message+(data?' Se conserva el último informe cargado.':'');}finally{busy=false;$('fs-load').disabled=false;$('fs-export').disabled=!filtered.length||!!resultFilterError(resultFilters());}}
function csvValue(v){const text=typeof v==='number'?String(v):String(v??'').replace(/^([\s]*[=+@-])/,'\'$1');return '"'+text.replaceAll('"','""')+'"';}
$('fs-export').onclick=()=>{if(!data||!filtered.length)return;const header=['Producto','Marca','SKU','Variante','Stock informado','Unidades netas','Web/POS','Mercado Libre','Promedio diario','Cobertura en días','Diagnóstico','Fecha del stock','Desde','Hasta'];const rows=filtered.map(r=>[r.name,r.brand,r.sku,r.variant,r.stock,r.units,r.web_units,r.ml_units,r.daily,r.coverage_days,labels[r.alert],r.stock_at,data.period.from,data.period.to]);const blob=new Blob(['\uFEFF'+[header,...rows].map(r=>r.map(csvValue).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=N('a');a.href=url;a.download=`fusion-stock-${data.period.to}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('fs-query').onsubmit=e=>{e.preventDefault();load();};for(const id of['fs-search','fs-brand','fs-category','fs-situation'])$(id).addEventListener(id==='fs-search'?'input':'change',()=>{page=0;render();});
for(const id of['fs-stock-state','fs-sort','fs-direction','fs-page-size'])$(id).addEventListener('change',()=>{page=0;pageSize=Number($('fs-page-size').value);render();});
for(const id of['fs-stock-min','fs-stock-max','fs-units-min','fs-units-max','fs-cover-max'])$(id).addEventListener('input',()=>{page=0;render();});
$('fs-reset-results').onclick=()=>{resetResults();page=0;render();};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;page=0;render();});$('fs-clear').onclick=()=>{$('fs-search').value='';$('fs-brand').value='';$('fs-category').value='';$('fs-situation').value='';resetResults();page=0;render();};load();
})();
