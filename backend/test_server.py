"""Offline tests for FXMR4 Bybit subaccount: no real API credentials or network."""
import importlib.util
import json
import os
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fxmr4_server", Path(__file__).parent / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class TestReadOnlySubaccount(TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "BYBIT_SUBACCOUNT_KEY": "fake-test-api-key",
            "BYBIT_SUBACCOUNT_SECRET": "fake-test-api-secret",
            "BYBIT_SUBACCOUNT_LABEL": "Sub Test",
        })
        self.env.start()
        # Tests must never read real encrypted API credentials on a production VPS.
        self.disk = patch.object(server.saved_state, "read_credentials", return_value=None)
        self.disk.start()
        with server.LOCK:
            server.EPHEMERAL.update(key=None, secret=None, label="Subaccount")
            server.CACHE.update(at=0.0, data=None)

    def tearDown(self):
        self.disk.stop()
        self.env.stop()
        with server.LOCK:
            server.EPHEMERAL.update(key=None, secret=None, label="Subaccount")
            server.CACHE.update(at=0.0, data=None)

    def test_no_credentials_stored_in_snapshot(self):
        def bybit(path, params, key, secret):
            self.assertEqual(key, "fake-test-api-key")
            self.assertEqual(secret, "fake-test-api-secret")
            if path.endswith("query-api"):
                return {"readOnly": 1, "isMaster": False}
            if path.endswith("wallet-balance"):
                return {"list": [{"totalEquity": "1000.25", "totalWalletBalance": "980",
                                   "totalAvailableBalance": "600", "totalPerpUPL": "20.25"}]}
            if params.get("settleCoin") == "USDT":
                return {"list": [{"symbol": "BTCUSDT", "side": "Buy", "size": "0.01",
                                   "positionValue": "780", "avgPrice": "76000",
                                   "markPrice": "78000", "leverage": "5",
                                   "unrealisedPnl": "20.25", "positionIM": "18.75",
                                   "cumRealisedPnl": "5.55"}], "nextPageCursor": ""}
            return {"list": [], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=bybit):
            result = server.snapshot()
        self.assertEqual(result["totals"]["equity"], 1000.25)
        self.assertEqual(result["totals"]["perpUPL"], 20.25)
        self.assertEqual(result["totals"]["positionCount"], 1)
        self.assertEqual(result["account"]["name"], "Sub Test")
        self.assertEqual(result["positions"][0]["symbol"], "BTCUSDT")
        self.assertEqual(result["positions"][0]["initialMargin"], 18.75)
        self.assertEqual(result["positions"][0]["cumulativeRealisedPnl"], 5.55)
        dumped = json.dumps(result)
        self.assertNotIn("fake-test-api-key", dumped)
        self.assertNotIn("fake-test-api-secret", dumped)

    def test_readwrite_key_is_rejected(self):
        with patch.object(server, "request_bybit", return_value={"readOnly": 0, "isMaster": False}):
            with self.assertRaisesRegex(server.BybitFailure, "Read-Only"):
                server.snapshot()

    def test_master_key_is_rejected(self):
        with patch.object(server, "request_bybit", return_value={"readOnly": 1, "isMaster": True}):
            with self.assertRaisesRegex(server.BybitFailure, "субаккаунта"):
                server.snapshot()

    def test_empty_positions_not_invented(self):
        def bybit(path, params, key, secret):
            if path.endswith("query-api"):
                return {"readOnly": 1, "isMaster": False}
            if path.endswith("wallet-balance"):
                return {"list": [{"totalEquity": "", "totalWalletBalance": "0",
                                   "totalAvailableBalance": "", "totalPerpUPL": ""}]}
            return {"list": [], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=bybit):
            result = server.snapshot()
        self.assertIsNone(result["totals"]["equity"])
        self.assertIsNone(result["totals"]["availableBalance"])
        self.assertEqual(result["totals"]["positionCount"], 0)
        self.assertEqual(result["positions"], [])

    def test_ephemeral_key_preferred_to_environment(self):
        server.EPHEMERAL.update(key="temporary-api-key", secret="temporary-secret", label="Sub 2")
        self.assertEqual(server.credentials(), ("temporary-api-key", "temporary-secret", "Sub 2"))


    def test_rename_endpoint_requires_same_origin_header(self):
        """A rename is a write: it must carry the same-origin action header."""
        handler = object.__new__(server.Handler)
        handler.headers = {"X-FXMR4-Action": "", "Origin": "https://evil.example",
                           "Host": "fxmr4.example"}
        self.assertFalse(handler._same_origin_action())
        handler.headers = {"X-FXMR4-Action": "1", "Origin": "https://fxmr4.example",
                           "Host": "fxmr4.example"}
        self.assertTrue(handler._same_origin_action())


class TestHistorySampler(TestCase):
    """The server must keep the PNL series alive with no browser open."""

    def setUp(self):
        self.saved = []
        self.merge = patch.object(server.saved_state, "merge_history",
                                  side_effect=lambda pts: self.saved.append(pts[0]))
        self.merge.start()
        self.creds = patch.object(server, "credentials",
                                  return_value=("k", "s", "Sub"))
        self.creds.start()
        self.profile = patch.object(server.saved_state, "read_profile",
                                    return_value={"portfolio": {
                                        "trades": [{"coin": "BTC", "spent": 100, "entry": 50}],
                                        "quotes": {"BTC": {"price": 60}}}})
        self.profile.start()

    def tearDown(self):
        for p in (self.merge, self.creds, self.profile):
            p.stop()

    def _snapshot(self, perp_upl):
        return patch.object(server, "snapshot", return_value={
            "totals": {"perpUPL": perp_upl}})

    def test_records_spot_and_futures_separately(self):
        with self._snapshot(-3.5):
            self.assertTrue(server.sample_history_once())
        point = self.saved[0]
        self.assertAlmostEqual(point["spot"], 20.0)   # 100/50*60 - 100
        self.assertAlmostEqual(point["futures"], -3.5)
        self.assertAlmostEqual(point["total"], 16.5)

    def test_unknown_futures_is_absent_not_zero(self):
        with self._snapshot(None):
            self.assertTrue(server.sample_history_once())
        point = self.saved[0]
        self.assertIn("spot", point)
        self.assertNotIn("futures", point)
        self.assertNotIn("total", point)

    def test_no_credentials_writes_nothing(self):
        self.creds.stop()
        with patch.object(server, "credentials", return_value=(None, None, "Sub")):
            self.assertFalse(server.sample_history_once())
        self.assertEqual(self.saved, [])
        self.creds.start()

    def test_bybit_failure_does_not_raise(self):
        with patch.object(server, "snapshot", side_effect=server.BybitFailure("down")):
            self.assertFalse(server.sample_history_once())
        self.assertEqual(self.saved, [])

    def test_missing_quote_keeps_spot_unknown(self):
        self.profile.stop()
        with patch.object(server.saved_state, "read_profile",
                          return_value={"portfolio": {"trades": [{"coin": "BTC", "spent": 100,
                                                                  "entry": 50}],
                                                      "quotes": {}}}):
            with self._snapshot(-1.0):
                self.assertTrue(server.sample_history_once())
        point = self.saved[0]
        self.assertNotIn("spot", point)
        self.assertNotIn("total", point)
        self.assertAlmostEqual(point["futures"], -1.0)
        self.profile.start()


if __name__ == "__main__":
    main()
