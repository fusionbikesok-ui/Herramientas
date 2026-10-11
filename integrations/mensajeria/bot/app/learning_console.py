from .learning import get_state, mutate, fingerprint, interpret, clean, canonical

CAPABILITIES={'business_info':1,'shipping_queries':1,'order_tracking':1,'credit_card_policy':1,'catalog_spelling':1}

def handle(operation,payload):
    if operation=='get':return {'ok':True,'capabilities':CAPABILITIES,'state':get_state()}
    if operation in {'save','publish','restore'}:return {'ok':True,'capabilities':CAPABILITIES,'state':mutate(operation,payload)}
    if operation!='test':raise ValueError('Acción desconocida.')
    from .catalog_flow import catalog_decision
    from .routing import normalize_conversation_history
    state=get_state()
    if payload.get('revision')!=state['revision']:raise ValueError('Recargá el borrador antes de probar.')
    text=str(payload.get('message') or '').strip()
    if not text or len(text)>2500:raise ValueError('Escribí una consulta de hasta 2500 caracteres.')
    history=normalize_conversation_history(payload.get('history'),40)
    config=clean(state['draft'])
    conversation=payload.get('conversation') if isinstance(payload.get('conversation'),dict) else {}
    result=catalog_decision(text,history,learning_config=config,conversation=conversation)
    interpreted,rule=interpret(text,config)
    if result is not None and result[0].reason=='Información del negocio verificada':
        interpreted=text;rule=None
    if result is None:
        reply='Esta consulta no activó un flujo de catálogo ni una corrección. En el chat continúa por la atención general.'
        products=[];handoff=False
    else:
        from .handoff_contact import finalize_handoff
        decision,products=result
        decision=finalize_handoff(decision,text,history,conversation)
        reply=decision.reply;handoff=decision.handoff
    # Each enabled rule keeps a reproducible example. Manual review is still needed for prose.
    from .business_info import business_decision
    checks=[]
    for r in config['rules']:
        if not r['enabled']:continue
        sample=r['example'] or r['source']
        if business_decision(sample,[],config.get('business')) is not None:
            checks.append({'id':r['id'],'ok':True,'message':'Usa Información del negocio; esta corrección queda en segundo plano'})
            continue
        rewritten,matched=interpret(sample,config)
        activated=matched is not None and matched['id']==r['id'] if r['kind']!='alias' else (' '+canonical(r['source'])+' ') in (' '+canonical(sample)+' ') and canonical(r['target']) in canonical(rewritten)
        checks.append({'id':r['id'],'ok':bool(activated),'message':'Activa la corrección' if activated else 'El ejemplo no activa esta corrección'})
    passed=all(c['ok'] for c in checks)
    if passed:
        state=mutate('tested',dict(revision=state['revision'],fingerprint=fingerprint(config)))
    return {'ok':True,'capabilities':CAPABILITIES,'state':state,'preview':{'reply':reply,'interpreted':interpreted,'reference':rule.get('expected','') if rule else '', 'handoff':handoff,'products_used':len(products),'response_source':decision.reason if result is not None else 'Atención general'},'checks':checks,'passed':passed}
