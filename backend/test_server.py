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


    def test_current_position_open_time_never_uses_first_symbol_creation(self):
        payload = {"list": [{"symbol": "XMRUSDT", "side": "Buy",
                             "size": "4", "positionValue": "91.72",
                             "createdTime": "1600000000000",
                             "openTime": "1762000000000"}]}
        with patch.object(server, "request_bybit", return_value=payload):
            rows = server.collect_positions("mock-key", "mock-secret", "USDT")
        self.assertEqual(rows[0]["openedAt"], 1762000000000)
        payload["list"][0]["openTime"] = "0"
        with patch.object(server, "request_bybit", return_value=payload):
            rows = server.collect_positions("mock-key", "mock-secret", "USDT")
        self.assertIsNone(rows[0]["openedAt"])


class TestMonthlyLedger(TestCase):
    """UTC futures cash movements excluding transfers, not historical UPL guesses."""

    def setUp(self):
        server.MONTH_CACHE.clear()

    def test_rolling_month_counts_trades_funding_fees_with_real_pagination_windows(self):
        end = 1762473600000
        start = end - server.PERFORMANCE_MS
        calls = []

        def bybit(path, params, key, secret):
            self.assertEqual(path, "/v5/account/transaction-log")
            self.assertEqual(params["category"], "linear")
            self.assertEqual(params["accountType"], "UNIFIED")
            left = int(params["startTime"])
            self.assertLessEqual(int(params["endTime"]) - left, 7 * 86400000)
            calls.append(left)
            stamp = str(left + 1000)
            if left == start:
                rows = [{"category": "linear", "currency": "USDT", "type": "TRADE",
                         "transactionTime": stamp, "cashFlow": "-4",
                         "funding": "", "fee": "0.25"}]
            elif left == start + server.LEDGER_WINDOW_MS:
                rows = [{"category": "linear", "currency": "USDT", "type": "SETTLEMENT",
                         "transactionTime": stamp, "cashFlow": "0",
                         "funding": "0.5", "fee": "0"}]
            else:
                rows = [{"category": "linear", "currency": "USDT", "type": "TRANSFER_IN",
                         "transactionTime": stamp, "cashFlow": "10000",
                         "funding": "", "fee": ""}]
            return {"list": rows, "nextPageCursor": ""}

        with patch.object(server, "request_bybit", side_effect=bybit):
            report = server.monthly_futures_activity("mock-key", "mock-secret", end_ms=end)
        self.assertEqual(len(calls), 5)
        self.assertAlmostEqual(report["tradingPnl"], -4)
        self.assertAlmostEqual(report["funding"], 0.5)
        self.assertAlmostEqual(report["fees"], 0.25)
        self.assertAlmostEqual(report["netPnl"], -3.75)
        self.assertFalse(report["includesUnrealised"])
        self.assertEqual(len(report["days"]), 2)

    def test_unknown_derivatives_activity_is_not_silently_called_zero_pnl(self):
        def bybit(path, params, key, secret):
            return {"list": [{"category": "linear", "currency": "USDT",
                              "type": "UNKNOWN_TRADE", "transactionTime": params["startTime"],
                              "cashFlow": "-1"}], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=bybit):
            with self.assertRaisesRegex(server.BybitFailure, "Неизвестный тип"):
                server.monthly_futures_activity("k", "s", end_ms=1762473600000)

    def test_repeating_cursor_fails_instead_of_incomplete_month(self):
        def bybit(path, params, key, secret):
            return {"list": [], "nextPageCursor": "repeated"}
        with patch.object(server, "request_bybit", side_effect=bybit):
            with self.assertRaisesRegex(server.BybitFailure, "курсор"):
                server.monthly_futures_activity("k", "s", end_ms=1762473600000)



