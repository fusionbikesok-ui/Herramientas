"""Shared catalog intent, filtering and conversation state for preview and worker."""
import re
from decimal import Decimal, InvalidOperation
from .ai import BotDecision
from .routing import normalize, explicit_handoff, is_combined_payment, is_service_question
from .budget_amounts import budget_range, amount, WORDS
from .catalog_words import words, meaningful, phrase, product_kind, TYPES, SUBTYPES, COLORS, NOISE
from .catalog_source import load_products

CHILD_URL='https://fusionbikes.com.ar/product-category/bicicletas-por-marca/bicicletasinfantiles/'
MORE={'mas','ver mas','mostrame mas','mostrar mas','mostrame otras','otras opciones','mas opciones','tenes mas','tenes otras','que otras tenes'}
OTHER_BRANDS=re.compile(r'\b(?:otra|otras)\s+marcas?\b')
NO_MORE={'no','no gracias','no por ahora','por ahora no','no gracias por ahora','no gracias ya esta','no hace falta','por el momento no'}
YES={'si','si quiero','si mostrame','dale','bueno'}
NOISE=NOISE | set('estan esta tendras ofrecerme alguna alguno algunos algunas interesa gusta prefiero mejor tengo necesito cuento presupuesto maximo pesos ars mas otras otros tambien'.split())
HORN_QUESTION='¿Buscás los puños con cuernitos integrados o los cuernitos que se agregan al manubrio?'
SIZE=r'(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|\d{2})'


def _body(row):return str(row.get('body') or row.get('content') or row.get('text') or '').strip()
def _role(row):return str(row.get('sender') or row.get('role') or '').lower()
def _urls(text):return list(dict.fromkeys(re.findall(r'https?://[^\s<>\[\]()]+',text)))
def _answer(text,products=None,handoff=False,reason='Catálogo guiado'):
    return BotDecision(text,handoff,'ventas',reason,'normal'), products or []

def _money(value):
    try:
        n=Decimal(str(value))
        return n if n.is_finite() and n>0 else None
    except (InvalidOperation,ValueError,TypeError):return None

def _format(value):
    decimals=0 if value==value.to_integral_value() else 2
    return '$'+format(value,f',.{decimals}f').replace(',','_').replace('.',',').replace('_','.')

def _without_budget(value):
    marker=re.search(r'\b(?:entre|desde|hasta|maximo|presupuesto(?: de)?|tengo|de)\s+',value)
    explicit=re.search(r'\b(?:entre|desde|hasta|maximo|presupuesto(?: de)?|tengo)\s+',value)
    marker=explicit or marker
    if not marker:return value
    end=marker.end()
    for m in re.finditer(r'\d+(?:[.,]\d+)*|[a-z]+|[^\w\s]',value[end:]):
        t=m.group()
        if t in WORDS or t in {'$', '.', ','} or re.fullmatch(r'\d+(?:[.,]\d+)*',t):
            finish=marker.end()+m.end()
        else:break
    else:
        finish=len(value)
    finish=locals().get('finish',marker.end())
    return value[:marker.start()]+' '+value[finish:]


def _singular(word):
    return word[:-1] if len(word)>4 and word.endswith('s') else word

def _type_words(text,types):
    return [_singular(w) if w not in TYPES and _singular(w) in types else w for w in words(text)]

