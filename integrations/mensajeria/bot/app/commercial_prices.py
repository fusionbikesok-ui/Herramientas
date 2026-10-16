"""Verified Master Control quotes; local catalog remains the identity/stock source."""
import copy, os, re, time, threading
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit
import httpx

UNVERIFIED='catalog_base_unverified'
_cache={}
_bank_cache=None
_lock=threading.Lock()
COUNTS=(6,9,12,18,24)
class QuoteUnavailable(ValueError):pass
class QuoteScopeTooWide(QuoteUnavailable):pass

def untrusted(products):
    return [dict(p,price_source=UNVERIFIED) for p in products]

def amount(raw):
    if not isinstance(raw,str) or not re.fullmatch(r'\d{1,12}(?:\.\d{1,10})?',raw):raise QuoteUnavailable('amount')
    value=Decimal(raw)
    if not value.is_finite() or value<=0:raise QuoteUnavailable('amount')
    return raw

def _get(path,params=None):
    base=os.getenv('BOT_COMMERCE_WOO_URL','')
    u=urlsplit(base)
    if u.scheme!='https' or u.hostname not in {'fusionbikes.com.ar','www.fusionbikes.com.ar'} or u.port or u.username or u.password:raise QuoteUnavailable('configuration')
    ck=os.getenv('BOT_COMMERCE_WOO_CK','');cs=os.getenv('BOT_COMMERCE_WOO_CS','')
    if not ck or not cs:raise QuoteUnavailable('configuration')
    with httpx.Client(timeout=8,follow_redirects=False) as client:
        with client.stream('GET',base.rstrip('/')+path,params=params,auth=(ck,cs)) as response:
            if response.status_code!=200:raise QuoteUnavailable('unavailable')
            parts=[];size=0
            for part in response.iter_bytes():
                size+=len(part)
                if size>512*1024:raise QuoteUnavailable('size')
                parts.append(part)
    import json
    return json.loads(b''.join(parts))

def _fetch(ids):
    result=_get('/wp-json/wc/v3/fusion-herramientas/commercial-products',{'ids':','.join(map(str,ids))})
    if result.get('schema')!=1 or result.get('currency')!='ARS' or not isinstance(result.get('items'),list):raise QuoteUnavailable('schema')
    return result['items']

def bank_instructions():
    global _bank_cache
    with _lock:
        if _bank_cache and _bank_cache[0]>time.monotonic():return _bank_cache[1]
        data=_get('/wp-json/wc/v3/payment_gateways/bacs')
        if data.get('id')!='bacs' or data.get('enabled') is not True:raise QuoteUnavailable('bank_disabled')
        instructions=str(((data.get('settings') or {}).get('instructions') or {}).get('value') or '').strip()
        if not instructions or len(instructions)>2500 or '<' in instructions or '>' in instructions or not re.search(r'\b(?:CBU|CVU)\s*:\s*\d{22}\b',instructions,re.I):raise QuoteUnavailable('bank_unverified')
        _bank_cache=(time.monotonic()+60,instructions)
        return instructions

def _validated(row,identifier,sku):
    if row.get('state')!='ok' or row.get('source')!='master_control_pricing_engine' or row.get('id')!=identifier or str(row.get('sku') or '')!=sku or row.get('quantity')!=1 or type(row.get('free_shipping')) is not bool:raise QuoteUnavailable('identity')
    plans=row.get('plans');options=[]
    if not isinstance(plans,list) or len(plans)>20:raise QuoteUnavailable('plans')
    for count in COUNTS:
        matches=[p for p in plans if p.get('plan')==str(count)]
        if len(matches)!=1:raise QuoteUnavailable('plan')
        p=matches[0]
        options.append({'installments':count,'installment_amount':amount(p.get('installment_amount')),'total':amount(p.get('unit_amount'))})
    result={'cash_price':amount(row.get('base_amount')),'payment_options':options,'free_shipping':row['free_shipping']}
    usd=row.get('usd_reference')
    if isinstance(usd,dict) and usd.get('currency')=='USD' and usd.get('source')=='master_control_public_display' and usd.get('rounding')=='ceil':
        try:result['usd_price']=amount(usd.get('amount'))
        except QuoteUnavailable:pass
    return result

def hydrate(products, strict=False, limit=75):
    result=copy.deepcopy(products);requested={}
    for p in result:
        if p.get('price_source')!=UNVERIFIED:continue
        p['usd_price']='';p['cash_price']='';p['regular_price']='';p['payment_options']=[];p['free_shipping']=False
        for v in p.get('variations') or [p]:
            if v is not p:v['usd_price']='';v['display_price']='';v['payment_options']=[]
            identifier=v.get('id');sku=str(v.get('sku') or '')
            if isinstance(identifier,int) and not isinstance(identifier,bool) and identifier>0 and (v is p or v.get('is_in_stock') is True):requested[(identifier,sku)]=None
    if len(requested)>limit:
        if strict:raise QuoteScopeTooWide('narrow_search')
        return result
    now=time.monotonic();quotes={}
    with _lock:
        for key in requested:
            cached=_cache.get(key)
            if cached and cached[0]>now:quotes[key]=cached[1]
        missing=[key for key in requested if key not in quotes]
        try:
            for start in range(0,len(missing),25):
                batch=missing[start:start+25];rows=_fetch([k[0] for k in batch])
                for key in batch:
                    matches=[row for row in rows if row.get('id')==key[0]]
                    if len(matches)!=1:raise QuoteUnavailable('missing_quote')
                    quote=_validated(matches[0],*key);quotes[key]=quote;_cache[key]=(time.monotonic()+60,quote)
            if len(_cache)>2000:
                for key in list(_cache):
                    if _cache[key][0]<=now:del _cache[key]
        except Exception:
            if strict:raise QuoteUnavailable('unverified_price') from None
    for p in result:
        if p.get('price_source')!=UNVERIFIED:continue
        variants=p.get('variations') or []
        for v in variants or [p]:
            quote=quotes.get((v.get('id'),str(v.get('sku') or '')))
            if quote:
                v.update(quote)
                if v is not p:v['display_price']=quote['cash_price']
        available=[v for v in variants if v.get('is_in_stock') is True]
        if available and all(v.get('display_price') for v in available):
            # A parent minimum must never become the price of a selected variant.
            prices={Decimal(v['display_price']) for v in available}
            p['cash_price']=available[0]['display_price'] if len(prices)==1 else ''
            if all(v.get('payment_options')==available[0].get('payment_options') for v in available):p['payment_options']=available[0]['payment_options']
            p['free_shipping']=all(v.get('free_shipping') is True for v in available)
        if available and all(v.get('usd_price') for v in available):
            values={Decimal(v['usd_price']) for v in available}
            p['usd_price']=available[0]['usd_price'] if len(values)==1 else ''
        if p.get('cash_price'):p['price_source']='master_control_pricing_engine'
    return result