class TestConsistentMonthlyAnchor(TestCase):
    """All linked subaccounts must use exactly the same reporting boundaries."""

    def setUp(self):
        server.MONTH_CACHE.clear()

    def test_anchor_rounds_to_utc_5_minutes_and_is_cached(self):
        now = int(server.time.time() * 1000)
        anchor = now // 300000 * 300000
        report = {"netPnl": 8, "from": anchor - server.PERFORMANCE_MS, "to": anchor}
        with patch.object(server, "credentials", return_value=("key", "secret", "Test")):
            with patch.object(server, "monthly_futures_activity", return_value=report) as ledger:
                first = server.monthly_account_performance("bybit-subaccount", anchor)
                second = server.monthly_account_performance("bybit-subaccount", anchor)
        self.assertEqual(first, report)
        self.assertEqual(second, report)
        ledger.assert_called_once_with("key", "secret", end_ms=anchor, period_ms=server.PERFORMANCE_MS, utc_today=False)

    def test_stale_or_future_anchors_rejected_before_any_api_call(self):
        now = int(server.time.time() * 1000)
        with patch.object(server, "credentials", return_value=("key", "secret", "Test")):
            with patch.object(server, "monthly_futures_activity") as ledger:
                for bad in ("bad", now - 3600000, now + 120000):
                    with self.assertRaises(server.BybitFailure):
                        server.monthly_account_performance("bybit-subaccount", bad)
                ledger.assert_not_called()