def _parse(raw,brands,existing=None,types=TYPES):
    from .catalog_spelling import strip_greeting
    value=strip_greeting(raw).strip(' .,!¡?¿')
    # Conversation acknowledgements are not product names. Strip only leading
    # fillers; keep identical words when they occur inside a model identity.
    value=re.sub(r'^(?:(?:ok|okay|dale|bueno|bien|perfecto|joya|listo|genial)[\s,;:!¡.?¿]+)+','',value).strip()
    tokens=_type_words(value,types)
    head_tokens=_type_words(re.split(r'\bcon\b',value,maxsplit=1)[0],types)
    kind=next((w for w in head_tokens if w in types),None)
    subtype=next((w for w in tokens if w in SUBTYPES),None)
    if subtype and not kind and (not existing or existing.get('kind')=='bicicleta'):
        kind='bicicleta'
    b=[b for b in brands if ' '+b+' ' in ' '+' '.join(tokens)+' ']
    # Accept a short brand only if the catalog resolves it uniquely (ESI -> ESI Grips).
    brand_aliases=set()
    if not b:
        for token in tokens:
            candidates=[brand for brand in brands if brand.split()[0]==token]
            if len(token)>=3 and len(candidates)==1:
                b.append(candidates[0]);brand_aliases.add(token)
    bounds=budget_range(raw)
    if existing and not bounds and (re.search(r'(?:millon|millones|mil|k)\b',value) or re.fullmatch(r'\d{4,}',value)):
        try:bounds=(Decimal(0),amount(raw))
        except (ValueError,InvalidOperation):pass
    size_match=re.search(r'\b(?:talle|talla)\s+'+SIZE+r'\b',value)
    bare_size=re.fullmatch(r'(?:(?:en|busco|quiero|necesito)\s+)?'+SIZE,value)
    size=(size_match or bare_size)
    size=size.group(1).upper() if size else None
    color=[w for w in tokens if w in COLORS]
    work=_without_budget(value) if bounds else value
    if size_match:work=re.sub(r'\b(?:talle|talla)\s+'+SIZE+r'\b',' ',work)
    elif bare_size:work=''
    feature=''
    feature_match=re.search(r'\b(?:con|tipo)\s+(.+)',work)
    if feature_match:
        feature=' '.join(w for w in meaningful(feature_match.group(1)) if w not in COLORS and w not in {'talle','talla'})
        work=work[:feature_match.start()]
    remove=set(NOISE)|brand_aliases|({kind} if kind else set())|SUBTYPES|set(color)
    for brand in b:remove.update(brand.split())
    identity=[w for w in _type_words(work,types) if w not in remove]
    if kind=='bicicleta' and subtype=='infantil':identity=[]
    return dict(kind=kind,subtype=subtype,brands=b,bounds=bounds,size=size,color=color,
                identity=identity,feature=feature,value=value)


