import {describe,it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {createProductSource,productImageUrl,productMessage} from '../lib/mensajeriaProductSource.js';
import {savedAttachment,sharedDraft} from '../public/mensajeria/app.js';
const env={WOO_URL:'https://fusionbikes.com.ar',WOO_CK:'fixture-key',WOO_CS:'fixture-secret'};
const product={id:47935,sku:'FB-47935',name:'Bicicleta MTB R29 Volta ZILANT Race — M / Gris',variation:'Talle: M · Color: Gris',url:'https://fusionbikes.com.ar/?p=47903',image:'https://fusionbikes.com.ar/wp-content/uploads/2026/10/bici.avif'};
const amounts=[613334,444445,360000,266667,220000];
const payload=()=>({schema:1,currency:'ARS',generated_at:'2026-10-07T18:00:00Z',items:[{id:47935,sku:'FB-47935',name:product.name,state:'ok',source:'master_control_pricing_engine',base_amount:'3200000.00',free_shipping:true,quantity:1,plans:[6,9,12,18,24].map((count,i)=>({plan:String(count),installment_amount:amounts[i]+'.00'}))}]});
describe('Ficha comercial desde la tienda sin modificar Master Control',()=>{
 it('lee una unidad por GET fijo, conserva cuotas exactas y reutiliza durante 60 segundos',async()=>{
  let now=0;const fetchImpl=vi.fn(async()=>new Response(JSON.stringify(payload()))),source=createProductSource({env,fetchImpl,now:()=>now});
  const quote=await source.quote(product);expect(quote.cash).toBe(3200000);expect(quote.installments.map(x=>x.amount)).toEqual(amounts);
  await source.quote(product);expect(fetchImpl).toHaveBeenCalledTimes(1);now=60001;await source.quote(product);expect(fetchImpl).toHaveBeenCalledTimes(2);
  const [url,opts]=fetchImpl.mock.calls[0];expect(String(url)).toBe('https://fusionbikes.com.ar/wp-json/wc/v3/fusion-herramientas/commercial-products?ids=47935');expect(opts.method).toBe('GET');expect(opts.redirect).toBe('error');expect(String(url)).not.toContain('fixture-key');
  const text=productMessage(product,quote);expect(text).not.toContain('SKU:');expect(text).not.toContain('FB-47935');expect(text).toContain('https://fusionbikes.com.ar/?p=47903\n💰 *Contado / transferencia:*');expect(text).toContain('tarjetas bancarizadas y no bancarizadas');expect(text).toContain('6 cuotas de $');expect(text).toContain('613.334');expect(text.endsWith('\n\n🚚 *Envío gratis*')).toBe(true);
 });
 it('no anuncia envío gratis cuando no corresponde ni agrega cuotas inexistentes',async()=>{
  const p=payload();p.items[0].free_shipping=false;const source=createProductSource({env,fetchImpl:async()=>new Response(JSON.stringify(p))});
  expect(productMessage(product,await source.quote(product))).not.toContain('Envío gratis');
  for(const change of [x=>x.currency='USD',x=>x.items[0].id=1,x=>x.items[0].sku='OTHER',x=>delete x.items[0].free_shipping,x=>x.items[0].plans.pop(),x=>x.items[0].plans[0].installment_amount='NaN']){
   const b=payload();change(b);await expect(createProductSource({env,fetchImpl:async()=>new Response(JSON.stringify(b))}).quote(product)).rejects.toHaveProperty('code','product_quote_unavailable');
  }
 });
 it('no comunica credenciales a otros orígenes ni retiene fallos como caché',async()=>{
  const fetchImpl=vi.fn();const source=createProductSource({env:{...env,WOO_URL:'https://evil.invalid'},fetchImpl});
  await expect(source.quote(product)).rejects.toThrow();await expect(source.quote(product)).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
  let calls=0;const retry=createProductSource({env,fetchImpl:async()=>++calls===1?new Response('{}',{status:503}):new Response(JSON.stringify(payload()))});await expect(retry.quote(product)).rejects.toThrow();expect((await retry.quote(product)).cash).toBe(3200000);
 });
 it('comparte JPEG reducido a partir de AVIF y lo cachea sin enviar cookies ni claves',async()=>{
  const bytes=await sharp({create:{width:900,height:600,channels:3,background:'#ffa500'}}).avif().toBuffer();
  const fetchImpl=vi.fn(async()=>new Response(bytes)),source=createProductSource({env,fetchImpl});
  const media=await source.photo(product);expect(media.mime).toBe('image/jpeg');const meta=await sharp(Buffer.from(media.data_base64,'base64')).metadata();expect(meta.format).toBe('jpeg');expect(meta.width).toBe(640);expect(meta.exif).toBeUndefined();
  await source.photo(product);expect(fetchImpl).toHaveBeenCalledTimes(1);expect(fetchImpl.mock.calls[0][1].headers).toEqual({accept:'image/*'});expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
 });
 it('rechaza fotos de otros dominios, redirecciones, SVG y archivos falsos',async()=>{
  for(const url of ['https://evil.invalid/a.jpg','http://fusionbikes.com.ar/wp-content/uploads/a.jpg','https://fusionbikes.com.ar/wp-content/uploads/a.svg','https://fusionbikes.com.ar/wp-content/uploads/a.jpg?url=evil'])expect(productImageUrl(url)).toBe('');
  const fetchImpl=vi.fn();await expect(createProductSource({env,fetchImpl}).photo({...product,image:'https://evil.invalid/a.jpg'})).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
  await expect(createProductSource({env,fetchImpl:async()=>new Response('<svg/>')}).photo(product)).rejects.toThrow();
  await expect(createProductSource({env,fetchImpl:async()=>new Response('x',{headers:{'content-length':String(9*1024*1024)}})}).photo(product)).rejects.toThrow();
 });
 it('conserva la referencia privada de la foto al recargar y evita sustituir otro adjunto',()=>{
  const photo={media_id:'photo-safe-id',mime:'image/jpeg',name:'Producto.jpg'};
  expect(savedAttachment({...photo,data_base64:'never-store'})).toEqual(photo);
  expect(sharedDraft({reply:''},{text:'Ficha',media:photo})).toEqual({reply:'Ficha',uploaded:photo});
  expect(sharedDraft({reply:'Otro texto',uploaded:{media_id:'pdf',mime:'application/pdf',name:'Factura.pdf'}},{text:'Ficha',media:photo}).error).toContain('Ya tenés un archivo');
 });
});
