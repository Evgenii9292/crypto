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
        self.extras = patch.object(server.saved_state, "list_extra_accounts", return_value=[])
        self.extras.start()
        with server.LOCK:
            server.EPHEMERAL.update(key=None, secret=None, label="Subaccount")
            server.CACHE.update(at=0.0, data=None)

    def tearDown(self):
        self.extras.stop()
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


    def test_account_listing_never_exposes_api_credentials(self):
        self.extras.stop()
        with patch.object(server.saved_state, "list_extra_accounts",
                          return_value=[{"id": "sub-test", "label": "Second",
                                         "key": "private-test-key", "secret": "private-test-secret"}]):
            data = server.linked_accounts()
        self.extras.start()
        self.assertEqual(len(data), 2)
        self.assertEqual(data[1]["id"], "sub-test")
        payload = json.dumps(data)
        self.assertNotIn("private-test-key", payload)
        self.assertNotIn("private-test-secret", payload)

    def test_second_subaccount_returns_only_its_own_positions(self):
        self.extras.stop()
        extra = {"id": "sub-test", "label": "Second", "key": "private-test-key", "secret": "private-test-secret"}
        def query(path, params, key, secret):
            self.assertEqual(key, "private-test-key")
            self.assertEqual(secret, "private-test-secret")
            if path.endswith("query-api"):
                return {"readOnly": 1, "isMaster": False}
            if path.endswith("wallet-balance"):
                return {"list": [{"totalEquity": "300", "totalPerpUPL": "-4"}]}
            if params.get("settleCoin") == "USDT":
                return {"list": [{"symbol": "ADAUSDT", "side": "Buy", "size": "5",
                                   "positionValue": "90", "createdTime": "1730000000000",
                                   "unrealisedPnl": "-4"}]}
            return {"list": []}
        try:
            with patch.object(server.saved_state, "list_extra_accounts", return_value=[extra]):
                with patch.object(server, "request_bybit", side_effect=query):
                    result = server.snapshot_extra("sub-test")
            self.assertEqual(result["account"]["id"], "sub-test")
            self.assertEqual(result["positions"][0]["accountId"], "sub-test")
            self.assertEqual(result["totals"]["equity"], 300)
            self.assertNotIn("private-test-secret", json.dumps(result))
        finally:
            self.extras.start()

    def test_rename_endpoint_requires_same_origin_header(self):
        """A rename is a write: it must carry the same-origin action header."""
        handler = object.__new__(server.Handler)
        handler.headers = {"X-FXMR4-Action": "", "Origin": "https://evil.example",
                           "Host": "fxmr4.example"}
        self.assertFalse(handler._same_origin_action())
        handler.headers = {"X-FXMR4-Action": "1", "Origin": "https://fxmr4.example",
                           "Host": "fxmr4.example"}
        self.assertTrue(handler._same_origin_action())


class TestAccountLevelPnl(TestCase):
    """Closing a position must move its loss to realised PNL, not erase it."""

    def test_closing_losing_position_does_not_create_fake_profit(self):
        before = {"totalPerpUPL": "-12",
                  "coin": [{"coin": "USDT", "cumRealisedPnl": "-3"}]}
        after = {"totalPerpUPL": "0",
                 "coin": [{"coin": "USDT", "cumRealisedPnl": "-15"}]}
        self.assertAlmostEqual(server.futures_pnl_totals(before)["accountPnl"], -15)
        self.assertAlmostEqual(server.futures_pnl_totals(after)["accountPnl"], -15)
        self.assertAlmostEqual(server.futures_pnl_totals(before)["realisedPnl"], -3)
        self.assertAlmostEqual(server.futures_pnl_totals(after)["realisedPnl"], -15)

    def test_wallet_cumulative_is_not_sum_of_only_open_position_pnl(self):
        account = {"totalPerpUPL": "2.5",
                   "coin": [{"coin": "USDT", "cumRealisedPnl": "-25.75"},
                            {"coin": "USDC", "cumRealisedPnl": "3.25"}]}
        result = server.futures_pnl_totals(account)
        self.assertAlmostEqual(result["realisedPnl"], -22.5)
        self.assertAlmostEqual(result["accountPnl"], -20.0)

    def test_missing_realised_must_not_fallback_to_floating(self):
        account = {"totalPerpUPL": "8.1"}
        result = server.futures_pnl_totals(account)
        self.assertIsNone(result["realisedPnl"])
        self.assertIsNone(result["accountPnl"])

    def test_inverse_non_usd_realised_must_not_be_added_as_dollars(self):
        account = {"totalPerpUPL": "2",
                   "coin": [{"coin": "USDT", "cumRealisedPnl": "-5"},
                            {"coin": "BTC", "cumRealisedPnl": "0.1"}]}
        self.assertIsNone(server.futures_pnl_totals(account)["accountPnl"])