def _state(text,history,brands,products,types=TYPES):
    rows=[r for r in history or [] if isinstance(r,dict)]
    if rows and _role(rows[-1]) in {'customer','user'} and _body(rows[-1])==text.strip():rows.pop()
    rows.append({'sender':'customer','body':text})
    state=None; last_bot=''; action='search'
    by_url={str(p.get('url','')):p for p in products}
    for row in rows:
        if _role(row) in {'bot','assistant'}:
            last_bot=_body(row)
            if state:
                shown=[u for u in _urls(last_bot) if u in by_url]
                if shown:state['shown']=shown;state['seen'].update(shown)
            continue
        if _role(row) not in {'customer','user'}:continue
        raw=_body(row);v=normalize(raw).strip(' .,!¡?¿');action='search'
        if is_service_question(raw) or explicit_handoff(raw) or is_combined_payment(raw) or re.search(r'\b(?:donde|pagar|pago|pagos|cuotas?|transferencia|tarjetas?|envios?|ubicacion|direccion|horarios?|garantias?|pedidos?|facturas?|comprobantes?)\b',v):
            state=None;continue
        if state and state.get('kind')=='bicicleta' and state.get('subtype')=='infantil':
            age=re.fullmatch(r'(?:(?:tiene|de|son)\s+)?(\d{1,2})(?:\s*anos)?',v)
            height=re.fullmatch(r'(?:(?:mide|altura|su altura es)\s+)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|m|metros?|centimetros?)?',v)
            if age and 1<=int(age.group(1))<=18:
                state['age']=int(age.group(1));action='child';continue
            if height and (height.group(2) or re.search(r'[.,]',v) or 'mide' in v):
                state['height']=height.group(0);action='child';continue
        if state and state.get('horn_pending'):
            choice=re.fullmatch(r'(?:(?:los|quiero|busco|prefiero|si|son|vienen|que|van)\s+)*(integrados?|juntos?|separados?|aparte|sueltos?)(?:\s+(?:al puno|a los punos))?',v)
            separate_phrase=bool(re.fullmatch(r'(?:los )?(?:cuernitos )?que se (?:agregan|colocan)(?: al manubrio)?',v))
            if choice or separate_phrase:
                integrated=not separate_phrase and choice.group(1).startswith(('integrad','junt'))
                state.update(kind='puno' if integrated else 'cuernito',
                             feature='cuernito' if integrated else '', identity=[],
                             horn_pending=False,selection=None,seen=set(),shown=[])
                continue
        if OTHER_BRANDS.search(v):
            if not state:
                action='brand_without_context';continue
            excluded=set(state.get('excluded_brands',[]))
            excluded.update(state['brands'])
            if not state['brands']:
                excluded.update(' '.join(words(by_url[u].get('brand',''))) for u in state['shown'])
            excluded.discard('')
            state.update(excluded_brands=sorted(excluded),brands=[],selection=None,
                         seen=set(),shown=[])
            action='other_brands';continue
        if state and v in NO_MORE and normalize(last_bot).strip(' .,!¡?¿').endswith('queres verlas'):
            action='decline_more';continue
        if state and (v in MORE or (v in YES and last_bot.endswith('¿Querés verlas?'))):action='more';continue
        if state and v in YES:action='clarify';continue
        if state and state['kind'] in {'cubierta','camara'}:
            from .tire_context import consume
            if consume({'tipo':state['kind']}, raw) and not any(w in TYPES for w in words(raw)):
                action='tire';continue
        parsed=_parse(raw,brands,state,types)
        anchor=parsed['kind'] or parsed['brands'] or (state and parsed['subtype'])
        if not state and not anchor:
            candidate=parsed['identity']
            known=bool(candidate and len(candidate)<=4 and any(all(w in words(p.get('name','')) for w in candidate) for p in products))
            explicit=bool(candidate and re.search(r'\b(?:tenes|tienen|busco|buscando)\b',v))
            if not (known or explicit):continue
            anchor=True
        if state and parsed['kind'] and parsed['kind']!=state['kind']:state=None
        if (state and parsed['kind']=='bicicleta' and parsed['subtype']
                and state['subtype'] and parsed['subtype']!=state['subtype']):
            if 'infantil' in {state['subtype'],parsed['subtype']}:
                # Another rider/category: no inherited age, height, size or budget.
                state=None
            else:
                # Keep the customer's brand and budget, but do not demand an old
                # model or assume its size/features apply to a different discipline.
                state.update(identity=[],feature='',size=None,color=[],age=None,height=None,
                             selection=None,seen=set(),shown=[])
        if state is None:
            state=dict(excluded_brands=[],types=types,kind=None,subtype=None,brands=[],identity=[],bounds=None,size=None,color=[],feature='',
                       seen=set(),shown=[],selection=None,age=None,height=None,invalid=False)
        if re.search(r'\b(?:entre|hasta|maximo|presupuesto)\b',v) and not parsed['bounds']:
            state['invalid']=True
        if not anchor and not any((parsed['bounds'],parsed['size'],parsed['color'])):
            if state['invalid']:
                continue
            if state['shown'] and parsed['identity']:
                names=[by_url[u] for u in state['shown']]
                ordinals={'primera':0,'primero':0,'segunda':1,'segundo':1,'tercera':2,'tercero':2}
                ordinal=next((ordinals[w] for w in words(raw) if w in ordinals),None)
                matches=[p for p in names if all(w in words(p.get('name','')) for w in parsed['identity'])]
                if ordinal is not None and ordinal<len(names):matches=[names[ordinal]]
                if len(matches)==1:
                    state['selection']=str(matches[0]['url']);state['seen']=set();continue
                if re.search(r'\b(?:gusta|interesa|modelo|prefiero)\b',v):action='clarify_model';continue
            if state.get('horn_pending'):action='horn_clarify';continue
            state=None;continue
        reset_selection=any(parsed[k] and parsed[k]!=state[k] for k in ('kind','subtype','brands')) or bool(parsed['identity'] and anchor)
        if parsed['brands'] and parsed['brands']!=state['brands']:
            state['identity']=[]
            state['excluded_brands']=[]
        changed=False
        for key in ('kind','subtype','brands','bounds','size','color','feature'):
            if parsed[key] and parsed[key]!=state[key]:state[key]=parsed[key];changed=True
        if parsed['bounds']:state['invalid']=False
        if parsed['identity'] and anchor:
            state['identity']=parsed['identity'];changed=True
        if changed:
            state['seen']=set();state['shown']=[]
            if reset_selection:state['selection']=None
        if parsed['kind']=='puno' and 'cuernito' in words(raw):
            explicit_integrated=bool(re.search(r'\bintegrad[oa]s?\b',v))
            state['horn_pending']=not explicit_integrated
            state['feature']='cuernito'
            state['identity']=[w for w in state['identity'] if w not in {'cuernito','integrado','integrados','tipo'}]
        elif parsed['kind']=='cuernito':state['horn_pending']=False
        if state['kind']=='bicicleta' and state['subtype']=='infantil':
            age=re.search(r'\b(\d{1,2})\s*anos\b',v)
            if age:state['age']=int(age.group(1))
            action='child'
    if state and state.get('horn_pending'):action='horn_clarify'
    return state,action


