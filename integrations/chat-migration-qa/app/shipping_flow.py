"""Pre-purchase shipping policy with multiple questions and destination context."""
import re
from .ai import BotDecision
from .routing import normalize, explicit_handoff
from .order_flow import before_purchase, order_intent, body, role


def shipping_decision(text, history, business):
    value=normalize(text)
    if explicit_handoff(text) or order_intent(text):return None
    if re.search(r'\b(?:uber\s*moto|reclamo|garantia|devolucion|factura)\b',value):return None
    rows=list(history or [])
    if rows and role(rows[-1]) in {'customer','user'} and body(rows[-1]).strip()==text.strip():rows.pop()
    last=next((normalize(body(row)) for row in reversed(rows) if role(row) in {'bot','assistant'}),'')
    shipping=bool(re.search(r'\b(?:envios?|enviar|envian|mandan|entregas?|despach\w*|andreani)\b',value))
    assembly=bool(re.search(r'\b(?:semi\s*armad[ao]s?|armad[ao]s?|desarmad[ao]s?|armado|ensamblad[ao]s?)\b',value))
    # Wheelsets are assembled products, not bicycle shipping instructions.
    if re.search(r'\b(?:ruedas?|llantas?)\s+armad[ao]s?\b',value):assembly=False
    follow=before_purchase(text) and ('envio' in last or 'compra ya realizada' in last)
    if not (shipping or assembly or follow):return None
    # Product shopping and currency questions keep their own validated flows.
    if re.search(r'\b(?:busco|buscando|usd|dolares?|euros?)\b',value):return None
    if re.search(r'\b(?:tenes|tienen)\b',value) and not re.search(r'\b(?:hacen|cuanto|costo|sale|valor|cobran|tienen envios)\b',value):return None
    # Resume the prior question when a customer answers an older generic prompt.
    relevant=text
    if follow:
        relevant=next((body(row) for row in reversed(rows) if role(row) in {'customer','user'} and re.search(r'\benvio',normalize(body(row)))),text)
        assembly=assembly or bool(re.search(r'\b(?:semi\s*armad[ao]s?|armad[ao]s?|desarmad[ao]s?|armado)\b',normalize(relevant)))
        shipping=True
    b=business if isinstance(business,dict) and business.get('enabled') is True else {}
    sections=[];handoff=False
    if shipping:
        exception=bool(re.search(r'\b(?:tierra del fuego|ushuaia|tolhuin)\b',normalize(relevant)))
        if exception:
            sections.append('Tierra del Fuego es una excepción: un asesor debe confirmar las condiciones de envío para ese destino.')
            handoff=True
        else:
            from .business_info import business_decision
            # Keep explicit amount questions intact; never treat a postcode as price.
            cost_query=text if re.search(r'\b(?:cuanto|costo|cuesta|sale|valor|precio|cobran|gratis)\b',value) else 'costo de envio'
            policy=business_decision(cost_query,rows,b) if b else None
            if policy is None and b:policy=business_decision('costo de envio',[],b)
            if policy:sections.append(policy[0].reply)
            else:
                sections.append('No tengo disponibles las condiciones de envío publicadas. Un asesor debe confirmarlas.')
                handoff=True
        if b.get('carrier'):sections.append('Enviamos por '+b['carrier']+'.')
        cp=re.search(r'\b(?:cp|codigo postal)\s*[:#-]?\s*([A-Z]?\d{4}(?:[A-Z]{3})?)(?!\w)',relevant,re.I)
        if cp:sections.append('Ya tengo el CP '+cp[1].upper()+'.')
        if re.search(r'\b(?:tarda\w*|demora\w*|plazo|dias|cuando|llega\w*|tiempo)\b',normalize(relevant)):
            if b.get('delivery_info'):sections.append(b['delivery_info'])
            else:sections.append('No tengo confirmado el plazo de entrega para esa compra; un asesor puede revisarlo.')
    if assembly:
        if b.get('assembly_info'):sections.append(b['assembly_info'])
        else:
            sections.append('No tengo confirmada la modalidad de armado para el envío. Un asesor debe revisar ese dato.')
            handoff=True
    if handoff:sections.append('Te derivo con un asesor para continuar con los datos que ya nos pasaste.')
    return BotDecision('\n\n'.join(sections),handoff,'ventas','Información del negocio verificada' if b and not handoff else 'Condiciones de envío por confirmar','normal'),[]
