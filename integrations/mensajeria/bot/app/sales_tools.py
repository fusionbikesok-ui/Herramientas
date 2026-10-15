"""Read-only sales tools. The model cannot set prices, recipient identity or URLs."""
import copy,json,re
from .catalog_source import load_products
from .catalog_stock import available_product
from .catalog_words import words
from .commercial_prices import hydrate
from .ai import BotDecision

def schema(name,description,properties):
    return {'type':'function','name':name,'description':description,'strict':True,'parameters':{'type':'object','properties':properties,'required':list(properties),'additionalProperties':False}}

TOOLS=[
 schema('buscar_productos','Busca catálogo local actualizado. Usá marca/modelo/tipo, no frases completas. Corrige Benzo a Venzo según confirmación. Conservá el talle/color del diálogo; en ausencia de preferencia usá cadenas vacías.',{'query':{'type':'string'},'size':{'type':'string'},'color':{'type':'string'}}),
 schema('ficha_producto','Ficha publicada de uno de los productos ya encontrados. Incluye precios vigentes de la web y cuotas. No datos de Mercado Libre.',{'product_id':{'type':'integer'}}),
 schema('condiciones','Consulta condiciones oficiales: pagos, cuotas, envío, ubicación, horarios, CBU o taller. Incluir el producto seleccionado y la pregunta completa.',{'question':{'type':'string'}}),
 schema('posventa','Recupera factura o seguimiento existentes, verificando pedido y teléfono del remitente en el servidor. Nunca emite facturas. Pedido vacío si el cliente no lo dio.',{'purpose':{'type':'string','enum':['factura','seguimiento']},'order_id':{'type':'string'}}),
]