def _fields(p,v=None):
    fields=[phrase(p.get('name',''))]
    for key,val in (p.get('attributes') or {}).items():
        fields.append(phrase(key.replace('attribute_','').replace('pa_','').replace('_',' ')+' '+str(val)))
    if v:
        for key,val in (v.get('attributes') or {}).items():
            fields.append(phrase(key.replace('attribute_','').replace('pa_','').replace('_',' ')+' '+str(val)))
    return fields


def _match(products,s):
    from .catalog_stock import available_product, confirmed_stock
    exact=[];partial=[]
    for p in products:
        p=available_product(p)
        if p is None:continue
        kind=product_kind(p)
        if s['kind'] in TYPES and kind!=s['kind']:continue
        if s['kind'] and s['kind'] not in TYPES:
            categories=[_singular(w) for c in p.get('categories',[]) for w in meaningful(str(c))]
            if s['kind'] not in categories:continue
        name=words(p.get('name',''))
        category=words(' '.join(str(c) for c in p.get('categories',[])))
        if s['subtype'] and s['subtype'] not in name+category:continue
        brand=' '.join(words(p.get('brand','')))
        if any(b==brand or (' '+b+' ') in ' '+' '.join(name)+' ' for b in s.get('excluded_brands',[])):continue
        if s['brands'] and not all(b==brand or (' '+b+' ') in ' '+' '.join(name)+' ' for b in s['brands']):continue
        if not all(w in name+category+words(p.get('sku','')) for w in s['identity']):continue
        if s['selection'] and str(p.get('url',''))!=s['selection']:continue
        if s['bounds'] and str(p.get('currency','')).upper()!='ARS':continue
        variants=p.get('variations') or []
        allowed=[];confirmed=[]
        for v in variants:
            if not confirmed_stock(v,'is_in_stock'):continue
            attrs=v.get('attributes') or {}
            size=normalize(str(attrs.get('attribute_pa_talle') or attrs.get('attribute_talle') or attrs.get('size') or '')).upper()
            if s['size'] and s['size']!=size:continue
            color=words(attrs.get('attribute_pa_color') or attrs.get('attribute_color') or attrs.get('color') or '')
            if s['color'] and not all(c in color for c in s['color']):continue
            price=_money(v.get('display_price'))
            if s['bounds'] and (price is None or not s['bounds'][0]<=price<=s['bounds'][1]):continue
            allowed.append(v)
            if not s['feature'] or any(s['feature'] in field and not re.search(r'\b(?:sin|no|opcional)\b',field) for field in _fields(p,v)):confirmed.append(v)
        if variants:
            if not allowed:continue
            result=dict(p,variations=confirmed or allowed)
            (exact if confirmed else partial).append(result)
        else:
            if p.get('in_stock') is not True:continue
            attrs=p.get('attributes') or {}
            if s['size'] and str(attrs.get('attribute_pa_talle') or attrs.get('size') or '').upper()!=s['size']:continue
            if s['color'] and not all(c in words(attrs.get('attribute_pa_color',''))+name for c in s['color']):continue
            price=_money(p.get('cash_price'))
            if s['bounds'] and (price is None or not s['bounds'][0]<=price<=s['bounds'][1]):continue
            verified=not s['feature'] or any(s['feature'] in field and not re.search(r'\b(?:sin|no|opcional)\b',field) for field in _fields(p))
            (exact if verified else partial).append(p)
    def order(p):
        prices=[_money(v.get('display_price')) for v in p.get('variations') or []]
        price=min((x for x in prices if x is not None),default=_money(p.get('cash_price')) or Decimal('Infinity'))
        return price,normalize(p.get('name','')),str(p.get('id',''))
    return sorted(exact,key=order),sorted(partial,key=order)


