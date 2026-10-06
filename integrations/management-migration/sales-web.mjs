const shop='https://fusionbikes.com.ar';
export function salesWebTarget(target, method='GET') {
  if(!target)return null;
  const url=new URL(target.local||'/', 'http://private.invalid');
  const module=target.module||url.searchParams.get('fm_module');
  if(['pos','facturador'].includes(module)&&['GET','HEAD'].includes(method)){
    const destination=new URL(module==='pos'?'/punto-de-venta/':'/wp-admin/admin.php?page=fusion-arca',shop);
    if(module==='facturador'){
      const view=url.searchParams.get('view'),order=url.searchParams.get('order_id');
      if(['new','history','bulk','ml','settings'].includes(view))destination.searchParams.set('view',view);
      if(/^[1-9]\d{0,9}$/.test(order||''))destination.searchParams.set('order_id',order);
    }
    return {status:302,url:destination.href};
  }
  const route=url.searchParams.get('rest_route')||url.pathname.replace(/^\/wp-json/,'');
  if(target.kind==='pos'||target.kind==='delivery'||/^\/(fusion-arca\/v1|fbpos\/v2)\//.test(route)){
    return {status:423,url:shop+(target.kind==='pos'||route.startsWith('/fbpos/')?'/punto-de-venta/':'/wp-admin/admin.php?page=fusion-arca')};
  }
  return null;
}
