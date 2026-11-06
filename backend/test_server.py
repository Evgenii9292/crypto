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
        with server.LOCK:
            server.EPHEMERAL.update(key=None, secret=None, label="Subaccount")
            server.CACHE.update(at=0.0, data=None)

    def tearDown(self):
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


if __name__ == "__main__":
    main()