def _render(products,s,greeting,more=False,partial=False):
    scope=[]
    if s['bounds']:scope.append('dentro de tu presupuesto')
    if s['size']:scope.append('en talle '+s['size'])
    intro='Te paso otras opciones' if more else 'Te paso lo que encontré con stock'
    if not more and s.get('kind')=='bicicleta' and s.get('subtype') in {'ruta','mtb','gravel','ciudad'}:
        label={'ruta':'de ruta','mtb':'MTB','gravel':'de gravel','ciudad':'urbanas'}[s['subtype']]
        intro='Te paso las bicicletas '+label+' que encontré con stock'
    blocks=[greeting+intro+(' '+', '.join(scope) if scope else '')+':']
    if partial:
        blocks.append('No tengo confirmado que estas versiones cumplan la característica que pediste ('+s['feature']+'). Necesitamos que un asesor revise ese detalle.')
    for p in products:
        block=['• '+str(p.get('name',''))]
        variants=p.get('variations') or []
        if variants:
            prices=[_money(v.get('display_price')) for v in variants]
            common=prices[0] if prices and all(x is not None and x==prices[0] for x in prices) else None
            ars=str(p.get('currency','')).upper()=='ARS'
            if common is not None and ars:block.append('Precio publicado: '+_format(common))
            block.append('Con stock:')
            groups={}
            for v in variants:
                attrs=v.get('attributes') or {}
                size=str(attrs.get('attribute_pa_talle') or attrs.get('attribute_talle') or attrs.get('size') or '')
                color=str(attrs.get('attribute_pa_color') or attrs.get('attribute_color') or attrs.get('color') or '')
                extra=' / '.join(str(val) for key,val in attrs.items() if key not in {'attribute_pa_talle','attribute_talle','size','attribute_pa_color','attribute_color','color'})
                label=' / '.join(x for x in (color,extra) if x) or 'Variante disponible'
                price=_money(v.get('display_price'))
                if common is None and ars:
                    label+=' — '+(_format(price) if price is not None else 'precio pendiente de confirmar')
                sizes=groups.setdefault(label,[])
                if size and size not in sizes:sizes.append(size)
            for label,sizes in list(groups.items())[:5]:
                block.append('- '+label+(': talle '+sizes[0] if len(sizes)==1 else ': talles '+', '.join(sizes) if sizes else ''))
            if len(groups)>5:block.append('Hay más variantes en el enlace del producto.')
        else:
            price=_money(p.get('cash_price'))
            if price is not None and str(p.get('currency','')).upper()=='ARS':block.append('Contado: '+_format(price))
            block.append('Con stock.')
        block.append(str(p.get('url','')))
        blocks.append('\n'.join(block))
    return '\n\n'.join(blocks)


def _child_reply(state,history,greeting):
    shown=any(CHILD_URL in _body(r) for r in history or [])
    if state['age'] and state['height']:
        blocks=['Podés ver toda la categoría de bicicletas infantiles acá:\n'+CHILD_URL]
        selected=[]
        try:
            candidates=[p for p in load_products()
                        if any('infantil' in words(str(c)) for c in p.get('categories',[]))
                        and product_kind(p)=='bicicleta']
            selected,_=_match(candidates,state)
            if selected:
                blocks.append('Estas son las opciones con stock de la categoría. La medida adecuada todavía debe confirmarse:')
                blocks.append(_render(selected,state,'').removeprefix('Te paso lo que encontré con stock:').lstrip())
        except Exception:
            blocks.append('No pude confirmar el stock del catálogo en este momento.')
        blocks.append('Un asesor debe continuar para confirmar la medida con la guía del modelo y ayudarte a elegir.')
        return _answer('\n\n'.join(blocks),selected,handoff=True,
                       reason='Continuar asesoramiento infantil; edad y altura en historial')
    reply='' if shown else greeting+'Podés ver las bicicletas infantiles acá:\n'+CHILD_URL+'\n\n'
    if not state['age']:reply+='¿Qué edad tiene quien la va a usar?'
    else:reply+='¿Cuánto mide? La edad sola no alcanza para confirmar el rodado.'
    return _answer(reply,reason='Categoría de bicicletas infantiles')


