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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
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
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


class BybitFailure(Exception):
    pass


def credentials():
    with LOCK:
        key = EPHEMERAL["key"] or os.environ.get("BYBIT_SUBACCOUNT_KEY", "")
        secret = EPHEMERAL["secret"] or os.environ.get("BYBIT_SUBACCOUNT_SECRET", "")
        label = EPHEMERAL["label"] if EPHEMERAL["key"] else os.environ.get("BYBIT_SUBACCOUNT_LABEL", "Subaccount")
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
                        "account": label, "exchange": "Bybit", "readOnly": True})
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
        if self.path not in ("/api/connect", "/api/disconnect"):
            self._json({"error": "Not found"}, 404)
            return
        if not self._same_origin_action():
            self._json({"error": "Invalid request origin"}, 403)
            return
        if self.path == "/api/disconnect":
            with LOCK:
                if os.environ.get("BYBIT_SUBACCOUNT_KEY") or os.environ.get("BYBIT_SUBACCOUNT_SECRET"):
                    self._json({"error": "Ключ задан в конфигурации VPS. Удали его там и перезапусти службу."}, 409)
                    return
                EPHEMERAL.update({"key": None, "secret": None, "label": "Subaccount"})
                CACHE.update({"at": 0.0, "data": None})
            self._json({"connected": False, "disconnected": True})
            return
        # Secrets must NEVER traverse the internet in cleartext.
        local = self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")
        if not local and self.headers.get("X-Forwarded-Proto") != "https":
            self._json({"error": "HTTPS required"}, 403)
            return
        try:
            body_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json({"error": "Invalid content length"}, 400)
            return
        if not 1 <= body_length < 5000:
            self._json({"error": "Invalid content length"}, 400)
            return
        try:
            data = json.loads(self.rfile.read(body_length))
            key = str(data.get("key", "")).strip()
            secret = str(data.get("secret", "")).strip()
            label = str(data.get("label", "Subaccount")).strip()[:40] or "Subaccount"
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
            self._json({"error": "Invalid JSON"}, 400)
            return
        if not (10 <= len(key) <= 256 and 10 <= len(secret) <= 256):
            self._json({"error": "Invalid key/secret length"}, 400)
            return
        # Validate BEFORE activating credentials, do not store on disk.
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
        with LOCK:
            EPHEMERAL.update({"key": key, "secret": secret, "label": label})
            CACHE.update({"at": 0.0, "data": None})
        self._json({"connected": True, "account": label,
                    "message": "Ключ проверен. Хранится только в памяти процесса до перезапуска."})


def main():
    if not PASSWORD or len(PASSWORD) < 16 or PASSWORD.startswith("REPLACE_WITH_"):
        raise SystemExit("FXMR4_PASSWORD must be set to a strong password (16+ chars)")
    if BIND not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("Refusing public bind. Put HTTPS reverse proxy in front of 127.0.0.1.")
    if API_HOST not in ALLOWED_HOSTS:
        raise SystemExit("BYBIT_API_HOST must be an approved official Bybit API host")
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print("FXMR4 private app listening on http://%s:%d" % (BIND, PORT), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
