"""Resolve customer intent before treating their words as catalog filters.

Page metadata identifies a candidate only; facts always come from the fresh
catalog. Explicit customer product references take precedence over the page.
"""
import re
from urllib.parse import urlsplit, parse_qs, unquote

from .ai import BotDecision
from .routing import normalize, explicit_handoff, is_combined_payment, PRODUCT_BRANDS


def body(row):
    return str(row.get('body') or row.get('content') or row.get('text') or '')


def role(row):
    return str(row.get('sender') or row.get('role') or '')


def canonical(text):
    return ' '.join(re.findall(r'\w+', normalize(str(text))))


def answer(reply, products=None, handoff=False, department='ventas', reason='Consulta contextual'):
    return BotDecision(reply, handoff, department, reason, 'normal'), products or []


def previous(history, text):
    rows=list(history or [])
    if rows and role(rows[-1]) in {'customer','user'} and body(rows[-1]).strip()==text.strip():
        rows.pop()
    return rows


def catalog_brands(products):
    return set(PRODUCT_BRANDS) | {canonical(p.get('brand','')) for p in products if p.get('brand')}


def named_products(text, products):
    """Conservative contiguous brand/model match, independent of stock."""
    value=' '+canonical(text)+' '
    matches=[];brands=catalog_brands(products)
    for p in products:
        name=canonical(p.get('name',''))
        brand=canonical(p.get('brand',''))
        # Some exported rows omit the brand taxonomy but retain it in the name.
        if not brand or ' '+brand+' ' not in ' '+name+' ':
            present=[b for b in brands if ' '+b+' ' in ' '+name+' ']
            brand=min(present,key=lambda b:name.index(b)) if present else ''
        # Catalog names often include wheel size and specification suffixes.
        # Require brand plus at least a model token; a bare brand is ambiguous.
        words=name.split()
        labels=[name] if name else []
        b=brand.split()
        wrong_version=False
        for i in range(len(words)-len(b)) if b else []:
            if words[i:i+len(b)]==b:
                tail=words[i+len(b):]
                if tail:
                    prefix=' '.join(b+tail[:1]);labels.append(prefix)
                    # Explicit version numbers identify a model; never discard them.
                    pattern=r'\b'+re.escape(prefix)+r'\s+((?:gt\s+)?\d+(?:[.,]\d+)*)\b'
                    requested=re.search(pattern,normalize(text))
                    if requested:
                        actual=re.search(pattern,normalize(str(p.get('name',''))))
                        wrong_version=not actual or requested[1].replace(',','.')!=actual[1].replace(',','.')
        if wrong_version:continue
        if any(' '+label+' ' in value for label in labels):
            # Longer matches separate e.g. Procaliber 8 from Procaliber 9.
            score=max((n for n in range(1,len(words)+1)
                       if any(' '+' '.join(words[i:i+n])+' ' in value
                              for i in range(len(words)-n+1))),default=0)
            matches.append((score,p))
    best=max((score for score,_ in matches),default=0)
    return [p for score,p in matches if score==best]


def suggested_reference(text, products):
    """One small brand/model typo can prompt confirmation, never select stock."""
    from .query_spelling import distance
    tokens=canonical(text).split();brands=catalog_brands(products);labels=set();families=set()
    for product in products:
        words=canonical(product.get('name','')).split()
        families.update((word,words[i+1]) for i,word in enumerate(words[:-1]) if word in brands)
    for label in families:
        for j in range(len(tokens)-1):
            typed=tokens[j:j+2]
            if typed[0]!=label[0] and typed[1]!=label[1]:continue
            k=0 if typed[0]!=label[0] else 1
            if not typed[k].isalpha() or not label[k].isalpha() or min(len(typed[k]),len(label[k]))<3:continue
            if distance(typed[k],label[k])==1:
                suffix=re.search(r'\b'+re.escape(' '.join(typed))+r'\s+((?:gt\s+)?\d+(?:[.,]\d+)*)\b',normalize(text))
                labels.add(' '.join(label)+(' '+suffix[1] if suffix else ''))
    return next(iter(labels)) if len(labels)==1 else None