def _catalog_decision(text,history):
    if not text.strip():return None
    from .service_flow import service_decision
    service_result=service_decision(text,history)
    if service_result is not None:return service_result
    if is_service_question(text) or explicit_handoff(text) or is_combined_payment(text):return None
    child_state,child_action=_state(text,history,set(),[])
    if child_state is not None and child_action=='decline_more':
        return _answer('Dale, nos quedamos con las opciones que te mostré.',reason='El cliente no quiere más opciones')
    if child_state is not None and child_action=='horn_clarify':
        greeting='' if any(_role(r) in {'bot','assistant','agent','human'} for r in history or []) else '¡Hola! ¿Cómo estás? '
        return _answer(greeting+HORN_QUESTION,reason='Aclarar tipo de cuernitos')
    if child_state is not None and child_action=='child':
        greeting='' if any(_role(r) in {'bot','assistant','agent','human'} for r in history or []) else '¡Hola! ¿Cómo estás? '
        return _child_reply(child_state,history,greeting)
    # Loading a local snapshot is cached by the existing catalog layer; no network search here.
    try:products=load_products()
    except Exception:
        from .routing import PRODUCT_BRANDS
        tokens=words(text)
        if any(w in TYPES or w in SUBTYPES or w in PRODUCT_BRANDS for w in tokens):
            return _answer('No pude consultar un catálogo actualizado en este momento.',reason='Catálogo no disponible')
        return None
    brands=set(' '.join(words(p.get('brand',''))) for p in products if p.get('brand'))
    brands.update({'rudyproject','giro','rockshox'})
    types=set(TYPES)
    for p in products:
        for category in p.get('categories',[]):
            terms=meaningful(str(category))
            if len(terms)==1 and terms[0] not in brands and terms[0] not in SUBTYPES:
                types.add(_singular(terms[0]))
    state,action=_state(text,history,brands,products,types)
    if state is None:
        if action=='brand_without_context':return _answer('¿De qué producto querés ver otras marcas?')
        if re.fullmatch(r'(?:(?:en|busco)\s+)?(?:talle\s+)?(?:xxs|xs|s|m|l|xl|xxl)',normalize(text)):
            return _answer('¿Para qué producto buscás ese talle?')
        from .catalog_spelling import suggestions, QUESTION
        possible=suggestions(text,products)
        if len(possible)==1:
            return _answer(QUESTION.format(possible[0]['label']),reason='Confirmar escritura de producto en búsqueda')
        if possible:
            return _answer('Hay más de un nombre parecido. ¿Me pasás el nombre completo o el enlace del producto?',reason='Nombre de producto ambiguo')
        return None
    greeting='' if any(_role(r) in {'bot','assistant','agent','human'} for r in history or []) else '¡Hola! ¿Cómo estás? '
    if action=='child':return _child_reply(state,history,greeting)
    if state['invalid']:return _answer('No pude interpretar ese presupuesto con seguridad. ¿Entre qué importes en pesos querés buscar?')
    if state['kind'] in {'cubierta','camara'}:
        from .tire_context import tire_context,pending_question
        from .tire_filter import classify
        tire=tire_context(text,history)
        if not tire:return _answer('¿Qué medida figura en tu cubierta o cámara?')
        question=pending_question(tire)
        if question:return _answer(greeting+question)
        # Run measurement validation on the complete candidate set, never the first twelve hits.
        matching=[]
        base=dict(state,size=None,subtype=None,identity=[])
        exact,_=_match(products,base)
        for p in exact:
            status,_=classify(p,tire)
            if status=='match':matching.append(p)
        if not matching:return _answer('No pude confirmar una opción compatible con esa medida. Necesitamos que un asesor revise los datos.',handoff=True)
        return _answer(_render(matching[:3],state,greeting),matching[:3])
    if state['kind']=='bicicleta' and not state['subtype'] and not state['brands'] and not state['identity']:
        return _answer(greeting+'¿Buscás una bicicleta para montaña, ciudad, ruta, gravel o una infantil?')
    if action=='clarify_model':return _answer('¿Me indicás el nombre del modelo que te interesa?')
    if action=='clarify':return _answer('¿Qué talle buscás?' if not state['size'] else '¿Cuál de los modelos te interesa?')
    exact,partial=_match(products,state)
    # Relax ONLY the separately expressed feature, and only for an identified brand/model.
    use_partial=not exact and bool(partial) and bool(state['brands'] and state['identity'])
    matching=partial if use_partial else exact
    if not matching:
        from .catalog_spelling import suggestions, QUESTION
        possible=suggestions(text,products)
        if len(possible)==1:
            return _answer(QUESTION.format(possible[0]['label']),reason='Confirmar escritura de producto en búsqueda')
        if possible:
            return _answer('Hay más de un nombre parecido. ¿Me pasás el nombre completo o el enlace del producto?',reason='Nombre de producto ambiguo')
        return _answer('No pude confirmar una opción con stock que cumpla esos datos. Necesitamos que un agente revise si podemos conseguirla.',handoff=True)
    if action=='more':matching=[p for p in matching if str(p.get('url','')) not in state['seen']]
    if not matching:return _answer('Ya te mostré todas las opciones que pude confirmar con esos filtros. ¿Querés cambiar alguno?')
    selected=matching[:3]
    reply=_render(selected,state,greeting,action in {'more','other_brands'},use_partial)
    if not use_partial:
        if len(matching)>3:reply+='\n\nTengo más opciones con esos filtros. ¿Querés verlas?'
        elif state['kind'] in {'bicicleta','casco','calza','guante','zapatilla','jersey','campera','chaleco'} and not state['size'] and any(p.get('variations') for p in selected):reply+='\n\n¿Qué talle buscás?'
    return _answer(reply,selected,use_partial,reason='Características pendientes de confirmación' if use_partial else 'Filtros de catálogo verificados')


