"""Opaque API keys must not disclose the visitor's write-capable widget token."""
import json
import os
import unittest

import test_web_unified as unified
from app import inbox
from app.storage import connection


@unittest.skipUnless(os.getenv('INBOX_TEST_DATABASE_URL'),'Explicit isolated PostgreSQL URL required')
class WebAliasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): unified.WebUnifiedTests.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls): unified.WebUnifiedTests.tearDownClass.__func__(cls)
    setUp=unified.WebUnifiedTests.setUp
    incoming=unified.WebUnifiedTests.incoming
    payload=unified.WebUnifiedTests.payload
    row=unified.WebUnifiedTests.row
    public_key=unified.WebUnifiedTests.public_key
    call=unified.WebUnifiedTests.call

    def test_list_thread_command_never_expose_raw_widget_token(self):
        actor=unified.fixtures.ACTOR
        listing=inbox.handle({'op':'list','actor':actor,'channel':'web'})
        public=listing['threads'][0]['key']
        self.assertTrue(public.startswith('webthread:'))
        self.assertNotIn('unified-token',json.dumps(listing))
        detail=inbox.handle({'op':'thread','actor':actor,'key':public})
        taken=self.call('take')
        self.assertNotIn('unified-token',json.dumps(detail))
        self.assertNotIn('unified-token',json.dumps(taken))
        self.assertEqual(taken['thread']['key'],public)

    def test_raw_internal_key_and_guessed_alias_are_rejected(self):
        for key in (self.key,'webthread:bad-uuid','webthread:00000000-0000-0000-0000-000000000000'):
            with self.assertRaisesRegex(inbox.InboxError,'thread_not_found'):
                inbox.handle({'op':'thread','actor':unified.fixtures.READER,'key':key})
        with self.assertRaisesRegex(inbox.InboxError,'thread_not_found'):
            inbox.handle({'op':'command','actor':unified.fixtures.ACTOR,'key':self.key})

    def test_related_web_returns_only_same_opaque_key(self):
        with connection() as conn:
            conn.execute("UPDATE conversations SET customer_phone='3511234567' WHERE conversation_key=%s",(self.key,))
        result=inbox.handle({'op':'thread','actor':unified.fixtures.READER,'key':self.wa_key})
        self.assertEqual(result['related_web'][0]['key'],self.public_key())
        self.assertNotIn('unified-token',json.dumps(result))

    def test_alias_default_covers_legacy_insert_and_stays_stable(self):
        with connection() as conn:
            row=conn.execute("INSERT INTO conversations(conversation_key,channel,wp_token) VALUES('web:legacy-private-token','web','legacy-private-token') RETURNING *").fetchone()
        alias=inbox.public_thread_key(row)
        self.assertNotIn('legacy-private-token',alias)
        self.assertEqual(inbox.resolve_public_key(alias),'web:legacy-private-token')
        self.call('take');self.call('close');self.call('reopen')
        self.assertEqual(self.public_key(),inbox.public_thread_key(self.row()))


if __name__=='__main__':unittest.main()