def confirmed_reference(text, reply):
    match=re.search(r'¿Te referís a «([^»]+)»\?',reply)
    yes=re.fullmatch(r'(?:si|si por favor|si gracias|exacto|correcto|esa|ese|dale)',canonical(text))
    return match[1] if match and yes else None


def page_product(conversation, products):
    c=conversation if isinstance(conversation,dict) else {}
    raw=str(c.get('page_url') or '')
    try:page=urlsplit(raw)
    except ValueError:return None
    if page.scheme not in {'http','https'}:return None
    # Do not use titles from unrelated origins, categories or checkout pages.
    allowed={urlsplit(str(p.get('url') or '')).hostname for p in products}
    if page.hostname not in allowed:return None
    ids=parse_qs(page.query).get('p',[])+parse_qs(page.query).get('product_id',[])
    candidates=[p for p in products if str(p.get('id')) in ids]
    if len(candidates)==1:return candidates[0]
    if not re.search(r'/(?:producto|product)/[^/]+',page.path):return None
    title=canonical(c.get('page_title',''))
    slug=canonical(unquote(page.path.rstrip('/').split('/')[-1]))
    candidates=[]
    for p in products:
        name=canonical(p.get('name',''))
        target=urlsplit(str(p.get('url') or ''))
        if (target.path.rstrip('/')==page.path.rstrip('/') and target.path!='/') or (
                name and (title==name or title.startswith(name+' fusion bikes') or slug==name)):
            candidates.append(p)
    return candidates[0] if len(candidates)==1 else None


def resolve_candidates(text, history, conversation, products):
    current=named_products(text,products)
    if current:return current,True
    # An explicit unknown brand/model must not silently inherit the page model.
    brands=catalog_brands(products)
    value=canonical(text)
    if any(' '+b+' ' in ' '+value+' ' for b in brands):return [],True
    target=re.search(r'(?:peso (?:de|del)|pesa|modelo)\s+(.*)',value)
    if target and target[1] not in {'esta','este','esta bici','esta bicicleta','la bici','la bicicleta','el producto'}:
        return [],True
    rows=previous(history,text)
    for index in range(len(rows)-1,-1,-1):
        row=rows[index]
        if role(row) not in {'customer','user'}:continue
        selected=named_products(body(row),products)
        if selected:return selected,False
        if index and role(rows[index-1]) in {'bot','assistant'}:
            confirmed=confirmed_reference(body(row),body(rows[index-1]))
            if confirmed:return named_products(confirmed,products),False
            options=shown_versions(body(rows[index-1]),products)
            chosen=narrow_version(body(row),options)
            if chosen:return chosen,False
        # A new named product that is absent from the snapshot clears old context.
        old=' '+canonical(body(row))+' '
        if any(' '+b+' ' in old for b in brands):return [],False
    page=page_product(conversation,products)
    return ([page] if page else []),False


def technical_kind(text):
    from .query_spelling import normalize_query
    value=normalize(normalize_query(text))
    if re.search(r'\b(?:equipamiento|componentes|especificaciones|ficha tecnica|caracteristicas|descripcion)\b',value):
        # Shopping for components is still a catalog search.
        if re.search(r'\b(?:que|cual|como|saber|consultar|informacion|detalle|trae|tiene|pasame|mostrame)\b',value) or re.match(r'^(?:el |la |las |los )?(?:equipamiento|especificaciones|ficha tecnica|caracteristicas|descripcion)\b',value):return 'equipment'
    if re.search(r'\b(?:cuantos? cambios|cuantas? velocidades)\b',value):return 'gearing'
    if re.search(r'cuanto pesa|cual es (?:el )?peso|que peso|peso de',value):return 'weight'
    if re.search(r'cantidad de dientes|relacion de dientes|cuantos dientes|(?:plato|pinon).*(?:trae|tiene)|que.*(?:plato|pinon|transmision|horquilla).*trae',value):return 'component'
    if re.search(r'\b(?:medidas|largo|geometria)\b.*\bcuadro\b',value):return 'component'
    return None