class TestExchangePeriodLedger(TestCase):
    """Historical chart is derived from exchange operations, not client snapshots."""

    def setUp(self):
        server.MONTH_CACHE.clear()

    def test_24h_period_uses_exact_exchange_cash_flows_and_ignores_transfers(self):
        end = 1762473600000
        start = end - server.PERFORMANCE_PERIODS["24h"]
        calls = []

        def bybit(path, params, key, secret):
            calls.append(dict(params))
            if len(calls) != 1:
                self.fail("24h should require just one ledger window")
            return {"nextPageCursor": "", "list": [
                {"category": "linear", "currency": "USDT", "type": "TRADE",
                 "transactionTime": str(start + 3600000), "cashFlow": "2.4",
                 "funding": "", "fee": "0.4"},
                {"category": "linear", "currency": "USDT", "type": "SETTLEMENT",
                 "transactionTime": str(start + 7200000), "cashFlow": "0",
                 "funding": "-0.2", "fee": "0"},
                {"category": "linear", "currency": "USDT", "type": "TRANSFER_IN",
                 "transactionTime": str(start + 10000000), "cashFlow": "2000",
                 "funding": "", "fee": ""}
            ]}

        with patch.object(server, "request_bybit", side_effect=bybit):
            report = server.monthly_futures_activity(
                "k", "s", end_ms=end, period_ms=server.PERFORMANCE_PERIODS["24h"])
        self.assertEqual(len(calls), 1)
        self.assertAlmostEqual(report["netPnl"], 1.8)
        self.assertEqual(report["bucketMs"], 3600000)
        self.assertEqual(len(report["points"]), 2)
        self.assertAlmostEqual(sum(p["netPnl"] for p in report["points"]), 1.8)
        self.assertEqual(report["from"], start)
        self.assertEqual(report["to"], end)

    def test_week_chart_period_fetches_two_separate_7day_safe_windows(self):
        end = 1762473600000
        calls = []
        def bybit(path, params, key, secret):
            calls.append(params)
            self.assertLessEqual(
                int(params["endTime"])-int(params["startTime"]), 7*86400000)
            return {"list": [], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=bybit):
            report = server.monthly_futures_activity(
                "k", "s", end_ms=end, period_ms=server.PERFORMANCE_PERIODS["7d"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(report["netPnl"], 0)
        self.assertEqual(report["points"], [])

    def test_period_cache_is_separate_for_each_period(self):
        now = int(server.time.time() * 1000)
        anchor = now // 300000 * 300000
        template = {"from": anchor - server.PERFORMANCE_MS, "to": anchor, "netPnl": 0,
                    "points": []}
        with patch.object(server, "credentials", return_value=("k", "s", "Sub")):
            with patch.object(server, "monthly_futures_activity", side_effect=lambda *a, **k: dict(template)) as ledger:
                a = server.monthly_account_performance("bybit-subaccount", anchor, "24h")
                b = server.monthly_account_performance("bybit-subaccount", anchor, "7d")
                c = server.monthly_account_performance("bybit-subaccount", anchor, "24h")
        self.assertEqual(ledger.call_count, 2)
        self.assertEqual(a["period"], "24h")
        self.assertEqual(b["period"], "7d")
        self.assertEqual(c["period"], "24h")
        self.assertEqual(ledger.call_args_list[0].kwargs["period_ms"],
                         server.PERFORMANCE_PERIODS["24h"])
        self.assertEqual(ledger.call_args_list[1].kwargs["period_ms"],
                         server.PERFORMANCE_PERIODS["7d"])

    def test_rejects_unapproved_long_period_before_requesting_credentials(self):
        with patch.object(server, "credentials") as creds:
            with self.assertRaisesRegex(server.BybitFailure, "Неизвестный период"):
                server.monthly_account_performance("bybit-subaccount", period="9000y")
            creds.assert_not_called()



class TestBybitTodayAndSymbolBreakdown(TestCase):
    def test_today_uses_utc_midnight_not_trailing_24_hours(self):
        end = 1762473600000 + 3 * 3600000
        midnight = end // 86400000 * 86400000
        calls = []
        def bybit(path, params, key, secret):
            calls.append(dict(params))
            return {"list": [
                {"type": "TRADE", "currency": "USDT", "category": "linear",
                 "symbol": "ADAUSDT", "transactionTime": str(midnight + 3600000),
                 "cashFlow": "5", "fee": "0.2", "funding": "0"},
                {"type": "SETTLEMENT", "currency": "USDT", "category": "linear",
                 "symbol": "ADAUSDT", "transactionTime": str(midnight + 2*3600000),
                 "cashFlow": "0", "fee": "0", "funding": "-0.5"},
                {"type": "TRANSFER_IN", "currency": "USDT", "category": "linear",
                 "symbol": "", "transactionTime": str(midnight + 2*3600000),
                 "cashFlow": "2500", "fee": "", "funding": ""}
            ], "nextPageCursor": ""}
        with patch.object(server, "request_bybit", side_effect=bybit):
            result = server.monthly_futures_activity(
                "k", "s", end_ms=end, period_ms=server.PERFORMANCE_PERIODS["today"],
                utc_today=True)
        self.assertEqual(result["from"], midnight)
        self.assertEqual(result["intervalType"], "UTC day")
        self.assertEqual(int(calls[0]["startTime"]), midnight)
        self.assertAlmostEqual(result["netPnl"], 4.3)
        self.assertAlmostEqual(result["symbols"][0]["netPnl"], 4.3)
        self.assertEqual(result["symbols"][0]["symbol"], "ADAUSDT")
        self.assertAlmostEqual(sum(x["netPnl"] for x in result["symbols"]),
                               result["netPnl"])
        self.assertEqual(result["symbols"][0]["operations"], 2)
        self.assertTrue(result["costEventsComplete"])
        self.assertEqual(len(result["costEvents"]), 2)
        self.assertEqual(result["costEvents"][0]["symbol"], "ADAUSDT")
        self.assertAlmostEqual(sum(p["funding"] for p in result["costEvents"]), -0.5)
        self.assertAlmostEqual(sum(p["fees"] for p in result["costEvents"]), 0.2)

    def test_60_day_period_is_supported_without_synthetic_equity_history(self):
        self.assertEqual(server.PERFORMANCE_PERIODS["60d"], 60 * 86400000)
        self.assertEqual(server.PERFORMANCE_PERIODS["all"], 729 * 86400000)


class TestPrivateEquityHistory(TestCase):
    def test_equity_snapshots_are_private_and_summed_only_when_all_accounts_exist(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(server.saved_state, "DATA_DIR", Path(tmp)):
                with patch.object(server.saved_state, "EQUITY_HISTORY_PATH",
                                  Path(tmp) / "equity.json"):
                    now = int(server.time.time() * 1000)
                    items = [{"t": now, "accountId": "sub-a", "equity": 1000.0},
                             {"t": now, "accountId": "sub-b", "equity": 2000.0}]
                    result = server.saved_state.merge_equity_history(items)
                    self.assertEqual(result["points"], 2)
                    records = server.saved_state.read_equity_history()["points"]
                    self.assertEqual(len(records), 2)
                    self.assertEqual({x["accountId"] for x in records}, {"sub-a", "sub-b"})
                    self.assertEqual((Path(tmp) / "equity.json").stat().st_mode & 0o777, 0o600)
                    with self.assertRaises(server.saved_state.StateError):
                        server.saved_state.merge_equity_history(
                            [{"t": now, "accountId": "sub-a", "equity": "-1"}])
                    self.assertEqual(len(server.saved_state.read_equity_history()["points"]), 2)

    def test_server_equity_sampling_never_invents_zero_on_partial_failures(self):
        with patch.object(server.saved_state, "merge_equity_history") as saved:
            with patch.object(server.saved_state, "merge_history"):
                with patch.object(server, "credentials", return_value=("k", "s", "sub")):
                    with patch.object(server.saved_state, "list_extra_accounts", return_value=[]):
                        with patch.object(server.saved_state, "read_profile", return_value={"portfolio": {}}):
                            with patch.object(server, "snapshot", return_value={
                                "totals": {"equity": "1234.5", "perpUPL": "0", "accountPnl": "1"}}):
                                self.assertTrue(server.sample_history_once())
            saved.assert_called_once()
            rows = saved.call_args.args[0]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["accountId"], "bybit-subaccount")
            self.assertAlmostEqual(rows[0]["equity"], 1234.5)



class TestLongTermBybitHistory(TestCase):
    def setUp(self):
        server.CHUNK_CACHE.clear()
        server.SPOT_HISTORY_CACHE.clear()

    def test_six_day_slice_is_cached_without_replaying_old_exchange_requests(self):
        now = int(server.time.time() * 1000)
        stop = now // 300000 * 300000
        start = stop - 6 * 86400000
        calls = []
        def response(path, params, key, secret):
            calls.append((path, params))
            return {"list": [{"type": "TRADE", "category": "linear",
                              "currency": "USDT", "symbol": "ADAUSDT",
                              "transactionTime": str(start+3600000),
                              "cashFlow": "3", "fee": "0.2", "funding": "0"}],
                    "nextPageCursor": ""}
        with patch.object(server, "credentials", return_value=("test-key", "test-secret", "Mock")):
            with patch.object(server, "request_bybit", side_effect=response):
                a = server.chunk_account_performance("bybit-subaccount", start, stop)
                b = server.chunk_account_performance("bybit-subaccount", start, stop)
        self.assertEqual(len(calls), 1, "One six-day range is one Bybit transaction window")
        self.assertEqual(a, b)
        self.assertAlmostEqual(a["netPnl"], 2.8)
        self.assertEqual(a["from"], start)
        self.assertEqual(a["to"], stop)
        self.assertEqual(a["symbols"][0]["symbol"], "ADAUSDT")
        self.assertEqual(a["days"][0]["netPnl"], 2.8)

    def test_slice_rejects_gaps_over_six_days_and_outdated_history(self):
        now = int(server.time.time() * 1000)
        with patch.object(server, "credentials") as credential:
            for start,stop in ((now-8*86400000,now),
                               (now-731*86400000, now-730*86400000),
                               (now, now+100000)):
                with self.assertRaises(server.BybitFailure):
                    server.chunk_account_performance("bybit-subaccount",start,stop)
            credential.assert_not_called()

    def test_public_spot_prices_are_real_daily_bybit_candles_without_api_key(self):
        now = int(server.time.time() * 1000)
        end = now // 86400000 * 86400000
        start = end - 30*86400000
        accessed = []
        class Reply:
            def __init__(self,body):
                self.body = body
            def __enter__(self):
                return self
            def __exit__(self,*args):
                return False
            def read(self,_):
                return self.body
        def fetch(request,timeout):
            accessed.append(request)
            row=[str(start), "100", "150", "80", "120", "1000", "2000"]
            payload={"retCode":0,"result":{"list":[row]}}
            return Reply(json.dumps(payload).encode("utf-8"))
        with patch.object(server, "API_HOST", "https://api.bybit.com"):
            with patch.object(server, "urlopen", side_effect=fetch):
                data = server.public_spot_history("30d")
                again = server.public_spot_history("30d")
        self.assertEqual(data, again)
        self.assertEqual(len(accessed), 2, "One public request per coin, cache on repeat")
        self.assertEqual(data["prices"]["BTC"][0]["close"], 120)
        self.assertEqual(data["prices"]["ETH"][0]["close"], 120)
        self.assertTrue(all("/v5/market/kline?" in r.full_url for r in accessed))
        self.assertTrue(all("category=spot" in r.full_url for r in accessed))
        self.assertTrue(all("interval=D" in r.full_url for r in accessed))
        self.assertTrue(all("X-BAPI-API-KEY" not in dict(r.header_items()) for r in accessed))
        self.assertEqual(data["from"], start)
        self.assertEqual(data["to"], end)

    def test_public_spot_history_rejects_unsupported_periods(self):
        with patch.object(server, "urlopen") as bybit:
            with self.assertRaises(server.BybitFailure):
                server.public_spot_history("bogus")
            bybit.assert_not_called()


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