class Tools:
    def __init__(self,text,history,conversation,key):
        self.text=text;self.history=history;self.conversation=conversation;self.key=key
        self.products={};self.responses={};self.final=None;self.sequence=0
    def remember(self,result,decision=None):
        self.sequence+=1;reference='fuente_'+str(self.sequence)
        self.responses[reference]=decision
        return {'source':reference,**result}
    def execute(self,name,args):
        if not isinstance(args,dict):raise ValueError('invalid_tool_arguments')
        if name=='buscar_productos':return self.search(args)
        if name=='ficha_producto':return self.details(args)
        if name=='condiciones':return self.conditions(args)
        if name=='posventa':return self.after_sale(args)
        raise ValueError('unknown_tool')
    def search(self,args):
        query=str(args.get('query',''))[:180];size=str(args.get('size','')).upper().strip()[:12];color=str(args.get('color',''))[:50]
        if size and not re.fullmatch(r'XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{2}',size):raise ValueError('invalid_size')
        from .catalog_words import NOISE
        terms=[w for w in words(query) if w not in NOISE]
        if not terms:return {'error':'Falta indicar tipo de producto, marca o modelo.'}
        matches=[]
        for source in load_products():
            name=words(source.get('name',''))
            if not all(w in name or (len(w)>4 and w.rstrip('s') in name) for w in terms):continue
            p=available_product(source)
            if p is None:continue
            if size or color:
                if p.get('variations'):
                    variations=[]
                    for v in p['variations']:
                        a=v.get('attributes') or {};s=str(a.get('attribute_pa_talle') or a.get('attribute_talle') or a.get('size') or '').upper()
                        c=' '.join(str(a.get(k) or '') for k in ['attribute_pa_color','attribute_color','color'])
                        if (not size or s==size) and (not color or all(w in words(c) for w in words(color))):variations.append(v)
                    if not variations:continue
                    p=dict(p,variations=variations)
                else:
                    a=p.get('attributes') or {}
                    if size and str(a.get('attribute_pa_talle') or a.get('size') or '').upper()!=size:continue
                    if color and not all(w in words(a.get('attribute_pa_color','')) for w in words(color)):continue
            matches.append(p)
        matches.sort(key=lambda p:(len(words(p['name'])),p['id']))
        selected=hydrate(matches[:6],limit=75)
        for p in selected:self.products[p['id']]=p
        return self.remember({'products':[self.compact(p) for p in selected],'more':len(matches)>6,'query':query,'size':size,'color':color,'notice':'Sólo coincidencias verificadas con stock. Si no hay resultados, reformulá marca/modelo o preguntá; no concluyas que la tienda no lo vende.'})
    def compact(self,p):
        return {'id':p['id'],'name':p['name'],'url':p['url'],'cash_price':p.get('cash_price') or None,'payment_options':p.get('payment_options') or [],'free_shipping':p.get('free_shipping') is True,
            'variants':[{'id':v['id'],'attributes':v.get('attributes') or {},'cash_price':v.get('display_price') or None} for v in (p.get('variations') or [])[:20]]}
    def details(self,args):
        pid=args.get('product_id')
        if type(pid) is not int or pid not in self.products:return {'error':'Buscá primero el producto en el catálogo.'}
        from .product_description import fetch_product_description
        try:detail=fetch_product_description(pid)
        except Exception:detail=None
        return self.remember({'product':self.compact(self.products[pid]),'description':str((detail or {}).get('description') or '')[:5000],'notice':'Si falta un dato técnico, preguntá o ofrecé asesor. No deduzcas compatibilidad o ajuste exacto.'})
    def conditions(self,args):
        question=str(args.get('question',''))[:500]
        from .learning import active_config,clean
        from .payment_answers import payment_decision
        from .business_info import business_decision
        from .shipping_flow import shipping_decision
        from .commercial_policy import commercial_decision
        business=clean(active_config()).get('business') or {}
        decision=payment_decision(question,self.history,self.conversation,business,load_products)
        if decision is None:
            for fn in [business_decision,shipping_decision,commercial_decision]:
                found=fn(question,self.history,business)
                if found is not None:decision=found[0];break
        if decision is None:return {'error':'Esa condición necesita confirmación de un asesor.'}
        return self.remember({'answer':decision.reply,'handoff':decision.handoff},decision)
    def after_sale(self,args):
        purpose=args.get('purpose');order=str(args.get('order_id',''))
        if purpose not in ['factura','seguimiento'] or not re.fullmatch(r'\d{0,12}',order):raise ValueError('invalid_order')
        # An LLM cannot invent/select another order: it must occur in customer text.
        customer=' '.join(str(r.get('body','')) for r in self.history if r.get('sender')=='customer')+' '+self.text
        if order and not re.search(r'(?<!\d)'+re.escape(order)+r'(?!\d)',customer):return {'error':'Pedile al cliente su número de pedido.'}
        from .invoice_flow import invoice_decision
        from .tracking_flow import tracking_decision
        fn=invoice_decision if purpose=='factura' else tracking_decision
        decision=fn(('Necesito la factura de mi compra' if purpose=='factura' else 'Necesito el seguimiento del envío de mi compra')+(' pedido '+order if order else ''),self.history,self.conversation,self.key)
        if decision is not None:self.final=decision
        return {'notice':'La respuesta verificada de posventa se entrega directamente.'}

    def render(self,answer):
        """Commercial source blocks are copied verbatim, not rewritten by the model."""
        if self.final is not None:return self.final
        ids=answer.get('product_ids') or [];refs=answer.get('sources') or []
        if not isinstance(ids,list) or len(ids)>3 or any(type(i) is not int or i not in self.products for i in ids):raise ValueError('ungrounded_product')
        if not isinstance(refs,list) or len(refs)>2 or any(r not in self.responses or self.responses[r] is None for r in refs):raise ValueError('ungrounded_source')
        message=str(answer.get('message') or '').strip()
        followup=str(answer.get('followup') or '').strip()
        # Financial data and links only enter through verified server blocks.
        from .routing import normalize
        claim=message+' '+followup
        forbidden=bool(re.search(r'https?://|www\.|\$|\b(?:ars|pesos|cbu|cvu|alias)\b',claim,re.I) or re.search(r'\b(?:precio|contado|cuotas?|transferencia|tarjetas?|envios?|entrega|descuentos?|promociones?|garantia|stock|disponibles?)\b',normalize(claim)))
        if len(claim)>1200 or forbidden:raise ValueError('ungrounded_commercial_text')
        blocks=[message] if message else []
        if ids:
            from .catalog_flow import _render
            cards=_render([self.products[i] for i in dict.fromkeys(ids)],{'bounds':None,'size':None,'kind':None},'')
            if message:cards=cards.partition('\n\n')[2] or cards
            blocks.append(cards)
        decisions=[self.responses[r] for r in dict.fromkeys(refs)]
        blocks.extend(d.reply for d in decisions)
        if followup:blocks.append(followup)
        handoff=answer.get('handoff') is True or any(d.handoff for d in decisions)
        text='\n\n'.join(blocks)
        if not text or len(text)>3900:raise ValueError('reply_too_long')
        return BotDecision(text,handoff,'posventa_taller' if answer.get('department')=='posventa_taller' else 'ventas','OpenAI con fuentes verificadas','normal')