def version_question(candidates, intent):
    intro='Para orientarte con el talle' if intent=='fit' else 'Para revisar el equipamiento o dato técnico'
    options=['• '+str(p.get('name',''))+'\n'+str(p.get('url','')) for p in candidates[:5]]
    reply=intro+', estas son las versiones del catálogo:\n\n'+'\n\n'.join(options)
    if len(candidates)>5:reply+='\n\nHay más versiones con ese nombre.'
    return answer(reply+'\n\n¿Cuál de estas versiones estás mirando?',candidates[:5],reason='Aclarar versión para '+intent)


def narrow_version(text, candidates):
    """A short version answer can only select among the preceding candidates."""
    value=canonical(text)
    value=re.sub(r'^(?:(?:la|el|una|un|version|modelo|es)\s+)+','',value)
    if not value or len(value.split())>8:return []
    return [p for p in candidates if ' '+value+' ' in ' '+canonical(p.get('name',''))+' ']


def reference_answer(text, products):
    value=canonical(text)
    return len(value.split())<=12 and any(
        re.search(r'\b'+re.escape(b)+r'\s+\w+',value) for b in catalog_brands(products))


def shown_versions(reply, products):
    if 'cual de estas versiones estas mirando' not in normalize(reply):return []
    urls={u.rstrip('.,;)') for u in re.findall(r'https?://[^\s<>]+',reply)}
    return [p for p in products if str(p.get('url') or '') in urls]


def unresolved_reference(text, intent, products):
    label=re.sub(r'^(?:una?|la|el)\s+','',str(text).strip(),flags=re.I)[:160]
    mentions=[m for b in catalog_brands(products) for m in [re.search(r'\b'+re.escape(b)+r'\b',normalize(label))] if m]
    if mentions:label=label[min(m.start() for m in mentions):].strip(' ?.!')
    topic='Para orientarte con el talle' if intent=='fit' else 'Para revisar ese dato técnico'
    return answer(topic+', tomé «'+label+'» como modelo, pero no pude identificar su versión exacta. ¿Me pasás el enlace del producto?',
                  reason='Modelo informado; falta identificar versión')


HUMAN_OFFER='¿Preferís hablar con un asesor?'


def clip_utf8(text, limit):
    return text.encode('utf-8')[:max(0,limit)].decode('utf-8',errors='ignore').rstrip()


def equipment_reply(product):
    from .catalog_stock import available_product
    if available_product(product) is None:return unavailable_reply([product])
    from .product_description import fetch_product_description
    name=clip_utf8(str(product.get('name','')),500)
    url=str(product.get('url',''))
    if len(url.encode('utf-8'))>2048:url=''
    try:detail=fetch_product_description(product.get('id'))
    except Exception:detail=None
    description=str(detail.get('description') or '').strip() if detail else ''
    if not description:
        return answer('No tengo disponible la descripción de '+name+' en este momento.\n'+url+'\n\n'+HUMAN_OFFER,
                      [product],reason='Descripción no disponible; ofrecer asesor')
    url=detail['url']
    prefix='Te paso la descripción publicada de '+name+':\n\n'
    suffix='\n\n'+url+'\n\n'+HUMAN_OFFER
    note='\n\nLa descripción continúa en la ficha del producto.'
    # WP stores 4000 characters (bytes without mbstring); WhatsApp allows 4096.
    budget=3900-len((prefix+suffix).encode('utf-8'))
    truncated=detail.get('description_truncated') or len(description.encode('utf-8'))>budget
    if truncated:
        description=clip_utf8(description,budget-len((note+'…').encode('utf-8')))+'…'+note
    return answer(prefix+description+suffix,[product],reason='Descripción publicada; ofrecer asesor')


