from pathlib import Path
import json,subprocess
repo=Path('/opt/fusionbikes/herramientas');root=Path('/opt/fusion-management-migration');dest=repo/'integrations/management-migration'
r=subprocess.run(['node','--test','ranking.test.cjs'],cwd=dest,capture_output=True,text=True,timeout=60)
report='\n'.join(s for s in r.stdout.splitlines() if s.startswith(('ℹ tests','ℹ pass','ℹ fail','ℹ skipped')))
print('Ranking separado (fuera del cambio fiscal):\n'+report)
note='\n\nVerificación ampliada del 2026-10-05: suite aislada de Gestión 44 aprobadas, 8 fallos y 1 omitida; los 8 fallos pertenecen a ranking.test.cjs (funciones de agrupación/fechas no exportadas), reproducidos al correr ese archivo solo. No se modificaron ranking ni métricas durante el corte ARCA; no afirmar suite global verde. Las 15 pruebas de gateway/catálogo/transporte fiscal y las pruebas nativas ARCA sí pasan. UI WSFE/Padrón y apertura real de PDF histórico verificadas; recepción idempotente del comprobante manual 11 sin pedido ni nuevas facturas aceptada en origen. Captura de escritorio sin desborde; el override de viewport del navegador no cambió su ancho efectivo de 1265px, por lo que no se afirma nueva prueba móvil.\n'
for path in [dest/'arca/README-ARCA.md',repo/'docs/memory/modules/operations-vps.md']:
 old=path.read_text()
 if 'Verificación ampliada del 2026-10-05' not in old:path.write_text(old.rstrip()+note)
release=json.loads((root/'arca-cutover-release.json').read_text());release['verification']={'draft_native_checks':11,'mirror_native_checks':51,'fiscal_transport_catalog_checks':15,'bridge_checks':28,'live_pdf_opened':True,'live_wsfe_padron_ui':True,'source_idempotent_receipt':True,'new_tax_invoices_during_tests':0,'unrelated_ranking_suite_failures':8}
(root/'arca-cutover-release.json').write_text(json.dumps(release,indent=2))
backups=list((root/'backups/fiscal-daily').glob('*.tar.gz'));assert backups
print(json.dumps({'backup_archives':len(backups),'backup_private':all(p.stat().st_mode&0o077==0 for p in backups),'backup_timer':subprocess.check_output(['systemctl','is-active','fusion-arca-backup.timer'],text=True).strip(),'outbox_timer':subprocess.check_output(['systemctl','is-active','fusion-arca-outbox.timer'],text=True).strip()}))
