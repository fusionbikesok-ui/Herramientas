// Combine original orders with the immutable official Excel, using exact IDs only.
export function combineMlSources(native,report){
 if(!report)return{orders:native,reportStats:null};
 if(report.schema!==1||!Array.isArray(report.orders))throw Error('invalid_ml_report');
 const byId=new Map(native.map(o=>[String(o.id),o])),byPack=new Map();
 for(const o of native){if(!o.pack)continue;const k=String(o.pack);if(!byPack.has(k))byPack.set(k,[]);byPack.get(k).push(o);}
 const consumed=new Set(),seen=new Set(),orders=[];let linked=0,packReferences=0,conflicts=0;
 for(const source of report.orders){
  if(!/^\d{10,30}$/.test(source.reference)||seen.has(source.reference)||source.items?.length!==1)throw Error('invalid_ml_report_identity');
  seen.add(source.reference);
  const exactOrder=byId.get(source.reference);
  const candidates=exactOrder?[exactOrder]:source.referenceType==='order'?[]:byPack.get(source.reference)||[];
  // Explicit order references identify a line, while pack references identify a purchase.
  const item=source.items[0],nativeLines=candidates.flatMap(o=>o.items||[]);
  const compatible=!candidates.length||(candidates.every(o=>o.currency===source.currency)&&nativeLines.every(i=>i.listing===item.listing)&&nativeLines.reduce((s,i)=>s+i.quantity,0)===item.quantity);
  let state=source.saleState;
  if(!compatible){state='review';conflicts++;}
  if(candidates.length&&candidates.every(o=>['cancelled','refunded'].includes(o.saleState)))state=candidates.every(o=>o.saleState==='cancelled')?'cancelled':'refunded';
  else if(candidates.some(o=>['review','partial','refunded','cancelled'].includes(o.saleState))&&state==='valid')state='review';
  const ids=candidates.map(o=>String(o.id));
  if(ids.some(id=>consumed.has(id)))throw Error('overlapping_ml_report_references');
  ids.forEach(id=>consumed.add(id));linked+=ids.length;
  const isPack=source.referenceType!=='order'&&!exactOrder;if(isPack)packReferences++;
  const nativeItem=candidates.length===1&&nativeLines.length===1?nativeLines[0]:null;
  orders.push({...source,id:'report:'+source.reference,externalReference:source.reference,native_ids:[...new Set([...ids,...(!isPack?[source.reference]:[])])],
   pack:isPack?source.reference:source.pack||'',referenceType:isPack?'pack':'order',saleState:state,
   items:[{...item,sku:item.sku||nativeItem?.sku||'',quantity:item.quantity,amount:state==='review'?null:item.amount}],
   refundsKnown:state!=='review',source:compatible?'Mercado Libre · Excel oficial':'Mercado Libre · Excel con diferencias por revisar'});
 }
 orders.push(...native.filter(o=>!consumed.has(String(o.id))));
 return{orders,reportStats:{from:report.from,to:report.to,exported_at:report.exported_at,lines:report.orders.length,native_orders_reconciled:linked,pack_references:packReferences,conflicts,warning:report.warning||null}};
}
