"""USD payments use owner-confirmed banking data and current website quotes."""
import re
from .ai import BotDecision
from .routing import normalize, explicit_handoff, is_combined_payment
from .storage import get_system_setting
from .commercial_prices import hydrate

USD=r'\b(?:usd|dolares?|d[oó]lar)\b|u\s*\$\s*d'
BANK=r'\b(?:cbu|cvu|alias|cuenta|transfer\w*|deposit\w*)\b'

def usd_context(text,history):
    v=normalize(text)
    if re.search(r'\b(?:pesos|ars|euros?)\b',v):return False
    if re.search(USD,v):return True
    if not re.search(BANK,v):return False
    for r in reversed(history or []):
        if str(r.get('sender') or r.get('role')) not in {'bot','assistant','customer','user'}:continue
        b=normalize(str(r.get('body') or r.get('content') or ''))
        if re.search(USD,b):return True
        if re.search(r'\b(?:pesos|ars)\b|contado\s*:?\s*\$',b):return False
    return False

def bank_text():
    c=get_system_setting('usd_payment_policy',{})
    if not isinstance(c,dict) or c.get('enabled') is not True or c.get('currency')!='USD' or c.get('domestic_only') is not True:raise ValueError('usd_policy_missing')
    fields=['bank','holder','cbu','alias','account','cuit']
    if any(not isinstance(c.get(k),str) or not c[k].strip() or len(c[k])>120 or '<' in c[k] or '>' in c[k] or '\n' in c[k] for k in fields):raise ValueError('usd_policy_invalid')
    if not re.fullmatch(r'\d{22}',c['cbu']):raise ValueError('usd_cbu_invalid')
    return '\n'.join(['*Transferencia bancaria / depósito en USD*','*'+c['bank']+'*','Razón social: '+c['holder'],'CBU: '+c['cbu'],'Alias: '+c['alias'],'Cuenta: '+c['account'],'CUIT: '+c['cuit'],'Esta cuenta solo recibe pagos desde cuentas nacionales de Argentina.'])

def candidates_for(text,history,conversation,products):
    from .inquiry_flow import resolve_candidates,previous,role,body
    candidates,explicit=resolve_candidates(text,history,conversation,products)
    if explicit and not candidates:return []
    if len(candidates)==1:return candidates
    for r in reversed(previous(history,text)):
        if role(r) not in {'bot','assistant'}:continue
        urls={u.rstrip('.,;)') for u in re.findall(r'https?://[^\s<>]+',body(r))}
        shown=[p for p in (candidates if candidates else products) if str(p.get('url') or '') in urls]
        if shown:return shown
    return candidates

def usd_decision(text,history,conversation,products_loader):
    if not usd_context(text,history) or explicit_handoff(text) or is_combined_payment(text):return None
    v=normalize(text)
    if re.search(r'\b(?:cvv|cvc|pin|clave|contrasena|token|rechaz\w*|error|comprobante|ya pague|me cobraron)\b',v):return None
    try:bank=bank_text()
    except (ValueError,TypeError):return None
    def answer(reply):return BotDecision(reply,False,'ventas','Pago USD y referencia web verificados','normal')
    if re.search(r'\b(?:extranjero|exterior|internacional\w*|swift|wise|payoneer)\b',v):
        return answer('La cuenta en dólares solo recibe pagos desde cuentas nacionales de Argentina; no recibe transferencias desde el exterior.\n\n'+bank)
    intro='Sí, podés pagar en dólares por transferencia bancaria o depósito.'
    caution='El valor en dólares es de referencia y puede variar según el día en que hagas efectivamente la compra. Confirmá el total vigente de tu pedido antes de transferir.'
    quote='';clarify=''
    try:
        candidates=candidates_for(text,history,conversation,products_loader())
        if len(candidates)==1:
            from .payment_answers import payment_variant
            p=payment_variant(candidates[0],text,history)
            if p is None:clarify='¿Qué talle y color querés? Necesito confirmar esa variante.'
            else:
                p=hydrate([p],strict=True)[0]
                if p.get('usd_price'):
                    from .business_info import _money
                    quote=p['name']+'\nValor de referencia en la web: US$ '+_money(p['usd_price']).lstrip('$')+'\n'+p['url']
                elif p.get('variations') and all(v.get('usd_price') for v in p['variations'] if v.get('is_in_stock') is True):
                    clarify='Los valores dependen de la variante. ¿Qué talle y color querés cotizar?'
                else:clarify='No pude confirmar el importe en dólares de la web en este momento; revisemos el total vigente antes de pagar.'
        elif candidates:
            clarify='¿Cuál de estos productos querés cotizar en dólares?\n'+'\n'.join('• '+p['name'] for p in candidates[:3])
        else:clarify='¿De qué producto querés el valor en dólares? Pasame el nombre o el enlace.'
    except Exception:clarify='No pude consultar el precio vigente de la web en este momento. Necesitamos confirmar ese importe antes de transferir.'
    return answer('\n\n'.join(b for b in [intro,quote,caution,bank,clarify] if b))
