"""Web behavior stays on its current callback flow; WhatsApp uses inbox only."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import worker


class WebRegressionTests(unittest.TestCase):
    def setUp(self):
        flag = patch.object(worker,'get_system_setting',return_value=False)
        flag.start()
        self.addCleanup(flag.stop)

    def decision(self):
        return SimpleNamespace(reply='Respuesta web',contact_phone='',handoff=False,department='ventas',reason='',priority='normal')

    def test_web_reply_keeps_callback_and_persist(self):
        conversation={'channel':'web','token':'web-test'}
        with patch.object(worker,'_bot_is_active',return_value=True), patch.object(worker,'_decision_for',return_value=self.decision()), \
             patch.object(worker,'_callback',return_value={'ok':True}) as callback, patch.object(worker,'append_message') as append:
            worker._reply_web({'event_id':'web-event'},'web:web-test',conversation,{'text':'Hola'})
        callback.assert_called_once()
        self.assertEqual(callback.call_args.kwargs['event_type'],'bot_reply')
        self.assertEqual(callback.call_args.kwargs['message']['text'],'Respuesta web')
        append.assert_called_once()

    def test_web_human_control_still_skips_persist(self):
        with patch.object(worker,'_bot_is_active',return_value=True), patch.object(worker,'_decision_for',return_value=self.decision()), \
             patch.object(worker,'_callback',return_value={'skipped':'human_control'}), patch.object(worker,'append_message') as append:
            worker._reply_web({'event_id':'web-event'},'web:web-test',{'channel':'web'},{'text':'Hola'})
        append.assert_not_called()

    def test_web_store_and_deferred_flow_unchanged(self):
        payload={'event_id':'web-event','conversation':{'channel':'web'},'message':{'text':'Hola'}}
        with patch.object(worker,'_store_incoming',return_value=('web:test',payload['conversation'],payload['message'],'active',True)), \
             patch.object(worker,'_channel_bot_enabled',return_value=True), patch.object(worker,'_configured_delay',return_value=3), \
             patch.object(worker,'_defer_reply',return_value='scheduled') as defer, patch.object(worker,'_reply_web') as reply:
            self.assertEqual(worker.process_web_message(payload),'scheduled')
        defer.assert_called_once_with(payload,3); reply.assert_not_called()

    def test_existing_web_control_preserved_but_legacy_wa_cannot_override(self):
        with patch.object(worker,'upsert_conversation') as upsert, patch.object(worker,'set_bot_status') as status:
            worker.process_control({'conversation':{'channel':'web','token':'test'},'control':{'action':'take'}})
            status.assert_called_once_with('web:test','paused'); upsert.assert_called_once()
        with patch.object(worker,'upsert_conversation') as upsert, patch.object(worker,'set_bot_status') as status:
            worker.process_control({'conversation':{'channel':'whatsapp','channel_number_id':'111','external_user_id':'123'},'control':{'action':'release'}})
            upsert.assert_not_called(); status.assert_not_called()

    def test_whatsapp_historical_and_echo_never_invoke_ai(self):
        with patch('app.inbox_events.ingest',return_value=('whatsapp:111:123',False)), patch.object(worker,'_reply_whatsapp') as reply:
            self.assertEqual(worker.process_whatsapp_inbound({'historical':True}),'done')
        reply.assert_not_called()


if __name__=='__main__': unittest.main()