def catalog_decision(text,history,learning_config=None,conversation=None):
    from .handoff_contact import contact_followup
    contact=contact_followup(text,history,conversation)
    if contact is not None:return contact,[]
    from .query_spelling import normalize_query, normalize_history
    text=normalize_query(text)
    history=normalize_history(history)
    from .catalog_spelling import confirmed_search
    text,history,spelling_action=confirmed_search(text,history)
    if spelling_action in {'rejected','clarify'}:
        return _answer('¿Me pasás el nombre completo o el enlace del producto que buscás?',reason='Aclarar producto después de sugerencia')
    from .learning import active_config, clean, interpret, transform_history
    config=clean(active_config() if learning_config is None else learning_config)
    from .commercial_policy import commercial_decision
    commercial=commercial_decision(text,history,config.get('business'))
    if commercial is not None:return commercial
    from .order_flow import order_decision
    order_result=order_decision(text,history)
    if order_result is not None:return order_result
    from .shipping_flow import shipping_decision
    shipping_result=shipping_decision(text,history,config.get('business'))
    if shipping_result is not None:return shipping_result
    from .business_info import business_decision
    business_result=business_decision(text,history,config.get('business'))
    if business_result is not None:return business_result
    from .inquiry_flow import inquiry_decision
    inquiry_result=inquiry_decision(text,history,conversation,config.get('business'),load_products)
    if inquiry_result is not None:return inquiry_result
    interpreted,rule=interpret(text,config)
    if rule and rule['kind'] in {'ask','handoff'}:
        if rule['kind']=='ask':
            return _answer(rule['target'],reason='Pregunta aprobada en WooCommerce')
        return _answer('Necesitamos que un asesor revise tu consulta.',handoff=True,reason='Derivación aprobada en WooCommerce')
    result=_catalog_decision(interpreted,transform_history(history,config))
    if result is None and rule and rule['kind']=='search':
        return _answer('No pude resolver esa búsqueda con los datos disponibles. Necesitamos que un asesor la revise.',handoff=True)
    if result is None:
        from .commercial_policy import greeting_decision
        return greeting_decision(text)
    return result