def measurements(rows):
    height=None;last_reply=''
    for row in rows:
        if role(row) in {'bot','assistant'}:
            last_reply=normalize(body(row));continue
        if role(row) not in {'customer','user'}:continue
        v=normalize(body(row))
        m=re.search(r'\b(?:mido|altura(?: es| de)?|estatura(?: es| de)?)\s*[:=]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:cm|m(?:etros?)?)?',v)
        if m:
            n=float(m[1].replace(',','.'));n=n*100 if n<3 else n
            if 90<=n<=230:height=round(n)
        # Bare numbers inherit only the immediately preceding question.
        m=re.fullmatch(r'\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|m|metros)?[.!]?\s*',v)
        if m:
            n=float(m[1].replace(',','.'))
            if 'cuanto medis' in last_reply:
                n=n*100 if n<3 else n
                if 90<=n<=230:height=round(n)
        last_reply=''
    return height


def height_size_reply(height,product=None):
    from .ai import base_size_orientation
    orientation=base_size_orientation(height)
    reply='Según nuestra tabla base, para '+str(height)+' cm de altura la orientación es '+orientation+'.'
    if product:reply+=' Para '+product['name']+', tomalo como referencia: el ajuste puede variar según el modelo.'
    else:reply+=' Es una referencia general; el ajuste puede variar según el modelo.'
    if product:
        sizes=[]
        for variant in product.get('variations') or []:
            attrs=variant.get('attributes') or {}
            raw=str(attrs.get('attribute_pa_talle') or attrs.get('attribute_talle') or attrs.get('size') or '').upper().strip()
            match=re.match(r'^(?:TALLE\s*)?(XXS|XS|XXL|XL|S|M|L)\b',raw)
            if match and match[1] not in sizes:sizes.append(match[1])
        wanted=re.findall(r'\b(?:XXS|XS|XXL|XL|S|M|L)\b',orientation)
        matches=[s for s in sizes if s in wanted]
        if matches:reply+='\n\nEn el catálogo de ese modelo figura stock en talle '+', '.join(matches)+'.'
        elif sizes and height>145:reply+='\n\nNo veo esos talles disponibles para ese modelo en el catálogo. '+HUMAN_OFFER
    return answer(reply,[product] if product else [],reason='Orientación por altura y tabla base')