class TestPositionOpenTime(TestCase):
    """Sorting by open date needs the venue's own timestamp, not a guess."""

    def test_created_time_is_kept_as_milliseconds(self):
        self.assertEqual(server._int_ms("1700000000000"), 1700000000000)
        self.assertEqual(server._int_ms(1700000000000), 1700000000000)

    def test_missing_or_bad_open_time_is_unknown(self):
        for value in (None, "", "abc", 0, -5):
            self.assertIsNone(server._int_ms(value), value)


class TestHistorySampler(TestCase):
    """The VPS samples current BTC/ETH prices and API futures while browser is closed."""

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
                                        "quotes": {"BTC": {"price": 999}}}})
        self.profile.start()
        self.extras = patch.object(server.saved_state, "list_extra_accounts", return_value=[])
        self.extras.start()
        self.quotes = patch.object(server, "public_spot_quotes",
                                   return_value={"BTC": {"price": 60}})
        self.quotes.start()

    def tearDown(self):
        for p in (self.merge, self.creds, self.profile, self.extras, self.quotes):
            p.stop()

    def _snapshot(self, perp_upl):
        return patch.object(server, "snapshot", return_value={
            "totals": {"perpUPL": perp_upl}})

    def test_server_writes_account_pnl_separately_from_floating(self):
        with patch.object(server, "snapshot", return_value={"totals": {
                "perpUPL": "0", "accountPnl": "-15", "realisedPnl": "-15"}}):
            self.assertTrue(server.sample_history_once())
        point = self.saved[0]
        self.assertAlmostEqual(point["futures"], 0)
        self.assertAlmostEqual(point["futuresAccount"], -15)
        self.assertAlmostEqual(point["totalAccount"], 5)
        self.assertAlmostEqual(point["total"], 20)

    def test_uses_live_server_price_not_stale_browser_quote(self):
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

    def test_spot_keeps_collecting_when_no_api_key_is_connected(self):
        self.creds.stop()
        with patch.object(server, "credentials", return_value=(None, None, "Sub")):
            self.assertTrue(server.sample_history_once())
        self.assertIn("spot", self.saved[0])
        self.assertNotIn("futures", self.saved[0])
        self.creds.start()

    def test_bybit_private_failure_keeps_spot_history_without_fake_total(self):
        with patch.object(server, "snapshot", side_effect=server.BybitFailure("down")):
            self.assertTrue(server.sample_history_once())
        self.assertIn("spot", self.saved[0])
        self.assertNotIn("total", self.saved[0])
        self.assertNotIn("futures", self.saved[0])

    def test_unavailable_live_quote_never_uses_stale_browser_quote(self):
        self.quotes.stop()
        with patch.object(server, "public_spot_quotes", side_effect=server.BybitFailure("no tickers")):
            with self._snapshot(-1.0):
                self.assertTrue(server.sample_history_once())
        point = self.saved[0]
        self.assertNotIn("spot", point)
        self.assertNotIn("total", point)
        self.assertAlmostEqual(point["futures"], -1.0)
        self.quotes.start()

    def test_background_spot_uses_different_prices_at_successive_intervals(self):
        with self._snapshot(-2):
            with patch.object(server, "public_spot_quotes",
                              side_effect=[{"BTC": {"price": 60}}, {"BTC": {"price": 55}}]):
                self.assertTrue(server.sample_history_once())
                self.assertTrue(server.sample_history_once())
        self.assertAlmostEqual(self.saved[0]["spot"], 20)
        self.assertAlmostEqual(self.saved[1]["spot"], 10)
        self.assertNotEqual(self.saved[0]["total"], self.saved[1]["total"])

    def test_public_bybit_spot_quotes_do_not_send_secret(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, limit):
                return b'{"retCode":0,"result":{"list":[{"lastPrice":"76321.25"}]}}'
        visited = []
        def stub(request, timeout):
            visited.append(request)
            return Response()
        self.quotes.stop()
        try:
            with patch.object(server, "urlopen", side_effect=stub):
                quotes = server.public_spot_quotes([{"coin": "BTC"}])
        finally:
            self.quotes.start()
        self.assertAlmostEqual(quotes["BTC"]["price"], 76321.25)
        self.assertIn("/v5/market/tickers?", visited[0].full_url)
        self.assertNotIn("X-BAPI-API-KEY", dict(visited[0].header_items()))


if __name__ == "__main__":
    main()
