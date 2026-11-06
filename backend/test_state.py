"""Offline encrypted storage tests. No live keys, network or user data."""
import tempfile
import time
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
            patch.object(state, "EXTRA_ACCOUNTS_PATH", d / "bybit-accounts.cred"),
            patch.object(state, "PROFILE_PATH", d / "user-data.json"),
            patch.object(state, "HISTORY_PATH", d / "pnl-history.json"),
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

    def test_multi_subaccounts_are_independent_encrypted_and_persistent(self):
        state.write_credentials("old-key-01234567", "old-secret-01234567", "Original")
        one = state.add_extra_account("sub-key-01234567", "sub-secret-01234567", "Sub 1")
        two = state.add_extra_account("sub-key-abcdef12", "sub-secret-abcdef12", "Sub 2")
        self.assertNotEqual(one["id"], two["id"])
        blob = state.EXTRA_ACCOUNTS_PATH.read_bytes()
        self.assertNotIn(b"sub-key-01234567", blob)
        self.assertNotIn(b"sub-secret-abcdef12", blob)
        self.assertEqual(state.EXTRA_ACCOUNTS_PATH.stat().st_mode & 0o777, 0o600)
        accounts = state.list_extra_accounts()
        self.assertEqual(len(accounts), 2)
        self.assertEqual(accounts[0]["key"], "sub-key-01234567")
        state.rename_extra_account(one["id"], "Renamed")
        self.assertEqual(state.list_extra_accounts()[0]["label"], "Renamed")
        state.delete_extra_account(one["id"])
        self.assertEqual([a["id"] for a in state.list_extra_accounts()], [two["id"]])
        self.assertEqual(state.read_credentials()["key"], "old-key-01234567")

    def test_multi_rejects_duplicate_key_and_bad_account_id(self):
        state.write_credentials("old-key-01234567", "old-secret-01234567", "Original")
        with self.assertRaisesRegex(state.StateError, "уже подключён"):
            state.add_extra_account("old-key-01234567", "another-secret-12345", "Duplicate")
        first = state.add_extra_account("sub-key-01234567", "sub-secret-01234567", "Sub 1")
        with self.assertRaisesRegex(state.StateError, "уже подключён"):
            state.add_extra_account("sub-key-01234567", "another-secret-12345", "Duplicate")
        with self.assertRaises(state.StateError):
            state.delete_extra_account("missing")
        with self.assertRaises(state.StateError):
            state.rename_extra_account("missing", "Other")
        self.assertEqual(state.list_extra_accounts()[0]["id"], first["id"])

    def test_account_icons_persist_encrypted_and_survive_rename(self):
        state.write_credentials("legacy-key-0123456", "legacy-secret-0123456", "Old")
        state.rename_credentials("13 ордеров 2 стоп-лосс", icon="trend")
        stored = state.read_credentials()
        self.assertEqual(stored["label"], "13 ордеров 2 стоп-лосс")
        self.assertEqual(stored["icon"], "trend")
        self.assertEqual(stored["key"], "legacy-key-0123456")
        self.assertNotIn(b"legacy-secret", state.CREDS_PATH.read_bytes())
        sub = state.add_extra_account("other-key-0123456", "other-secret-0123456",
                                      "Second", icon="bot")
        self.assertEqual(state.list_extra_accounts()[0]["icon"], "bot")
        state.rename_extra_account(sub["id"], "Second renamed", icon="shield")
        self.assertEqual(state.list_extra_accounts()[0]["icon"], "shield")
        with self.assertRaises(state.StateError):
            state.rename_extra_account(sub["id"], "Second renamed", icon="<script>")
        self.assertEqual(state.list_extra_accounts()[0]["icon"], "shield")
        self.assertEqual(state.read_credentials()["icon"], "trend")

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


    def test_rename_changes_label_and_keeps_the_same_secret(self):
        state.write_credentials("fake-key-0123456", "fake-secret-0123456", "Old name")
        before = state.CREDS_PATH.read_bytes()
        result = state.rename_credentials("New name")
        self.assertEqual(result["label"], "New name")
        saved = state.read_credentials()
        self.assertEqual(saved["label"], "New name")
        self.assertEqual(saved["key"], "fake-key-0123456")
        self.assertEqual(saved["secret"], "fake-secret-0123456")
        # A rename re-encrypts: the stored blob must change and stay unreadable.
        after = state.CREDS_PATH.read_bytes()
        self.assertNotEqual(before, after)
        self.assertNotIn(b"fake-key-0123456", after)
        self.assertNotIn(b"fake-secret-0123456", after)
        self.assertEqual(state.CREDS_PATH.stat().st_mode & 0o777, 0o600)

    def test_rename_requires_a_connected_key(self):
        with self.assertRaisesRegex(state.StateError, "не подключён"):
            state.rename_credentials("New name")

    def test_rename_rejects_empty_or_too_long_labels(self):
        state.write_credentials("fake-key-0123456", "fake-secret-0123456", "Old name")
        with self.assertRaises(state.StateError):
            state.rename_credentials("   ")
        with self.assertRaises(state.StateError):
            state.rename_credentials("x" * 41)
        self.assertEqual(state.read_credentials()["label"], "Old name")


    def test_history_merges_and_survives_a_restart(self):
        # Recent readings keep five-minute resolution, so three distinct
        # minutes stay three points across a process restart.
        base = (int(time.time() * 1000) - 3_600_000) // 300_000 * 300_000
        state.merge_history([{"t": base, "total": 1.5},
                             {"t": base + 300_000, "total": 2.5}])
        state.merge_history([{"t": base + 600_000, "total": 3.5}])
        points = state.read_history()["points"]
        self.assertEqual([p["total"] for p in points], [1.5, 2.5, 3.5])
        self.assertEqual(points, sorted(points, key=lambda p: p["t"]))

    def test_history_keeps_older_points_of_the_same_bucket(self):
        """A newer reading must not erase fields the older one carries alone."""
        base = 1_700_000_000_000
        now = base + 2000
        merged = state.compact_history([{"t": base, "spot": 10, "total": 20}],
                                       now_ms=now)
        merged = state.compact_history(merged + [{"t": base + 1000, "futures": 5}],
                                       now_ms=now)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["spot"], 10)
        self.assertEqual(merged[0]["total"], 20)
        self.assertEqual(merged[0]["futures"], 5)

    def test_history_compaction_uses_coarser_buckets_for_old_points(self):
        day = 86_400_000
        now = 1_700_000_000_000
        points = [{"t": now - 200 * day, "total": 1},
                  {"t": now - 200 * day + 60_000, "total": 2}]
        merged = state.compact_history(points, now_ms=now)
        self.assertEqual(len(merged), 1, "points a minute apart in an old bucket merge")

    def test_history_rejects_bad_payloads(self):
        with self.assertRaises(state.StateError):
            state.merge_history("not a list")
        with self.assertRaises(state.StateError):
            state.merge_history([{"t": "x"}])
        self.assertEqual(state.read_history()["points"], [])

    def test_history_keeps_only_finite_numbers(self):
        merged = state.compact_history([{"t": 1, "total": float("nan")},
                                        {"t": 2, "total": 1.25}])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["total"], 1.25)

    def test_history_file_is_private(self):
        state.merge_history([{"t": 1, "total": 1.0}])
        self.assertEqual(state.HISTORY_PATH.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    main()