def inquiry_decision(text, history, conversation, business, loader):
    from .query_spelling import normalize_query, normalize_history
    text=normalize_query(text);history=normalize_history(history)
    v=normalize(text);rows=previous(history,text)
    last=next((body(r) for r in reversed(rows) if role(r) in {'bot','assistant'}),'')
    prev=normalize(last)
    confirmed=confirmed_reference(text,last)
    if confirmed:text=confirmed;v=normalize(text)
    elif '¿Te referís a «' in last and canonical(text) in {'no','no gracias','otra','otro'}:
        return answer('¿Me pasás el nombre completo o el enlace del modelo que estás mirando?',reason='Cliente descarta modelo sugerido')
    if last.strip().endswith(HUMAN_OFFER):
        choice=canonical(text)
        decline=re.fullmatch(r'(?:no(?: gracias| por ahora| por el momento)?|no (?:quiero|prefiero) hablar con (?:un )?(?:humano|asesor|persona)|prefiero seguir (?:aca|con vos|con el bot))',choice)
        accept=re.fullmatch(r'(?:(?:si|dale|ok|bueno|por favor|claro)(?: por favor| gracias| dale| pasame)?|(?:si )?(?:quiero|prefiero|me gustaria) hablar con (?:un |una )?(?:humano|asesor|persona)|(?:pasame|derivame)(?: con (?:un |una )?(?:humano|asesor|persona))?)',choice)
        if decline:return answer('Dale, seguimos por acá. Podés hacerme otra consulta sobre el producto.',reason='Cliente continúa con el bot')
        if accept:return answer('Te derivo con un asesor para continuar con tu consulta sobre el producto.',handoff=True,reason='Cliente acepta atención humana tras descripción')
    if re.search(r'\b(?:descuentos?|promociones?)\b',v) and not re.search(r'\b(?:cuotas?|tarjetas?|credito|asesor|humano|persona)\b',v):
        return answer('Los descuentos y promociones deben confirmarse para el producto y el medio de pago. '+HUMAN_OFFER,reason='Promoción sin condiciones verificadas')
    if re.search(r'\bgarantias?\b',v) and not re.search(r'\b(?:compre|mi compra|mi pedido|falla|fallo|roto|rompio|reclamo|tramitar|ejecutar|asesor|humano|persona)\b',v):
        return answer('La cobertura y el plazo de garantía se confirman para cada producto. '+HUMAN_OFFER,reason='Garantía antes de comprar')
    if explicit_handoff(text) and not is_combined_payment(text):return None
    if re.search(r'\bfacturas?\b',v):
        bought=bool(re.search(r'\b(?:compre|compramos|compra realizada|mi compra|mi pedido|hace (?:un|\d+))\b',v))
        if bought:
            return answer('Un asesor de posventa te ayuda a recuperar la factura de tu compra. ¿Tenés el número de pedido?',
                          handoff=True,department='posventa_taller',reason='Recuperación de factura')
        return answer('¿Necesitás la factura de una compra ya realizada o consultar la facturación antes de comprar?',reason='Consulta de facturación')
    # The published business configuration has no currency/financing matrix.
    # Avoid unsupported denials, exchange rates and invented installment amounts.
    if re.search(r'\b(?:dolares?|usd|euros?)\b',v) and re.search(r'\b(?:pago|pagar|transfer\w*|efectivo|acept\w*|recib\w*|cuotas?)\b',v) or (
            re.search(r'\b(?:dolares?|usd|euros?)\b',v) and re.search(r'\b(?:pago|transferencia|efectivo|moneda)\b',prev)):
        return answer('Un asesor debe confirmar la moneda y las condiciones de ese pago, incluidos los importes y las cuotas si combinás medios. Te derivo para coordinarlo.',
                      handoff=True,reason='Confirmar pago en moneda extranjera')
    if is_combined_payment(text):
        return answer('Un asesor te ayuda a combinar los medios de pago y confirmar los importes y las cuotas para tu compra.',
                      handoff=True,reason='Confirmar condiciones de pago combinado')
    if re.search(r'\b(?:cuotas?|financiar\w*|financiacion|interes(?:es)?)\b',v) and not re.search(r'\b(?:busco|buscando)\b',v):
        return answer('Para financiarla hay que confirmar el plan disponible para el producto y tu tarjeta, con el valor de cada cuota y el total. Un asesor lo revisa antes de que pagues.',
                      handoff=True,reason='Financiación sin plan verificado')
    if re.search(r'\buber\s*moto\b',v):
        return answer('Un asesor debe confirmar la preparación del pedido y coordinar el retiro por Uber Moto.',handoff=True,reason='Coordinar retiro por tercero')

    reverse_fit=re.search(r'\b(?:para que altura|que altura|cuanto (?:debe|tiene que) medir|para cuanto)\b.*?\b(?:talle\s+)?(xxs|xs|s|m|l|xl|xxl)\b',v)
    fit=bool(re.search(r'consultar (?:por |sobre )?(?:(?:el|los|la|las) )?(?:talles?|tallas?)\b|que (?:talle|talla).*(?:soy|corresponde|recomend|necesito)|talle.*(?:correcto|queda|sirve)|\b(?:mido|entrepierna)\b',v))
    fit=fit or bool(reverse_fit) or bool(re.search(r'\bque (?:talle|talla)(?: seria| soy| me corresponde)?[ ?.!]*$',v))
    fit_follow=any(cue in prev for cue in ('cuanto medis','medida de entrepierna','para orientarte con el talle','segun nuestra tabla base'))
    technical=technical_kind(text)
    if not technical and ('queres confirmar algun componente en particular' in prev or last.strip().endswith(HUMAN_OFFER)):
        if re.fullmatch(r'(?:(?:la|el|los|las)\s+)?(?:horquilla|frenos?|transmision|cuadro|plato|pinon|peso)[?.!\s]*',v):
            technical='weight' if 'peso' in v else 'component'
    technical_follow=any(cue in prev for cue in ('producto y modelo queres confirmar ese dato tecnico','para revisar el equipamiento o dato tecnico','para revisar ese dato tecnico'))
    choosing='cual de estas versiones estas mirando' in prev
    stock=bool(re.search(r'\b(?:disponible|disponibilidad|stock)\b|(?:tenes|tienen).*(?:talle|color)|(?:talle|color).*(?:tenes|tienen)|unico color',v))
    if confirmed and 'para confirmar disponibilidad' in prev:stock=True
    brand_only=False
    # Loading here cannot turn invoice/payment/shipping questions into searches.
    if not (fit or fit_follow or technical or technical_follow or stock or conversation):return None
    try:products=loader()
    except Exception:
        if fit or fit_follow:return answer('No pude consultar un catálogo actualizado para identificar la versión y su guía de talles. Un asesor debe continuar con los datos que ya nos pasaste.',handoff=True,reason='Talle sin catálogo actualizado')
        if technical or stock:return answer('No pude consultar un catálogo actualizado. Un asesor debe confirmar ese dato; no puedo determinar la disponibilidad con esta consulta.',handoff=True,reason='Catálogo no disponible')
        return None
    if (fit or technical or fit_follow or technical_follow or stock) and not named_products(text,products):
        suggestion=suggested_reference(text,products)
        if suggestion:
            topic='Para orientarte con el talle' if fit or fit_follow else 'Para revisar el equipamiento o dato técnico' if technical or technical_follow else 'Para confirmar disponibilidad'
            return answer(topic+'. ¿Te referís a «'+suggestion+'»?',reason='Confirmar posible error en marca o modelo')
    page=page_product(conversation,products)
    if page and canonical(text)==canonical(page.get('brand','')):
        brand_only=True;candidates=[page];explicit=False
    else:candidates,explicit=resolve_candidates(text,history,conversation,products)
    if choosing and not explicit:
        # Restrict short answers to versions actually shown in the last reply.
        shown=shown_versions(last,products)
        narrowed=narrow_version(text,shown)
        candidates=narrowed or candidates
    selected=candidates[0] if len(candidates)==1 else None
    supplied=reference_answer(text,products)
    if fit_follow and not fit:
        fit=not technical and not stock and bool(re.fullmatch(r'\s*\d{1,3}(?:[.,]\d{1,2})?\s*(?:cm|m|metros)?[.!]?\s*',v) or named_products(text,products) or supplied or choosing)
    if technical_follow and not technical and not fit and not stock and (supplied or choosing or named_products(text,products)):
        technical=next((technical_kind(body(r)) for r in reversed(rows) if role(r) in {'customer','user'} and technical_kind(body(r))), 'component')
    if reverse_fit:
        size=reverse_fit[1].upper()
        model=(' de '+selected['name']) if selected else ''
        return answer('Para confirmar a qué altura corresponde el talle '+size+model+', necesitamos la guía de ese modelo. El talle publicado no alcanza para asegurar el ajuste. '+HUMAN_OFFER, [selected] if selected else [], reason='Altura asociada a un talle: requiere guía del modelo')
    if (fit or technical) and candidates:
        from .catalog_stock import available_product
        available=[p for candidate in candidates if (p:=available_product(candidate)) is not None]
        if not available:return unavailable_reply(candidates)
        candidates=available
        selected=candidates[0] if len(candidates)==1 else None
    if fit:
        if len(candidates)>1:return version_question(candidates,'fit')
        if not selected:
            if supplied:return unresolved_reference(text,'fit',products)
            height=measurements(rows+[{'sender':'customer','body':text}])
            if height is not None:return height_size_reply(height)
            return answer('Para orientarte con el talle, ¿qué producto y modelo estás mirando?',reason='Identificar producto para talle')
        from .catalog_words import product_kind
        kind=product_kind(selected);name=selected['name']
        if kind=='bicicleta':
            height=measurements(rows+[{'sender':'customer','body':text}])
            if height is None:return answer('Para orientarte con el talle de '+name+', ¿cuánto medís?', [selected],reason='Solicitar altura para talle')
            return height_size_reply(height,selected)
        if kind=='casco':return answer('Para orientarte con el talle de '+name+', ¿cuál es tu contorno de cabeza en centímetros?', [selected],reason='Talle de casco')
        return answer('Para '+name+' necesitamos revisar la guía de talles de ese producto. Un asesor te ayuda a confirmar la medida.',[selected],True,reason='Guía de talles específica')
    if technical:
        if len(candidates)>1:return version_question(candidates,'technical')
        if not selected and supplied:return unresolved_reference(text,'technical',products)
        if not selected:return answer('¿De qué producto y modelo querés confirmar ese dato técnico?',reason='Identificar producto para ficha técnica')
        if technical=='equipment':return equipment_reply(selected)
        if technical=='gearing':
            gearing=re.search(r'\b([123])\s*x\s*(\d{1,2})\s*v?\b',normalize(selected['name']))
            if gearing:
                return answer('En el nombre publicado de '+selected['name']+' figura una transmisión '+gearing[1]+'×'+gearing[2]+'.',[selected],reason='Transmisión del nombre verificado')
        detail='el peso' if technical=='weight' else 'la especificación técnica que consultás'
        return answer('Identifico '+selected['name']+', pero no tengo '+detail+' verificado en el catálogo disponible. Un asesor debe revisar la ficha de ese modelo.',[selected],True,reason='Dato técnico no verificado para el modelo')
    if stock or brand_only:
        if not selected:
            # Keep full searches ("bicicletas MTB disponibles") in the existing flow.
            if re.search(r'\b(?:la tienen|lo tienen|esta disponible|en la pagina|unico color)\b',v):
                return answer('¿Me pasás el nombre completo del producto para confirmar su disponibilidad?',reason='Identificar producto para stock')
            return None
        from .catalog_flow import _state, _match, _render
        brands={canonical(p.get('brand','')) for p in products if p.get('brand')}
        size=re.search(r'\b(?:talle|talla)\s+(xxs|xs|s|m|l|xl|xxl|\d{2})\b',v)
        query=selected['name']+' '+text
        state,_=_state(query,[],brands,products)
        if state is None:return None
        # Identity was resolved above; names may contain specification tokens.
        state.update(kind=None,subtype=None,brands=[],identity=[],selection=None,
                     size=size[1].upper() if size else None)
        matching,_=_match([selected],state)
        if matching:return answer(_render(matching,state,''),matching,reason='Disponibilidad del producto identificado')
        if state['color'] or state['feature'] or state['bounds']:
            return answer('No pude confirmar esa combinación de características para '+selected['name']+'. Un asesor debe revisar la variante solicitada.',[selected],True,reason='Variante o característica sin confirmar')
        scope=' en talle '+size[1].upper() if size else ''
        return answer('El catálogo consultado no muestra stock disponible de '+selected['name']+scope+'. Un asesor puede confirmar si hubo cambios de disponibilidad.',[selected],True,reason='Sin disponibilidad en snapshot actualizado')
    return None


def unavailable_reply(products):
    name=clip_utf8(str(products[0].get('name','Ese modelo')),500) if len(products)==1 else 'Las versiones de ese modelo'
    return answer(name+' no figura'+('n' if len(products)>1 else '')+' con stock disponible en el catálogo consultado.\n\n'+HUMAN_OFFER,
                  reason='Modelo identificado sin stock; ofrecer asesor')
