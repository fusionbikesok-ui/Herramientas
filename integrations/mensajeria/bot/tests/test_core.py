from __future__ import annotations

import hashlib
import hmac
import unittest

from app.routing import catalog_query, conversation_key, department_for, explicit_handoff, needs_catalog
from app.security import sign_fusion_payload, verify_fusion_request, verify_meta_signature


class SecurityTests(unittest.TestCase):
    def test_fusion_signature_round_trip(self) -> None:
        body = b'{"event_id":"abc"}'
        timestamp = "1000"
        signature = sign_fusion_payload("secret", timestamp, body)
        valid, reason = verify_fusion_request(
            expected_api_key="key",
            expected_secret="secret",
            supplied_api_key="key",
            supplied_timestamp=timestamp,
            supplied_signature=signature,
            body=body,
            now=1100,
        )
        self.assertTrue(valid)
        self.assertEqual(reason, "ok")

    def test_expired_signature_is_rejected(self) -> None:
        body = b"{}"
        signature = sign_fusion_payload("secret", "1000", body)
        valid, reason = verify_fusion_request(
            expected_api_key="key",
            expected_secret="secret",
            supplied_api_key="key",
            supplied_timestamp="1000",
            supplied_signature=signature,
            body=body,
            now=1401,
        )
        self.assertFalse(valid)
        self.assertEqual(reason, "expired_timestamp")

    def test_tampered_body_is_rejected(self) -> None:
        signature = sign_fusion_payload("secret", "1000", b"original")
        valid, reason = verify_fusion_request(
            expected_api_key="key",
            expected_secret="secret",
            supplied_api_key="key",
            supplied_timestamp="1000",
            supplied_signature=signature,
            body=b"changed",
            now=1000,
        )
        self.assertFalse(valid)
        self.assertEqual(reason, "invalid_signature")

    def test_meta_signature(self) -> None:
        body = b'{"object":"whatsapp_business_account"}'
        digest = hmac.new(b"meta-secret", body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_meta_signature("meta-secret", f"sha256={digest}", body))
        self.assertFalse(verify_meta_signature("meta-secret", "sha256=bad", body))


class RoutingTests(unittest.TestCase):
    def test_catalog_detection_and_query(self) -> None:
        text = "Hola, quiero una bicicleta Trek Marlin en cuotas"
        self.assertTrue(needs_catalog(text))
        self.assertEqual(catalog_query(text), "trek marlin")

    def test_handoff_detection(self) -> None:
        self.assertTrue(explicit_handoff("Quiero hablar con una persona"))
        self.assertTrue(explicit_handoff("Me rechazó el pago por fondos insuficientes"))
        self.assertFalse(explicit_handoff("¿Tenés una Polygon?"))

    def test_conversation_keys_are_channel_specific(self) -> None:
        self.assertEqual(conversation_key({"channel": "web", "token": "abc"}), "web:abc")
        self.assertEqual(
            conversation_key({"channel": "whatsapp", "channel_number_id": "10", "external_user_id": "549351"}),
            "whatsapp:10:549351",
        )

    def test_department_from_customer_intent(self) -> None:
        # Both channels share the inbox; the current router classifies content.
        self.assertEqual(department_for({"channel_label": "Ventas"}, "necesito un service"), "posventa_taller")
        self.assertEqual(department_for({"channel_label": "Posventa/Taller"}, "busco una bicicleta"), "ventas")


if __name__ == "__main__":
    unittest.main()
