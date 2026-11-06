"""Offline encrypted storage tests. No live keys, network or user data."""
import tempfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import state


class TestEncryptedVpsStorage(TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        d = Path(self.folder.name)
        self.patches = [
            patch.object(state, "DATA_DIR", d),
            patch.object(state, "CREDS_PATH", d / "bybit.cred"),
            patch.object(state, "PROFILE_PATH", d / "user-data.json"),
            patch.object(state, "SEAL_KEY_HEX", "de" * 32),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.folder.cleanup()

    def test_credentials_are_encrypted_and_persist(self):
        state.write_credentials("fake-key-0123456", "fake-secret-0123456", "Sub A")
        blob = state.CREDS_PATH.read_bytes()
        self.assertNotIn(b"fake-key-0123456", blob)
        self.assertNotIn(b"fake-secret-0123456", blob)
        self.assertTrue(blob.startswith(b"FXMR4v1:"))
        self.assertEqual(state.CREDS_PATH.stat().st_mode & 0o777, 0o600)
        self.assertEqual(state.read_credentials()["key"], "fake-key-0123456")
        self.assertEqual(state.read_credentials()["label"], "Sub A")
        # A second read does not depend on process-global EPHEMERAL data.
        self.assertEqual(state.read_credentials()["secret"], "fake-secret-0123456")

    def test_wrong_encryption_key_rejects_data(self):
        state.write_credentials("fake-key-0123456", "fake-secret-0123456", "Sub A")
        with patch.object(state, "SEAL_KEY_HEX", "ab" * 32):
            with self.assertRaisesRegex(state.StateError, "расшифровать"):
                state.read_credentials()

    def test_disconnect_removes_file(self):
        state.write_credentials("fake-key-0123456", "fake-secret-0123456", "Sub A")
        state.delete_credentials()
        self.assertIsNone(state.read_credentials())

    def test_portfolio_save_and_reload(self):
        portfolio = {"capital": 1000, "trades": [{"coin": "BTC", "spent": 25, "entry": 76200}]}
        levels = {"levels": {"BTC": [{"id": "btc-75000", "price": 75000}]}}
        saved = state.write_profile(0, portfolio, levels)
        self.assertEqual(saved["revision"], 1)
        data = state.read_profile()
        self.assertEqual(data["portfolio"], portfolio)
        self.assertEqual(data["levels"], levels)
        self.assertTrue(data["exists"])
        self.assertEqual(state.PROFILE_PATH.stat().st_mode & 0o777, 0o600)

    def test_conflicting_revision_is_blocked(self):
        state.write_profile(0, {"capital": 1000}, {"levels": {}})
        with self.assertRaisesRegex(state.StateError, "CONFLICT"):
            state.write_profile(0, {"capital": 5000}, {"levels": {}})
        self.assertEqual(state.read_profile()["portfolio"]["capital"], 1000)

    def test_secrets_rejected_from_portfolio(self):
        with self.assertRaisesRegex(state.StateError, "Секреты"):
            state.write_profile(0, {"password": "should-not-save"}, {})


if __name__ == "__main__":
    main()
