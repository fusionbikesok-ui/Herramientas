import os
import unittest
from unittest.mock import patch
import test_inbox as fixtures
from app import inbox

class ConnectionStatusTests(unittest.TestCase):
    setUpClass=classmethod(fixtures.DatabaseTests.setUpClass.__func__)
    tearDownClass=classmethod(fixtures.DatabaseTests.tearDownClass.__func__)
    setUp=fixtures.DatabaseTests.setUp
    incoming=fixtures.DatabaseTests.incoming
    def test_verified_connection_controls_pending_badge_independently(self):
        result=inbox.status(fixtures.ACTOR)
        first,second=result['numbers']
        self.assertTrue(first['connected'])
        self.assertFalse(first['coexistence_pending'])
        self.assertFalse(second['connected'])
        self.assertTrue(second['coexistence_pending'])
        self.assertFalse(first['bot_enabled'])
        with patch.dict(os.environ,INBOX_CONNECTED_NUMBER_IDS=''):
            result=inbox.status(fixtures.ACTOR)
            self.assertTrue(all(not n['connected'] and n['coexistence_pending'] for n in result['numbers']))
