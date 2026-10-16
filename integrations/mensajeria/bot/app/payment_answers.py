"""Commercial questions never guess banking details or financing conditions."""
import re
from .ai import BotDecision
from .routing import normalize, is_combined_payment, explicit_handoff, department_for
from .commercial_prices import hydrate, bank_instructions

def payment_variant(product,text,history):
    from .catalog_flow import _parse
    from .catalog_words import words
    from .inquiry_flow import named_products
    variants=[v for v in product.get('variations') or [] if v.get('is_in_stock') is True]
    if not product.get('variations'):return product
    size=None;color=[]
    rows=list(history or [])+[{'sender':'customer','body':text}]
    for row in reversed(rows):
        if str(row.get('sender') or row.get('role')) not in {'customer','user'}:continue
        raw=str(row.get('body') or row.get('text') or row.get('content') or '')
        parsed=_parse(raw,{str(product.get('brand','')).lower()},None)
        if size is None:size=parsed.get('size')
        if not color:color=parsed.get('color') or []
        if named_products(raw,[product]):break
    if size:variants=[v for v in variants if str((v.get('attributes') or {}).get('attribute_pa_talle') or (v.get('attributes') or {}).get('attribute_talle') or '').upper()==size]
    if color:variants=[v for v in variants if all(c in words((v.get('attributes') or {}).get('attribute_pa_color') or (v.get('attributes') or {}).get('attribute_color') or '') for c in color)]
    if not variants:return None
    return dict(product,variations=variants)

def payment_decision(text, history, conversation, business, products_loader):
    value=normalize(text)
    def answer(reply,handoff=False):return BotDecision(reply,handoff,department_for(conversation or {},text),'Condiciones de pago verificadas' if not handoff else 'Atención humana solicitada o condición de pago a confirmar','normal')
    if explicit_handoff(text):return answer('Te derivo con un asesor para continuar con tu consulta.',True)
    from .usd_payments import usd_decision, usd_context
    usd=usd_decision(text,history,conversation,products_loader)
    if usd is not None:return usd
    if usd_context(text,history) and re.search(r'\b(?:cbu|cvu|alias|cuenta)\b',value):
        return answer('Un asesor debe confirmar los datos de la cuenta en dólares para este pago.',True)
    if re.search(r'\b(?:cbu|cvu|alias|datos bancarios|numero de cuenta|a (?:que|cual) cuenta|cuenta (?:bancaria|para transferir)|datos para (?:transferir|depositar)|(?:donde|como|a quien) (?:te |les )?(?:transfiero|deposito))\b',value):
        try:return answer('Estos son los datos oficiales para transferir que figuran en nuestra tienda:\n\n'+bank_instructions()+'\n\nConfirmá el importe de tu pedido antes de transferir.')
        except Exception:return answer('Un asesor te va a compartir los datos oficiales de Fusion Bikes para la transferencia y confirmar el importe de tu compra.',True)
    if re.search(r'\b(?:cvv|cvc|pin|clave|contrasena|token|codigo de seguridad)\b',value):
        return answer('No compartas claves, códigos de seguridad ni datos completos de tu tarjeta por el chat. Te derivo con un asesor para ayudarte con el pago.',True)
    if is_combined_payment(text) or re.search(r'\b(?:usd|dolares?|euros?|rechaz\w*|error|debito|comprobante|ya pague|no funciona|no anda|me cobraron)\b',value):return None
    if not re.search(r'\b(?:como (?:se puede |puedo |se |podemos |pueden )?(?:pagar|pago|abonar)|formas? de pago|medios? de pago|cuotas?|financiacion|financiar\w*)\b',value):return None
    from .business_info import PAYMENTS
    methods=[PAYMENTS[m] for m in (business or {}).get('payment_methods',[]) if m in PAYMENTS]
    reply='Podés pagar con '+', '.join(methods)+'.' if methods else 'Podés consultar las formas de pago disponibles en el checkout de la web.'
    if 'tarjeta' in (business or {}).get('payment_methods',[]) and (business or {}).get('credit_card_policy')=='all':reply+=' Aceptamos tarjetas de crédito bancarizadas y no bancarizadas.'
    from .inquiry_flow import resolve_candidates,previous,role,body
    try:
        candidates,explicit=resolve_candidates(text,history,conversation,products_loader())
        if not explicit and len(candidates)>1:
            # Follow the precise product link we just showed, not every old
            # product sharing the same model name in the local catalog.
            for row in reversed(previous(history,text)):
                if role(row) not in {'bot','assistant'}:continue
                urls={u.rstrip('.,;)') for u in re.findall(r'https?://[^\s<>]+',body(row))}
                shown=[p for p in candidates if str(p.get('url') or '') in urls]
                if shown:candidates=shown
                # A later clarification supersedes older product links.
                break
        if len(candidates)==1:
            candidate=payment_variant(candidates[0],text,history)
            if candidate is None:return answer(reply+'\n\nNo pude confirmar esa combinación de talle y color con stock. ¿Qué variante querés que revise?')
            product=hydrate([candidate])[0]
            from .business_info import _money
            if product.get('cash_price'):reply+='\n\n'+product['name']+'\nContado / transferencia: '+_money(product['cash_price'])
            options=product.get('payment_options') or []
            if options:reply+='\n\n💳 Cuotas:\n'+'\n'.join(str(p['installments'])+' cuotas de '+_money(p['installment_amount']) for p in options)+'\n\nLas condiciones finales se validan al elegir el plan y la tarjeta en el checkout.'
            else:reply+='\n\nPara confirmar las cuotas necesito verificar el talle/color y el plan vigente. ¿Qué variante te interesa?'
        else:reply+='\n\n¿Qué producto te interesa? Así te confirmo el contado y las cuotas vigentes.'
    except Exception:reply+='\n\nNo pude verificar los importes de las cuotas en este momento. Un asesor puede confirmártelos antes de pagar.'
    return answer(reply)

def guard_model_reply(decision):
    # Quotes and bank details have deterministic paths. The model must not
    # invent a monetary claim even when it writes pesos/ARS without a $ sign.
    if re.search(r'\$|\b(?:cbu|cvu|alias|cuotas?|sin interes|cuenta bancaria|numero de cuenta|pesos|ars|contado|precio|importe|financiacion|transferencia|tarjetas?)\b',normalize(decision.reply)):
        return BotDecision('Necesitamos que un asesor confirme los importes o los datos oficiales de pago antes de avanzar.',True,'ventas','Respuesta comercial sin cotización verificable','normal')
    return decision
