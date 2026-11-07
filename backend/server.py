#!/usr/bin/env python3
"""FXMR4 private read-only Bybit connector. Python 3.10+, standard library only.

This server serves the portfolio as one HTTPS origin behind a reverse proxy.
It uses Bybit subaccount API credentials from environment, or ephemeral RAM
credentials supplied through the authenticated /api/connect route.
Never commit credentials to GitHub or pass them to a public static site.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

import state as saved_state
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
BIND = os.environ.get("FXMR4_HOST", "127.0.0.1")
PORT = int(os.environ.get("FXMR4_PORT", "8768"))
USER = os.environ.get("FXMR4_USER", "fxmr4")
PASSWORD = os.environ.get("FXMR4_PASSWORD", "")
API_HOST = os.environ.get("BYBIT_API_HOST", "https://api.bybit.com").rstrip("/")
ALLOWED_HOSTS = {
    "https://api.bybit.com",
    "https://api.bybit.id",
    "https://api.bytick.com",
    "https://api-testnet.bybit.com",
}
RECV_WINDOW = "5000"
LOCK = threading.RLock()
EPHEMERAL = {"key": None, "secret": None, "label": "Subaccount"}
CACHE = {"at": 0.0, "data": None}
EXTRA_CACHE = {}
MONTH_CACHE = {}  # Cached per API key, never contains API credentials.
CHUNK_CACHE = {}  # Bounded cache of independently fetched 6-day transaction windows.
SPOT_HISTORY_CACHE = {}  # Daily public Bybit Spot candles, never contains account keys.
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


_POST_LIMITS = {"/api/user-data": 470_000, "/api/pnl-history": 120_000}


def _post_limit(path):
    """Per-route body cap. Unknown routes keep the small default."""
    return _POST_LIMITS.get(path, 5_000)


class BybitFailure(Exception):
    pass


def credentials():
    with LOCK:
        disk = saved_state.read_credentials()
        key = EPHEMERAL["key"] or (disk["key"] if disk else None) or os.environ.get("BYBIT_SUBACCOUNT_KEY", "")
        secret = EPHEMERAL["secret"] or (disk["secret"] if disk else None) or os.environ.get("BYBIT_SUBACCOUNT_SECRET", "")
        label = (EPHEMERAL["label"] if EPHEMERAL["key"] else
                 disk["label"] if disk else os.environ.get("BYBIT_SUBACCOUNT_LABEL", "Subaccount"))
    return key, secret, label


def request_bybit(path, params, key, secret):
    query = urlencode(sorted(params.items()))
    ts = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode("utf-8"), (ts + key + RECV_WINDOW + query).encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    url = API_HOST + path + ("?" + query if query else "")
    req = Request(url, headers={
        "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW, "X-BAPI-SIGN": signature,
        "Accept": "application/json", "User-Agent": "fxmr4-readonly/1.0",
    }, method="GET")
    try:
        with urlopen(req, timeout=12) as reply:
            raw = reply.read(2_000_000)
        data = json.loads(raw)
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        raise BybitFailure("Не удалось получить ответ Bybit: " + type(exc).__name__) from exc
    if data.get("retCode") != 0:
        raise BybitFailure("Bybit: " + str(data.get("retMsg", "API error"))[:160] +
                           " (код " + str(data.get("retCode")) + ")")
    return data.get("result", {})


def _int_ms(value):
    try:
        n = int(str(value).strip())
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _num(value):
    try:
        n = float(value)
        return n if n == n and abs(n) != float("inf") else None
    except (ValueError, TypeError):
        return None


def collect_positions(key, secret, settle_coin):
    result = []
    cursor = ""
    for _ in range(12):
        params = {"category": "linear", "settleCoin": settle_coin, "limit": "200"}
        if cursor:
            params["cursor"] = cursor
        page = request_bybit("/v5/position/list", params, key, secret)
        for p in page.get("list", []):
            qty = _num(p.get("size"))
            if qty is None or qty <= 0:
                continue
            result.append({
                "symbol": str(p.get("symbol", ""))[:30],
                "side": "Long" if p.get("side") == "Buy" else "Short" if p.get("side") == "Sell" else "",
                "quantity": qty,
                "size": _num(p.get("positionValue")),
                "entryPrice": _num(p.get("avgPrice")),
                "markPrice": _num(p.get("markPrice")),
                "liqPrice": _num(p.get("liqPrice")),
                "leverage": _num(p.get("leverage")),
                "pnl": _num(p.get("unrealisedPnl")),
                "initialMargin": _num(p.get("positionIM")),
                "cumulativeRealisedPnl": _num(p.get("cumRealisedPnl")),
                "takeProfit": _num(p.get("takeProfit")),
                "stopLoss": _num(p.get("stopLoss")),
                # Bybit reports the position's first open time; sorting by it is
                # the only way to read "oldest position first" from the venue.
                # createdTime is the first-ever position on this symbol, often months old.
                # openTime is the current position start; 0 means Bybit does not know.
                "openedAt": _int_ms(p.get("openTime")),
                "accountId": "bybit-subaccount",
                "exchangeId": "bybit",
                "settleCoin": settle_coin,
            })
        next_cursor = page.get("nextPageCursor") or ""
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
    else:
        raise BybitFailure("Слишком много страниц позиций: проверь ограничения API")
    return result


def realised_futures_pnl(account):
    """Bybit UTA cumulative realised derivatives PNL, in USDT/USDC.

    This is NOT the sum of cumRealisedPnl on currently OPEN positions.
    Closed positions disappear from /v5/position/list, so their result must
    come from the account wallet instead.
    """
    coins = account.get("coin")
    if not isinstance(coins, list):
        return None
    total = 0.0
    present = False
    for item in coins:
        if not isinstance(item, dict):
            return None
        raw = item.get("cumRealisedPnl")
        if raw in (None, ""):
            continue
        value = _num(raw)
        if value is None:
            return None
        denomination = str(item.get("coin") or "").upper()
        if denomination in ("USDT", "USDC"):
            total += value
            present = True
        elif abs(value) > 0.00000001:
            # Inverse products settle in coin. Do NOT mix BTC with USD.
            return None
    return total if present else None


def futures_pnl_totals(account):
    """Do not invent realised profit when Bybit omits wallet fields."""
    floating = _num(account.get("totalPerpUPL"))
    realised = realised_futures_pnl(account)
    combined = realised + floating if realised is not None and floating is not None else None
    return {"realisedPnl": realised, "accountPnl": combined}



# The exchange ledger covers a real 30-day result even when this VPS has not
# accumulated 30 days of snapshot samples. Bybit limits each query to 7 days.
PERFORMANCE_MS = 30 * 24 * 3600 * 1000
LEDGER_WINDOW_MS = 6 * 24 * 3600 * 1000
# Transaction-log supplies up to two years of history, not historical equity.
# 1y/all are fetched only if the user explicitly selects the range.
PERFORMANCE_PERIODS = {
    "today": 24 * 3600 * 1000,
    "24h": 24 * 3600 * 1000,
    "7d": 7 * 24 * 3600 * 1000,
    "30d": PERFORMANCE_MS,
    "60d": 60 * 24 * 3600 * 1000,
    "90d": 90 * 24 * 3600 * 1000,
    "6m": 180 * 24 * 3600 * 1000,
    "1y": 365 * 24 * 3600 * 1000,
    "all": 729 * 24 * 3600 * 1000,
}

LEDGER_TYPES = {"TRADE", "SETTLEMENT", "DELIVERY", "LIQUIDATION", "ADL",
                "FEE_REFUND", "FORWARD_SPLIT_SETTLE", "FORWARD_SPLIT_OPEN",
                "REVERSE_SPLIT_SETTLE", "REVERSE_SPLIT_OPEN"}
NON_PNL_LEDGER_TYPES = {"TRANSFER_IN", "TRANSFER_OUT", "TRANSFER", "AIRDROP",
                        "BONUS", "BONUS_RECOLLECT", "BONUS_TRANSFER_IN",
                        "BONUS_TRANSFER_OUT", "INTEREST", "BORROW", "REPAY",
                        "CURRENCY_BUY", "CURRENCY_SELL", "CONVERT",
                        "SPOT_REPAYMENT_SELL", "SPOT_REPAYMENT_BUY",
                        "DEPOSIT", "WITHDRAW", "FLOATING_TO_FIXED_BORROW",
                        "FLOATING_TO_FIXED_REPAY"}


def monthly_futures_activity(key, secret, end_ms=None, period_ms=PERFORMANCE_MS, utc_today=False):
    """Closed/settled derivatives cash flows + funding - trading fees, UTC.

    Excludes transfers and open-position unrealised PNL. Do not silently return
    a partial total when pagination or a monetary field is unknown.
    """
    end_ms = int(time.time() * 1000) if end_ms is None else int(end_ms)
    if period_ms not in PERFORMANCE_PERIODS.values() and not 0 < period_ms <= LEDGER_WINDOW_MS:
        raise BybitFailure("Неподдерживаемый период истории Bybit")
    start_ms = (end_ms // 86400000) * 86400000 if utc_today else end_ms - period_ms
    # Cumulative net PNL points are aggregated from actual exchange records.
    bucket_ms = 3600000 if period_ms <= 7 * 86400000 else 86400000
    series_bins = {}
    totals = {"tradingPnl": 0.0, "funding": 0.0, "fees": 0.0}
    daily = {}
    per_symbol = {}
    cost_events = []
    costs_complete = True
    unknown_types = set()
    left = start_ms
    while left < end_ms:
        right = min(end_ms - 1, left + LEDGER_WINDOW_MS - 1)
        cursor = ""
        for page_number in range(100):
            params = {"accountType": "UNIFIED", "category": "linear",
                      "startTime": str(left), "endTime": str(right), "limit": "50"}
            if cursor:
                params["cursor"] = cursor
            page = request_bybit("/v5/account/transaction-log", params, key, secret)
            for record in page.get("list") or []:
                if not isinstance(record, dict):
                    raise BybitFailure("Bybit вернул некорректную запись операций")
                if str(record.get("category") or "linear").lower() != "linear":
                    continue
                when = _int_ms(record.get("transactionTime"))
                if when is None:
                    raise BybitFailure("В операции Bybit отсутствует дата")
                if not start_ms <= when < end_ms:
                    continue
                currency = str(record.get("currency") or "").upper()
                if currency not in ("USDT", "USDC"):
                    continue  # Never mix BTC-denominated results with dollars.
                kind = str(record.get("type") or "").upper()
                if kind not in LEDGER_TYPES:
                    # Transfers, bonuses and other balance adjustments are not PNL.
                    # Raise on unfamiliar nonzero derivative cash flow instead of
                    # mislabelling it as profit or silently ignoring actual trades.
                    if kind not in NON_PNL_LEDGER_TYPES and any(
                        (_num(record.get(field)) or 0) != 0
                        for field in ("cashFlow", "funding", "fee", "change")
                    ):
                        unknown_types.add(kind or "UNKNOWN")
                    continue
                pieces = {}
                for source, name in (("cashFlow", "tradingPnl"),
                                     ("funding", "funding"), ("fee", "fees")):
                    raw = record.get(source)
                    value = _num("0" if raw in (None, "") else raw)
                    if value is None:
                        raise BybitFailure("Bybit вернул некорректную сумму операции")
                    pieces[name] = value
                net_change = pieces["tradingPnl"] + pieces["funding"] - pieces["fees"]
                symbol = str(record.get("symbol") or "").strip().upper()[:30] or "OTHER"
                if abs(pieces["funding"]) > 1e-12 or abs(pieces["fees"]) > 1e-12:
                    if symbol == "OTHER":
                        costs_complete = False  # Costs cannot be attributed to a position.
                    if len(cost_events) < 20000:
                        cost_events.append({"t": when, "symbol": symbol,
                                            "funding": pieces["funding"], "fees": pieces["fees"]})
                    else:
                        costs_complete = False
                # Funding/fees without a symbol remain in OTHER, never assigned
                # to an unrelated coin.
                group = per_symbol.setdefault(symbol, {"symbol": symbol, "netPnl": 0.0,
                                            "tradingPnl": 0.0, "funding": 0.0,
                                            "fees": 0.0, "operations": 0})
                group["netPnl"] += net_change
                group["operations"] += 1
                for name, amount in pieces.items():
                    group[name] += amount
                slot = max(start_ms, when // bucket_ms * bucket_ms)
                series_bins[slot] = series_bins.get(slot, 0.0) + net_change
                date = time.strftime("%Y-%m-%d", time.gmtime(when / 1000))
                bucket = daily.setdefault(date, {"tradingPnl": 0.0, "funding": 0.0, "fees": 0.0})
                for name, value in pieces.items():
                    bucket[name] += value
                    totals[name] += value
            following = page.get("nextPageCursor") or ""
            if not following:
                break
            if following == cursor:
                raise BybitFailure("Повторяется курсор истории Bybit")
            cursor = following
        else:
            raise BybitFailure("История операций слишком большая для точного расчёта")
        left = right + 1
    if unknown_types:
        raise BybitFailure("Неизвестный тип операции Bybit: " + ", ".join(sorted(unknown_types))[:90])
    days = []
    for date, values in sorted(daily.items()):
        days.append({"date": date, "netPnl": round(values["tradingPnl"] + values["funding"] - values["fees"], 8),
                     "funding": round(values["funding"], 8), "fees": round(values["fees"], 8)})
    series = [{"t": t, "netPnl": round(value, 8)} for t, value in sorted(series_bins.items())]
    symbols = []
    for symbol, values in sorted(per_symbol.items(), key=lambda pair: abs(pair[1]["netPnl"]), reverse=True):
        symbols.append({"symbol": symbol, "netPnl": round(values["netPnl"], 8),
                        "tradingPnl": round(values["tradingPnl"], 8),
                        "funding": round(values["funding"], 8),
                        "fees": round(values["fees"], 8),
                        "operations": values["operations"]})
    # Keep responses bounded for active portfolios with hundreds of markets.
    if len(symbols) > 100:
        extras = symbols[99:]
        other = {"symbol": "OTHER", "netPnl": 0, "tradingPnl": 0,
                 "funding": 0, "fees": 0, "operations": 0}
        for row in extras:
            for field in ("netPnl", "tradingPnl", "funding", "fees", "operations"):
                other[field] += row[field]
        symbols = symbols[:99] + [other]
    result = {"from": start_ms, "to": end_ms, "days": days,
              "points": series, "bucketMs": bucket_ms,
              "symbols": symbols, "intervalType": "UTC day" if utc_today else "rolling",
              # Used for matching exact position open time without guessing
              # fees from the entire 30-day account trading history.
              "costEvents": cost_events if costs_complete else [],
              "costEventsComplete": costs_complete,
              "tradingPnl": round(totals["tradingPnl"], 8),
              "funding": round(totals["funding"], 8),
              "fees": round(totals["fees"], 8),
              "netPnl": round(totals["tradingPnl"] + totals["funding"] - totals["fees"], 8),
              "source": "Bybit transaction-log · linear · UTC",
              "includesUnrealised": False}
    return result


def monthly_account_performance(account_id, end_ms=None, period='30d'):
    """Return the same UTC reporting interval for every linked subaccount.

    A client supplies a 5-minute UTC anchor for all accounts. Restrict the
    window to recent history so this read-only endpoint cannot be abused to
    repeatedly query arbitrarily large historical ranges.
    """
    if period not in PERFORMANCE_PERIODS:
        raise BybitFailure("Неизвестный период статистики")
    now_ms = int(time.time() * 1000)
    if end_ms is None:
        end_ms = now_ms
    try:
        end_ms = int(end_ms)
    except (ValueError, TypeError) as exc:
        raise BybitFailure("Некорректная дата месячного отчёта") from exc
    if not now_ms - 1800000 <= end_ms <= now_ms + 60000:
        raise BybitFailure("Месячный отчёт должен быть за текущий период")
    end_ms = end_ms // 300000 * 300000
    if account_id == "bybit-subaccount":
        key, secret, _ = credentials()
    else:
        account = next((a for a in saved_state.list_extra_accounts() if a["id"] == account_id), None)
        if not account:
            raise BybitFailure("Субаккаунт не найден")
        key, secret = account["key"], account["secret"]
    if not key or not secret:
        raise BybitFailure("API-ключ субаккаунта не настроен")
    fingerprint = hashlib.sha256((key + ":" + secret).encode("utf-8")).digest()
    cache_key = (account_id, period)
    with LOCK:
        cached = MONTH_CACHE.get(cache_key)
        if cached and cached["fingerprint"] == fingerprint and cached["end_ms"] == end_ms and time.monotonic() - cached["at"] < 600:
            return cached["data"]
    duration = PERFORMANCE_PERIODS[period]
    result = monthly_futures_activity(key, secret, end_ms=end_ms, period_ms=duration, utc_today=(period == "today"))
    result["period"] = period
    with LOCK:
        # Keep the cache bounded if many periods/accounts are selected over time.
        if len(MONTH_CACHE) > 180:
            MONTH_CACHE.clear()
        MONTH_CACHE[cache_key] = {"at": time.monotonic(), "end_ms": end_ms, "fingerprint": fingerprint, "data": result}
    return result



def chunk_account_performance(account_id, start_ms, end_ms):
    """Load one bounded slice of exchange history.

    The browser combines six-day slices for 90/180/365-day views, avoiding one
    very long HTTP response that can time out behind the reverse proxy.
    Cached responses are keyed by both UTC bounds and API key fingerprint.
    """
    try:
        start_ms, end_ms = int(start_ms), int(end_ms)
    except (TypeError, ValueError) as exc:
        raise BybitFailure("Неверные границы периода") from exc
    now_ms = int(time.time() * 1000)
    if (end_ms <= start_ms or end_ms-start_ms > LEDGER_WINDOW_MS or
        start_ms < now_ms-730*86400000 or end_ms > now_ms+60000):
        raise BybitFailure("Период должен быть не длиннее шести дней и не старше двух лет")
    if account_id == "bybit-subaccount":
        key, secret, _ = credentials()
    else:
        account = next((a for a in saved_state.list_extra_accounts() if a["id"] == account_id), None)
        if account is None:
            raise BybitFailure("Субаккаунт не найден")
        key, secret = account["key"], account["secret"]
    if not key or not secret:
        raise BybitFailure("API-ключ субаккаунта не настроен")
    fingerprint = hashlib.sha256((key+":"+secret).encode("utf-8")).digest()
    cache_key = (account_id, start_ms, end_ms)
    # Complete historical windows may be reused across server restarts.
    # The trailing two days are refreshed more often for corrections/funding.
    historical = end_ms <= now_ms - 2 * 86400000
    max_age_s = 180 * 86400 if historical else 600
    token = hashlib.sha256((str(account_id) + ":" + str(start_ms) +
                            ":" + str(end_ms)).encode("utf-8") +
                           fingerprint).hexdigest()
    with LOCK:
        cached = CHUNK_CACHE.get(cache_key)
        if (cached and cached["fingerprint"] == fingerprint and
            time.monotonic() - cached["at"] < max_age_s):
            return cached["data"]
    try:
        saved = saved_state.read_ledger_chunk_cache(token)
    except saved_state.StateError:
        saved = None
    if saved is not None and (now_ms - saved["receivedAt"] <
                              max_age_s * 1000):
        report = saved["report"]
        if (report.get("from") == start_ms and report.get("to") == end_ms
                and isinstance(report.get("netPnl"), (float, int))):
            with LOCK:
                CHUNK_CACHE[cache_key] = {"at": time.monotonic(),
                                          "fingerprint": fingerprint,
                                          "data": report}
            return report
    report = monthly_futures_activity(key, secret, end_ms=end_ms,
                                      period_ms=end_ms-start_ms)
    report["source"] = "Bybit transaction-log · verified 6-day slice · UTC"
    try:
        saved_state.write_ledger_chunk_cache(token, report)
    except (saved_state.StateError, OSError) as exc:
        print("Bybit history cache write skipped: " + type(exc).__name__, flush=True)
    with LOCK:
        if len(CHUNK_CACHE) > 1800:
            CHUNK_CACHE.clear()
        CHUNK_CACHE[cache_key] = {"at": time.monotonic(),
                                  "fingerprint": fingerprint, "data": report}
    return report


def snapshot():
    key, secret, label = credentials()
    if not key or not secret:
        raise BybitFailure("Ключ субаккаунта ещё не настроен")
    now = time.monotonic()
    with LOCK:
        if CACHE["data"] is not None and now - CACHE["at"] < 30:
            return CACHE["data"]
    info = request_bybit("/v5/user/query-api", {}, key, secret)
    if info.get("readOnly") != 1:
        raise BybitFailure("Ключ имеет право записи. Нужен API-ключ Read-Only.")
    if info.get("isMaster") is True:
        raise BybitFailure("Этот ключ принадлежит основному аккаунту. Нужен ключ субаккаунта.")
    wallet = request_bybit("/v5/account/wallet-balance", {"accountType": "UNIFIED"}, key, secret)
    accounts = wallet.get("list") or []
    if not accounts:
        raise BybitFailure("Bybit не вернул Unified Account. Проверь права API.")
    account = accounts[0]
    pos = collect_positions(key, secret, "USDT") + collect_positions(key, secret, "USDC")
    totals = {
        "equity": _num(account.get("totalEquity")),
        "walletBalance": _num(account.get("totalWalletBalance")),
        "availableBalance": _num(account.get("totalAvailableBalance")),
        "perpUPL": _num(account.get("totalPerpUPL")),
        **futures_pnl_totals(account),
        "accountInitialMargin": _num(account.get("totalInitialMargin")),
        "positionCount": len(pos),
    }
    data = {
        "exchange": "Bybit",
        "account": {"id": "bybit-subaccount", "name": label, "type": "UNIFIED"},
        "totals": totals,
        "positions": pos,
        "updatedAt": int(time.time() * 1000),
        "balanceNote": "Equity UTA может включать спот и фьючерсы одновременно; не прибавляйте её к Spot второй раз.",
    }
    with LOCK:
        CACHE["at"], CACHE["data"] = time.monotonic(), data
    return data



def linked_accounts():
    key, secret, label = credentials()
    out = []
    if key and secret:
        existing = saved_state.read_credentials()
        out.append({"id": "bybit-subaccount", "label": label, "exchange": "Bybit",
                    "icon": existing.get("icon", "wallet") if existing else "wallet",
                    "legacy": True})
    for a in saved_state.list_extra_accounts():
        out.append({"id": a["id"], "label": a["label"], "exchange": "Bybit",
                    "icon": a.get("icon", "wallet"), "legacy": False})
    return out


def snapshot_extra(account_id):
    account = next((a for a in saved_state.list_extra_accounts() if a["id"] == account_id), None)
    if account is None:
        raise BybitFailure("Субаккаунт не найден")
    with LOCK:
        cached = EXTRA_CACHE.get(account_id)
        if cached and time.monotonic() - cached["at"] < 30:
            return cached["data"]
    key, secret = account["key"], account["secret"]
    meta = request_bybit("/v5/user/query-api", {}, key, secret)
    if meta.get("readOnly") != 1 or meta.get("isMaster") is True:
        raise BybitFailure("Ключ не имеет прав Read-Only субаккаунта")
    wallet = request_bybit("/v5/account/wallet-balance", {"accountType": "UNIFIED"}, key, secret)
    if not wallet.get("list"):
        raise BybitFailure("Bybit не вернул Unified Account")
    a = wallet["list"][0]
    positions = collect_positions(key, secret, "USDT") + collect_positions(key, secret, "USDC")
    for p in positions:
        p["accountId"] = account_id
    result = {"exchange": "Bybit",
              "account": {"id": account_id, "name": account["label"], "type": "UNIFIED"},
              "totals": {"equity": _num(a.get("totalEquity")),
                         "walletBalance": _num(a.get("totalWalletBalance")),
                         "availableBalance": _num(a.get("totalAvailableBalance")),
                         "perpUPL": _num(a.get("totalPerpUPL")),
                         **futures_pnl_totals(a),
                         "accountInitialMargin": _num(a.get("totalInitialMargin")),
                         "positionCount": len(positions)},
              "positions": positions, "updatedAt": int(time.time() * 1000)}
    with LOCK:
        EXTRA_CACHE[account_id] = {"at": time.monotonic(), "data": result}
    return result

class Handler(BaseHTTPRequestHandler):
    server_version = "FXMR4/1.0"

    def log_message(self, fmt, *args):
        # Do not log request headers, body, API Key or API Secret.
        print("%s [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args),
              flush=True)

    def _headers(self, status, mime="application/json; charset=utf-8", length=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                         "connect-src 'self' https://api.bybit.com https://api.bybit.id "
                         "https://api.bytick.com https://api.coingecko.com "
                         "https://min-api.cryptocompare.com; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, obj, code=200):
        payload = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(code, length=len(payload))
        self.wfile.write(payload)

    def _authenticated(self):
        value = self.headers.get("Authorization", "")
        if not value.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(value[6:], validate=True).decode("utf-8")
            uname, password = raw.split(":", 1)
        except (ValueError, UnicodeError, binascii.Error):
            return False
        return secrets.compare_digest(uname, USER) and secrets.compare_digest(password, PASSWORD)

    def _require_login(self):
        if self._authenticated():
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="FXMR4 private"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def _same_origin_action(self):
        # A custom header prevents cross-site HTML forms; no CORS is enabled.
        if self.headers.get("X-FXMR4-Action") != "1":
            return False
        origin = self.headers.get("Origin", "")
        if origin:
            parsed = urlsplit(origin)
            if parsed.netloc.lower() != self.headers.get("Host", "").lower():
                return False
            if parsed.scheme != "https" and self.headers.get("Host", "").split(":")[0] not in ("127.0.0.1", "localhost"):
                return False
        return True

    def do_GET(self):
        if not self._require_login():
            return
        path = urlsplit(self.path).path
        if path == "/api/status":
            key, secret, label = credentials()
            self._json({"backend": True, "configured": bool(key and secret),
                        "account": label, "exchange": "Bybit", "readOnly": True,
                        "persisted": bool(saved_state.read_credentials())})
            return
        if path == "/api/accounts":
            try:
                self._json({"accounts": linked_accounts()})
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path == "/api/spot-price-history":
            try:
                period = parse_qs(urlsplit(self.path).query).get("period", ["6m"])[0]
                self._json(public_spot_history(period))
            except BybitFailure as exc:
                self._json({"error": str(exc)}, 503)
            return
        if path == "/api/equity-history":
            try:
                allowed = {a["id"] for a in linked_accounts()}
                rows = [r for r in saved_state.read_equity_history()["points"]
                        if r.get("accountId") in allowed]
                self._json({"points": rows, "source": "FXMR4 authenticated Bybit equity snapshots",
                            "historicalBackfill": False})
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path == "/api/period-chunk":
            try:
                query = parse_qs(urlsplit(self.path).query)
                account_id = query.get("id", [""])[0]
                start_at = query.get("startAt", [None])[0]
                end_at = query.get("endAt", [None])[0]
                self._json(chunk_account_performance(account_id, start_at, end_at))
            except BybitFailure as exc:
                self._json({"error": str(exc)}, 503)
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path in ("/api/monthly-pnl", "/api/period-performance"):
            try:
                query = parse_qs(urlsplit(self.path).query)
                account_id = query.get("id", [""])[0]
                end_at = query.get("endAt", [None])[0]
                period = "30d" if path == "/api/monthly-pnl" else query.get("period", ["30d"])[0]
                self._json(monthly_account_performance(account_id, end_at, period))
            except BybitFailure as exc:
                self._json({"error": str(exc)}, 503)
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path == "/api/account-snapshot":
            try:
                account_id = parse_qs(urlsplit(self.path).query).get("id", [""])[0]
                value = snapshot() if account_id == "bybit-subaccount" else snapshot_extra(account_id)
                self._json({"connected": True, "data": value})
            except BybitFailure as exc:
                self._json({"connected": False, "error": str(exc)}, 503)
            except saved_state.StateError as exc:
                self._json({"connected": False, "error": str(exc)}, 500)
            return
        if path == "/api/user-data":
            try:
                self._json(saved_state.read_profile())
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path == "/api/pnl-history":
            try:
                self._json(saved_state.read_history())
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path == "/api/snapshot":
            try:
                self._json({"connected": True, "data": snapshot()})
            except BybitFailure as exc:
                self._json({"connected": False, "error": str(exc)}, 503)
            return
        target = ROOT / ("index.html" if path == "/" else path.lstrip("/"))
        try:
            resolved = target.resolve()
            if not resolved.is_relative_to(ROOT.resolve()) or not resolved.is_file() or resolved.suffix not in MIME:
                self._json({"error": "Not found"}, 404)
                return
            data = resolved.read_bytes()
            self._headers(200, MIME[resolved.suffix], len(data))
            self.wfile.write(data)
        except (OSError, ValueError):
            self._json({"error": "Not found"}, 404)

    def do_POST(self):
        if not self._require_login():
            return
        path = urlsplit(self.path).path
        if path not in ("/api/connect", "/api/disconnect", "/api/user-data",
                       "/api/rename", "/api/pnl-history", "/api/account-connect",
                       "/api/account-rename", "/api/account-delete"):
            self._json({"error": "Not found"}, 404)
            return
        if not self._same_origin_action():
            self._json({"error": "Invalid request origin"}, 403)
            return
        # Browser HTTPS is terminated by Caddy on the SAME VPS. Localhost
        # access is allowed for the SSH-encrypted loopback tunnel.
        local = self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")
        if not local and self.headers.get("X-Forwarded-Proto") != "https":
            self._json({"error": "HTTPS required"}, 403)
            return
        try:
            body_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json({"error": "Invalid content length"}, 400)
            return
        limit = _post_limit(path)
        if not 1 <= body_length < limit:
            self._json({"error": "Invalid content length"}, 413)
            return
        try:
            data = json.loads(self.rfile.read(body_length))
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
            self._json({"error": "Invalid JSON"}, 400)
            return

        if path == "/api/user-data":
            try:
                result = saved_state.write_profile(
                    data.get("revision"), data.get("portfolio"), data.get("levels")
                )
                self._json(result)
            except saved_state.StateError as exc:
                msg = str(exc)
                self._json({"error": msg}, 409 if msg.startswith("CONFLICT") else 422)
            return

        if path == "/api/pnl-history":
            # Append-only: the client contributes readings, the server owns the
            # merged series, so one browser never erases another's history.
            try:
                result = saved_state.merge_history(data.get("points"))
                self._json(result)
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 422)
            return

        if path == "/api/account-connect":
            key = str(data.get("key", "")).strip()
            secret = str(data.get("secret", "")).strip()
            label = str(data.get("label", "")).strip()
            icon = str(data.get("icon") or "wallet")
            if not (10 <= len(key) <= 256 and 10 <= len(secret) <= 256 and 1 <= len(label) <= 40):
                self._json({"error": "Проверь название и API-ключ"}, 422)
                return
            try:
                meta = request_bybit("/v5/user/query-api", {}, key, secret)
                if meta.get("readOnly") != 1 or meta.get("isMaster") is True:
                    raise BybitFailure("Нужен ключ Read-Only от субаккаунта")
                wallet = request_bybit("/v5/account/wallet-balance", {"accountType": "UNIFIED"}, key, secret)
                if not wallet.get("list"):
                    raise BybitFailure("Нет доступа к Unified Account")
                uid = meta.get("userID")
                if uid not in (None, ""):
                    uid = str(uid)
                    if any(str(x.get("uid")) == uid for x in saved_state.list_extra_accounts()):
                        raise BybitFailure("Субаккаунт с этим UID уже подключён")
                    legacy_key, legacy_secret, _ = credentials()
                    if legacy_key and legacy_secret:
                        try:
                            legacy_meta = request_bybit("/v5/user/query-api", {}, legacy_key, legacy_secret)
                            if str(legacy_meta.get("userID")) == uid:
                                raise BybitFailure("Этот субаккаунт уже подключён через другой API-ключ")
                        except BybitFailure as exc:
                            if "уже подключён" in str(exc):
                                raise
                            # Offline old key must not block an otherwise valid new connection.
                created = saved_state.add_extra_account(key, secret, label, uid=uid, icon=icon)
                self._json({"connected": True, "account": created, "persisted": True})
            except BybitFailure as exc:
                self._json({"error": str(exc)}, 422)
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 409)
            return
        if path == "/api/account-rename":
            try:
                result = saved_state.rename_extra_account(str(data.get("id", "")),
                                                         str(data.get("label", "")),
                                                         icon=data.get("icon"))
                with LOCK:
                    EXTRA_CACHE.pop(result["id"], None)
                self._json({"renamed": True, "account": result})
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 422)
            return
        if path == "/api/account-delete":
            try:
                result = saved_state.delete_extra_account(str(data.get("id", "")))
                with LOCK:
                    EXTRA_CACHE.pop(result["id"], None)
                self._json({"disconnected": True, "id": result["id"]})
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 422)
            return

        if path == "/api/rename":
            # Renaming only changes the display label. The key and secret are
            # re-encrypted unchanged, so this never touches Bybit permissions.
            try:
                label = str(data.get("label", "")).strip()
            except (ValueError, TypeError, UnicodeError):
                self._json({"error": "Invalid JSON"}, 400)
                return
            if not (1 <= len(label) <= 40):
                self._json({"error": "Имя субаккаунта должно быть от 1 до 40 символов"}, 422)
                return
            try:
                with LOCK:
                    result = saved_state.rename_credentials(label, icon=data.get("icon"))
                    if EPHEMERAL["key"]:
                        EPHEMERAL["label"] = result["label"]
                    if CACHE["data"] is not None:
                        CACHE["data"]["account"]["name"] = result["label"]
                self._json({"renamed": True, "account": result["label"]})
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 409)
            return

        if path == "/api/disconnect":
            try:
                with LOCK:
                    if os.environ.get("BYBIT_SUBACCOUNT_KEY") or os.environ.get("BYBIT_SUBACCOUNT_SECRET"):
                        self._json({"error": "Ключ задан в конфигурации VPS. Удали его там и перезапусти службу."}, 409)
                        return
                    saved_state.delete_credentials()
                    EPHEMERAL.update({"key": None, "secret": None, "label": "Subaccount"})
                    CACHE.update({"at": 0.0, "data": None})
                self._json({"connected": False, "disconnected": True})
            except saved_state.StateError as exc:
                self._json({"error": str(exc)}, 500)
            return

        # Bybit credentials must never be sent from a public static origin.
        try:
            key = str(data.get("key", "")).strip()
            secret = str(data.get("secret", "")).strip()
            label = str(data.get("label", "Subaccount")).strip()[:40] or "Subaccount"
        except (ValueError, TypeError, UnicodeError):
            self._json({"error": "Invalid JSON"}, 400)
            return
        if not (10 <= len(key) <= 256 and 10 <= len(secret) <= 256):
            self._json({"error": "Invalid key/secret length"}, 400)
            return
        # Validate read-only subaccount permissions BEFORE encrypted storage.
        try:
            meta = request_bybit("/v5/user/query-api", {}, key, secret)
            if meta.get("readOnly") != 1:
                raise BybitFailure("Ключ допускает торговлю или изменение счёта. Создай Read-Only.")
            if meta.get("isMaster") is True:
                raise BybitFailure("Это основной аккаунт. Нужен API-ключ субаккаунта.")
            test = request_bybit("/v5/account/wallet-balance", {"accountType": "UNIFIED"}, key, secret)
            if not test.get("list"):
                raise BybitFailure("Ключ не даёт доступа к Unified Account")
        except BybitFailure as exc:
            self._json({"connected": False, "error": str(exc)}, 422)
            return
        try:
            saved_state.write_credentials(key, secret, label)
        except saved_state.StateError as exc:
            self._json({"error": str(exc)}, 500)
            return
        with LOCK:
            EPHEMERAL.update({"key": key, "secret": secret, "label": label})
            CACHE.update({"at": 0.0, "data": None})
        self._json({"connected": True, "account": label,
                    "persisted": True, "message": "Ключ шифруется и хранится на VPS даже после перезапуска."})


HISTORY_SAMPLE_SECONDS = 300



def public_spot_history(period):
    """Real BTC/ETH daily Bybit Spot prices for reconstructing *recorded* buys.

    This is not a complete Bybit Spot account statement. The UI combines
    market closes with the user's saved purchase ledger and labels coverage.
    """
    if period not in ("30d", "60d", "90d", "6m", "1y", "all"):
        raise BybitFailure("Неподдерживаемый период Spot")
    now_ms = int(time.time()*1000)
    end_ms = now_ms // 86400000 * 86400000
    duration = (729*86400000 if period == "all" else PERFORMANCE_PERIODS[period])
    start_ms = end_ms - duration
    key = (start_ms, end_ms)
    with LOCK:
        cached = SPOT_HISTORY_CACHE.get(key)
        if cached and time.monotonic()-cached["at"] < 3600:
            return cached["data"]
    prices = {}
    for coin in ("BTC", "ETH"):
        last_error = "unavailable"
        for host in dict.fromkeys((API_HOST, "https://api.bybit.id", "https://api.bybit.com")):
            if host not in ALLOWED_HOSTS:
                continue
            try:
                query = urlencode({"category": "spot", "symbol": coin+"USDT",
                                   "interval": "D", "start": start_ms,
                                   "end": end_ms-1, "limit": 1000})
                request = Request(host+"/v5/market/kline?"+query, headers={
                    "Accept": "application/json", "User-Agent": "fxmr4-readonly/1.0"
                }, method="GET")
                with urlopen(request, timeout=12) as reply:
                    data = json.loads(reply.read(1_000_000))
                if data.get("retCode") != 0:
                    raise BybitFailure(str(data.get("retMsg") or "Kline unavailable")[:100])
                rows = data.get("result", {}).get("list") or []
                result = []
                for row in rows:
                    if not isinstance(row, list) or len(row) < 5:
                        raise BybitFailure("Некорректная свеча Spot")
                    moment = _int_ms(row[0])
                    close = _num(row[4])
                    if moment is None or close is None or close <= 0:
                        raise BybitFailure("Некорректная цена в истории Spot")
                    if start_ms <= moment < end_ms:
                        result.append({"t": moment, "close": close})
                result.sort(key=lambda x:x["t"])
                if not result:
                    raise BybitFailure("Bybit не вернул свечи "+coin)
                prices[coin] = result
                break
            except (URLError, HTTPError, TimeoutError, ValueError, OSError,
                    BybitFailure) as exc:
                last_error = type(exc).__name__
        else:
            raise BybitFailure("Нет истории Spot "+coin+": "+last_error)
    payload = {"from": start_ms, "to": end_ms, "prices": prices,
               "source": "Bybit Spot USDT daily candles · recorded purchases only"}
    with LOCK:
        if len(SPOT_HISTORY_CACHE) > 12:
            SPOT_HISTORY_CACHE.clear()
        SPOT_HISTORY_CACHE[key] = {"at": time.monotonic(), "data": payload}
    return payload


def public_spot_quotes(trades):
    """Live Bybit spot prices, independently of whether a browser is open.

    No API credentials are sent to this public endpoint. Never silently use
    last browser quotes after the tab closes: that creates a fake flat PNL line.
    """
    coins = set()
    for trade in trades:
        if not isinstance(trade, dict) or trade.get("coin") not in ("BTC", "ETH"):
            raise BybitFailure("Неизвестная монета Spot")
        coins.add(trade["coin"])
    if not coins:
        return {}
    last_error = None
    for host in dict.fromkeys((API_HOST, "https://api.bybit.id", "https://api.bybit.com")):
        if host not in ALLOWED_HOSTS:
            continue
        try:
            prices = {}
            for coin in sorted(coins):
                query = urlencode({"category": "spot", "symbol": coin + "USDT"})
                request = Request(host + "/v5/market/tickers?" + query, headers={
                    "Accept": "application/json", "User-Agent": "fxmr4-readonly/1.0"
                }, method="GET")
                with urlopen(request, timeout=8) as response:
                    payload = json.loads(response.read(100_000))
                if payload.get("retCode") != 0:
                    raise BybitFailure("Не удалось получить рыночную цену " + coin)
                values = payload.get("result", {}).get("list") or []
                price = _num(values[0].get("lastPrice")) if values else None
                if price is None or price <= 0:
                    raise BybitFailure("Некорректная цена " + coin)
                prices[coin] = {"price": price}
            return prices
        except (URLError, HTTPError, TimeoutError, ValueError, OSError, BybitFailure) as exc:
            last_error = type(exc).__name__
    raise BybitFailure("Нет актуальных котировок Bybit для Spot: " + str(last_error))


def _spot_pnl(portfolio, live_quotes=None):
    """Calculate Spot PNL only from verified prices at the sample timestamp."""
    if not isinstance(portfolio, dict):
        return None
    trades = portfolio.get("trades")
    quotes = live_quotes  # Never fall back to an old browser price.
    if not isinstance(trades, list) or not isinstance(quotes, dict):
        return None
    profit = 0.0
    for trade in trades:
        if not isinstance(trade, dict):
            return None
        coin = trade.get("coin")
        try:
            spent = float(trade.get("spent"))
            entry = float(trade.get("entry"))
        except (TypeError, ValueError):
            return None
        if entry <= 0 or spent < 0:
            return None
        quote = quotes.get(coin)
        price = _num(quote.get("price")) if isinstance(quote, dict) else None
        if price is None or price <= 0:
            return None
        profit += spent / entry * price - spent
    return profit


def sample_history_once():
    """Persist PNL on the VPS every 5 min without any open browser.

    Partial failures never turn an unknown account balance into a fake zero.
    A public Spot price failure cannot erase a valid futures observation.
    """
    try:
        key, secret, _label = credentials()
        extras = saved_state.list_extra_accounts()
        portfolio = saved_state.read_profile().get("portfolio")
        trades = portfolio.get("trades") if isinstance(portfolio, dict) else None
        if not (key and secret) and not extras and not trades:
            return False

        spot = None
        if isinstance(trades, list):
            try:
                spot = _spot_pnl(portfolio, public_spot_quotes(trades))
            except BybitFailure as exc:
                print("Spot PNL sample skipped: " + str(exc)[:140], flush=True)

        futures_parts = []
        account_parts = []
        equity_samples = []
        futures_complete = True
        account_complete = True
        if key and secret:
            try:
                result = snapshot()
                totals = result.get("totals") or {}
                eq = _num(totals.get("equity"))
                if eq is not None and eq >= 0:
                    equity_samples.append({"t": int(time.time()*1000),
                                           "accountId": "bybit-subaccount", "equity": eq})
                v = _num(totals.get("perpUPL"))
                a = _num(totals.get("accountPnl"))
                if v is None:
                    futures_complete = False
                else:
                    futures_parts.append(v)
                if a is None:
                    account_complete = False
                else:
                    account_parts.append(a)
            except BybitFailure:
                futures_complete = False
                account_complete = False
        for item in extras:
            try:
                result = snapshot_extra(item["id"])
                totals = result.get("totals") or {}
                eq = _num(totals.get("equity"))
                if eq is not None and eq >= 0:
                    equity_samples.append({"t": int(time.time()*1000),
                                           "accountId": item["id"], "equity": eq})
                v = _num(totals.get("perpUPL"))
                a = _num(totals.get("accountPnl"))
                if v is None:
                    futures_complete = False
                else:
                    futures_parts.append(v)
                if a is None:
                    account_complete = False
                else:
                    account_parts.append(a)
            except BybitFailure:
                futures_complete = False
                account_complete = False

        if equity_samples:
            # Store individual accounts, never a partial "all accounts" number.
            # Adding a new account must not create a vertical balance jump.
            try:
                saved_state.merge_equity_history(equity_samples)
            except saved_state.StateError as exc:
                print("Equity history sample skipped: " + str(exc)[:140], flush=True)
        futures = sum(futures_parts) if futures_complete and futures_parts else None
        account_pnl = sum(account_parts) if account_complete and account_parts else None
        point = {"t": int(time.time() * 1000)}
        if spot is not None:
            point["spot"] = spot
        if futures is not None:
            point["futures"] = futures  # legacy: floating PNL only
        if account_pnl is not None:
            point["futuresAccount"] = account_pnl
        if spot is not None and futures is not None:
            point["total"] = spot + futures  # legacy: floating PNL only
        if spot is not None and account_pnl is not None:
            point["totalAccount"] = spot + account_pnl
        if len(point) == 1:
            return False
        saved_state.merge_history([point])
        return True
    except Exception as exc:
        print("PNL history sample skipped: " + type(exc).__name__, flush=True)
        return False


def history_sampler():
    # The browser only records while a tab is open, which is not enough for a
    # month chart. This keeps the series alive on the server itself.
    while True:
        sample_history_once()
        time.sleep(HISTORY_SAMPLE_SECONDS)


def main():
    if not PASSWORD or len(PASSWORD) < 16 or PASSWORD.startswith("REPLACE_WITH_"):
        raise SystemExit("FXMR4_PASSWORD must be set to a strong password (16+ chars)")
    if BIND not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("Refusing public bind. Put HTTPS reverse proxy in front of 127.0.0.1.")
    if API_HOST not in ALLOWED_HOSTS:
        raise SystemExit("BYBIT_API_HOST must be an approved official Bybit API host")
    saved_state.is_ready()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    threading.Thread(target=history_sampler, name="pnl-history", daemon=True).start()
    print("FXMR4 private app listening on http://%s:%d" % (BIND, PORT), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
