export function originLabel(origin){return ({gift:'Regalo primera compra',cart:'Carrito abandonado',contact:'Solicitud de contacto'})[origin]||'Contacto del sitio';}
export function prospectPreview(thread){return (thread?.prospect_origins||[]).map(item=>originLabel(item.origin)).join(' · ');}
export function siteUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(u.hostname)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
export function sourceState(item){return item.active?'Por atender':({converted:'Pedido generado',recovered:'Cliente retomó el carrito',active:'Carrito activo',contacted:'Contactado',closed:'Cerrado'})[item.status]||'Sin acción pendiente';}
export function renderProspects(container,items){
  container.hidden=!items.length;
  const content=container.querySelector('div');content.replaceChildren();
  const node=(tag,text,cls='')=>{const n=document.createElement(tag);n.textContent=String(text||'');if(cls)n.className=cls;return n;};
  const link=(text,url)=>{const a=node('a',text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
  for(const item of items){
    const card=node('section','','prospect-record');
    card.append(node('strong',originLabel(item.origin)),node('span',`${item.created_at||''} · ${sourceState(item)}`,'meta'));
    if(item.page_title)card.append(node('p',item.page_title));
    if(item.message)card.append(node('p',item.message));
    const url=siteUrl(item.page_url);if(url)card.append(link('Ver producto o página de origen ↗',url));
    for(const product of item.items||[]){const p=node('p',`${product.name} × ${product.quantity}`);const u=siteUrl(product.url);if(u){p.textContent='';p.append(link(`${product.name} × ${product.quantity} ↗`,u));}card.append(p);}
    if(item.source==='cart'){
      let total='';try{total=new Intl.NumberFormat('es-AR',{style:'currency',currency:item.currency||'ARS'}).format(item.total);}catch{}
      card.append(node('p',[total?`Total registrado: ${total}`:'',item.payment_method?`Pago elegido: ${item.payment_method}`:'',item.installments?`Cuotas elegidas: ${item.installments}`:'',item.order_id?`Pedido #${item.order_id}`:''].filter(Boolean).join(' · '),'meta'));
      if(item.exit_reason)card.append(node('p',`Motivo registrado: ${item.exit_reason}`));
    }
    if(item.email){const p=node('p',`${item.email} `);const copy=node('button','Copiar email','ui-btn');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(item.email);copy.textContent='Copiado';}catch{copy.textContent='Copialo desde el texto';}});p.append(copy);card.append(p);}
    content.append(card);
  }
  content.append(node('p','Los importes del carrito corresponden al momento de la visita. Verificá precio y stock antes de ofrecer. El contacto no envía mensajes automáticamente.','meta'));
}
