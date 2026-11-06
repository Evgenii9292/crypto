import unittest
from unittest.mock import patch

from test_server import server


class TestClosedTrades(unittest.TestCase):
    def setUp(self):
        server.TRADES_CACHE.update(at=0, identity=None, data=None)
        self.credentials = patch.object(server, "credentials", return_value=("fake-key", "fake-secret", "Test"))
        self.credentials.start()
        self.clock = patch.object(server.time, "time", return_value=1793966400)
        self.clock.start()

    def tearDown(self):
        self.credentials.stop()
        self.clock.stop()
        server.TRADES_CACHE.update(at=0, identity=None, data=None)

    def record(self, params, **fields):
        return {"orderId": "test-order", "symbol": "XMRUSDT", "side": "Sell",
                "updatedTime": str(params["endTime"]), "closedPnl": "4.20",
                "avgEntryPrice": "600", "avgExitPrice": "610", "execType": "Trade", **fields}

    def test_month_windows_all_pages_dedup_and_unknown_fees(self):
        windows = []

        def request(path, params, key, secret):
            if path.endswith("query-api"):
                return {"readOnly": 1, "isMaster": False}
            self.assertEqual(path, "/v5/position/closed-pnl")
            self.assertLessEqual(params["endTime"] - params["startTime"], 7 * 86_400_000)
            if not params.get("cursor"):
                windows.append((params["startTime"], params["endTime"]))
            if len(windows) == 1:
                return {"list": [self.record(params)],
                        "nextPageCursor": "page2" if not params.get("cursor") else ""}
            return {"list": [], "nextPageCursor": ""}

        with patch.object(server, "request_bybit", side_effect=request) as api:
            data = server.closed_trades()
            requests = api.call_count
            self.assertEqual(server.closed_trades(), data)
            self.assertEqual(api.call_count, requests)
        self.assertEqual(len(windows), 5)
        for previous, following in zip(windows, windows[1:]):
            self.assertEqual(previous[1] + 1, following[0])
        self.assertEqual(windows[0][0], data["from"])
        self.assertEqual(windows[-1][1], data["to"])
        self.assertTrue(data["complete"])
        self.assertEqual(len(data["trades"]), 1)
        self.assertEqual(data["trades"][0]["pnl"], 4.2)
        self.assertIsNone(data["trades"][0]["openFee"])
        self.assertEqual(data["trades"][0]["side"], "Long")

    def test_cursor_loop_is_not_complete_history(self):
        def request(path, params, *args):
            if path.endswith("query-api"):
                return {"readOnly": 1}
            return {"list": [], "nextPageCursor": "same-page"}
        with patch.object(server, "request_bybit", side_effect=request):
            with self.assertRaisesRegex(server.BybitFailure, "повторил"):
                server.closed_trades()
        self.assertIsNone(server.TRADES_CACHE["data"])

    def test_missing_timestamp_is_rejected(self):
        def request(path, params, *args):
            return {"readOnly": 1} if path.endswith("query-api") else {
                "list": [self.record(params, updatedTime="")], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=request):
            with self.assertRaisesRegex(server.BybitFailure, "Неполные"):
                server.closed_trades()

    def test_different_account_never_receives_cached_history(self):
        def request(path, params, *args):
            return {"readOnly": 1} if path.endswith("query-api") else {"list": [], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=request) as api:
            server.closed_trades()
            requests = api.call_count
            with patch.object(server, "credentials", return_value=("another-key", "another-secret", "Other")):
                data = server.closed_trades()
            self.assertGreater(api.call_count, requests)
            self.assertEqual(data["account"]["name"], "Other")

    def test_failure_does_not_turn_into_empty_success(self):
        def request(path, params, *args):
            if path.endswith("query-api"):
                return {"readOnly": 1}
            raise server.BybitFailure("API unavailable")
        with patch.object(server, "request_bybit", side_effect=request):
            with self.assertRaisesRegex(server.BybitFailure, "unavailable"):
                server.closed_trades()
        self.assertIsNone(server.TRADES_CACHE["data"])


if __name__ == "__main__":
    unittest.main()
