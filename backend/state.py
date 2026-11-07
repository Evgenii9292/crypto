"""Private FXMR4 persistent storage on VPS.

Credentials are AES-256-GCM encrypted under a random key stored separately in
a root-owned systemd EnvironmentFile. Portfolio data is not secret but is
available only through authenticated same-origin endpoints.

Never write keys or passwords to the public git checkout, logs, localStorage
or API responses. The data directory is a private systemd StateDirectory.
"""
from __future__ import annotations

import base64
import json
import math
import os
import secrets
import threading
import time
from pathlib import Path

DATA_DIR = Path(os.environ.get("FXMR4_STATE_DIR", "/var/lib/fxmr4"))
SEAL_KEY_HEX = os.environ.get("FXMR4_SEAL_KEY", "")
LOCK = threading.RLock()
CREDS_PATH = DATA_DIR / "bybit.cred"
EXTRA_ACCOUNTS_PATH = DATA_DIR / "bybit-accounts.cred"
PROFILE_PATH = DATA_DIR / "user-data.json"
HISTORY_PATH = DATA_DIR / "pnl-history.json"
EQUITY_HISTORY_PATH = DATA_DIR / "bybit-equity-history.json"

# PNL history is tiny per point but must outlive one browser: month and half-year
# charts need data the browser no longer holds. Points are compacted into tiers
# so the file stays small while the resolution still fits the chosen window.
HISTORY_MAX_POINTS = 4000
_FIVE_MINUTES = 300_000
_HOUR = 3_600_000
_DAY = 86_400_000


class StateError(Exception):
    pass


def _seal_key():
    if not SEAL_KEY_HEX:
        raise StateError("Не настроен ключ шифрования VPS (FXMR4_SEAL_KEY)")
    try:
        key = bytes.fromhex(SEAL_KEY_HEX)
    except ValueError as exc:
        raise StateError("Некорректный ключ шифрования VPS") from exc
    if len(key) != 32:
        raise StateError("Ключ шифрования должен содержать 32 байта")
    return key


def _cipher():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise StateError("Не установлен python3-cryptography") from exc
    return AESGCM(_seal_key())


def _write_private(path: Path, data: bytes):
    # Caller holds LOCK.
    DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if DATA_DIR.is_symlink():
        raise StateError("Небезопасная папка хранения")
    temporary = DATA_DIR / ("." + path.name + "." + secrets.token_hex(12))
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


ACCOUNT_ICONS = frozenset(("wallet", "trend", "shield", "bot", "activity"))


def validate_account_icon(icon):
    if not isinstance(icon, str) or icon not in ACCOUNT_ICONS:
        raise StateError("Некорректная иконка аккаунта")
    return icon


def write_credentials(key: str, secret: str, label: str, icon=None):
    if not (10 <= len(key) <= 256 and 10 <= len(secret) <= 256):
        raise StateError("Некорректные учётные данные")
    if not isinstance(label, str) or len(label) > 40:
        raise StateError("Некорректное имя субаккаунта")
    profile = {"key": key, "secret": secret, "label": label}
    if icon is not None:
        profile["icon"] = validate_account_icon(icon)
    payload = json.dumps(profile, ensure_ascii=False).encode("utf-8")
    nonce = os.urandom(12)
    encrypted = b"FXMR4v1:" + nonce + _cipher().encrypt(nonce, payload, b"fxmr4-bybit-v1")
    with LOCK:
        _write_private(CREDS_PATH, encrypted)


def read_credentials():
    with LOCK:
        if not CREDS_PATH.is_file():
            return None
        try:
            blob = CREDS_PATH.read_bytes()
            if not blob.startswith(b"FXMR4v1:") or len(blob) < 50:
                raise StateError("Формат зашифрованного ключа не распознан")
            payload = _cipher().decrypt(blob[8:20], blob[20:], b"fxmr4-bybit-v1")
            parsed = json.loads(payload)
            if not (isinstance(parsed, dict) and
                    isinstance(parsed.get("key"), str) and
                    isinstance(parsed.get("secret"), str) and
                    isinstance(parsed.get("label"), str)):
                raise StateError("Неверный формат данных")
            return parsed
        except StateError:
            raise
        except Exception as exc:
            raise StateError("Не удалось расшифровать API-ключ. Проверь ключ шифрования VPS.") from exc


def rename_credentials(label: str, icon=None):
    """Re-encrypt the stored key under a new display label.

    The label is only a name shown in the UI; the key and secret are unchanged.
    Re-encrypting (rather than editing the blob) keeps the file format and the
    authenticated-encryption guarantee intact.
    """
    if not isinstance(label, str):
        raise StateError("Некорректное имя субаккаунта")
    label = label.strip()
    if not (1 <= len(label) <= 40):
        raise StateError("Имя субаккаунта должно быть от 1 до 40 символов")
    with LOCK:
        current = read_credentials()
        if current is None:
            raise StateError("API-ключ ещё не подключён")
        write_credentials(current["key"], current["secret"], label,
                          icon=icon if icon is not None else current.get("icon"))
    return {"label": label}


def delete_credentials():
    with LOCK:
        CREDS_PATH.unlink(missing_ok=True)



def _extra_accounts_locked():
    """Return decrypted extra Bybit accounts. Call only under LOCK."""
    if not EXTRA_ACCOUNTS_PATH.is_file():
        return []
    try:
        blob = EXTRA_ACCOUNTS_PATH.read_bytes()
        prefix = b"FXMR4accounts1:"
        if not blob.startswith(prefix):
            raise StateError("Неизвестный формат субаккаунтов")
        offset = len(prefix)
        decoded = _cipher().decrypt(blob[offset:offset+12], blob[offset+12:], b"fxmr4-bybit-accounts-v1")
        accounts = json.loads(decoded)
        if not isinstance(accounts, list) or any(
            not isinstance(a, dict) or not all(isinstance(a.get(k), str) for k in ("id", "label", "key", "secret"))
            for a in accounts
        ):
            raise StateError("Некорректное состояние субаккаунтов")
        return accounts
    except StateError:
        raise
    except Exception as exc:
        raise StateError("Не удалось расшифровать субаккаунты Bybit") from exc


def _write_extra_locked(accounts):
    """Encrypt every extra account with AES-GCM; never place keys in plain JSON."""
    raw = json.dumps(accounts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    nonce = os.urandom(12)
    payload = b"FXMR4accounts1:" + nonce + _cipher().encrypt(nonce, raw, b"fxmr4-bybit-accounts-v1")
    _write_private(EXTRA_ACCOUNTS_PATH, payload)


def list_extra_accounts():
    """Private server-side credential list; never serialize this API response."""
    with LOCK:
        return _extra_accounts_locked()


def add_extra_account(key, secret, label, uid=None, icon="wallet"):
    if not isinstance(key, str) or not isinstance(secret, str) or not (
        10 <= len(key) <= 256 and 10 <= len(secret) <= 256
    ):
        raise StateError("Неверный API-ключ")
    if not isinstance(label, str) or not (1 <= len(label.strip()) <= 40):
        raise StateError("Укажи имя субаккаунта")
    label = label.strip()
    icon = validate_account_icon(icon)
    with LOCK:
        accounts = _extra_accounts_locked()
        if len(accounts) >= 20:
            raise StateError("Не более 20 субаккаунтов Bybit")
        legacy = read_credentials()
        if (legacy and legacy["key"] == key) or any(item["key"] == key or (uid and item.get("uid") == str(uid)) for item in accounts):
            raise StateError("Этот API-ключ уже подключён")
        account = {"id": "sub-" + secrets.token_hex(12), "label": label, "key": key, "secret": secret, "icon": icon}
        if uid is not None and str(uid).strip():
            account["uid"] = str(uid).strip()[:40]
        _write_extra_locked(accounts + [account])
        return {"id": account["id"], "label": label, "icon": icon}


def rename_extra_account(account_id, label, icon=None):
    if not isinstance(label, str) or not (1 <= len(label.strip()) <= 40):
        raise StateError("Некорректное имя субаккаунта")
    with LOCK:
        accounts = _extra_accounts_locked()
        target = next((a for a in accounts if a["id"] == account_id), None)
        if target is None:
            raise StateError("Субаккаунт не найден")
        target["label"] = label.strip()
        if icon is not None:
            target["icon"] = validate_account_icon(icon)
        _write_extra_locked(accounts)
        return {"id": target["id"], "label": target["label"], "icon": target.get("icon", "wallet")}


def delete_extra_account(account_id):
    with LOCK:
        accounts = _extra_accounts_locked()
        retained = [a for a in accounts if a["id"] != account_id]
        if len(retained) == len(accounts):
            raise StateError("Субаккаунт не найден")
        _write_extra_locked(retained)
        return {"id": account_id}

def read_profile():
    with LOCK:
        if not PROFILE_PATH.is_file():
            return {"revision": 0, "exists": False, "portfolio": None, "levels": None}
        try:
            obj = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise StateError("Ошибка чтения сохранённого портфеля") from exc
        if not isinstance(obj, dict):
            raise StateError("Некорректное состояние портфеля")
        return {"revision": int(obj.get("revision", 0)),
                "exists": True, "portfolio": obj.get("portfolio"),
                "levels": obj.get("levels")}


def write_profile(revision, portfolio, levels):
    if type(revision) is not int or revision < 0:
        raise StateError("Неправильная версия данных")
    if not isinstance(portfolio, dict) or not isinstance(levels, dict):
        raise StateError("Неверный формат данных портфеля")
    if any(k in json.dumps(portfolio).lower() for k in ('"secret"', '"api_key"', '"password"')):
        raise StateError("Секреты нельзя сохранять в данные портфеля")
    # Check size before disk write, avoid memory/disk abuse.
    obj = {"portfolio": portfolio, "levels": levels, "revision": revision + 1}
    raw = json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > 450_000:
        raise StateError("Данные портфеля слишком велики")
    with LOCK:
        current = read_profile()
        if current["revision"] != revision:
            raise StateError("CONFLICT: состояние изменено в другом браузере")
        _write_private(PROFILE_PATH, raw)
    return {"revision": obj["revision"], "saved": True}


def _history_bucket_ms(age_ms):
    """Bucket width for a point of this age.

    Fine while the detail is still visible in the day chart, hourly out to two
    months, daily beyond that. Coarser buckets only ever replace finer ones of
    the same age, so no window loses resolution it already had.
    """
    if age_ms <= 2 * _DAY:
        return _FIVE_MINUTES
    if age_ms <= 60 * _DAY:
        return _HOUR
    return _DAY


def compact_history(points, now_ms=None):
    """Merge points into time buckets, newest value winning inside each bucket.

    A long-lived file must not grow without bound, and it must never silently
    drop the newest reading: an older point inside the same bucket can only fill
    a field the newer one does not carry.
    """
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    merged = {}
    for item in points or []:
        if not isinstance(item, dict):
            continue
        try:
            t = int(item.get("t"))
        except (TypeError, ValueError):
            continue
        values = {}
        for key in ("spot", "futures", "total", "futuresAccount", "totalAccount"):
            raw = item.get(key)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value != value or value in (float("inf"), float("-inf")):
                continue
            values[key] = value
        if not values:
            continue
        bucket = _history_bucket_ms(max(0, now - t))
        key = (t // bucket) * bucket
        current = merged.setdefault(key, {"t": key})
        if t >= current.get("_newest", -1):
            current["_newest"] = t
            current.update(values)
        else:
            for name, value in values.items():
                current.setdefault(name, value)
    out = []
    for point in sorted(merged.values(), key=lambda row: row["t"]):
        point.pop("_newest", None)
        out.append(point)
    if len(out) > HISTORY_MAX_POINTS:
        out = out[-HISTORY_MAX_POINTS:]
    return out


def read_history():
    with LOCK:
        if not HISTORY_PATH.is_file():
            return {"points": []}
        try:
            obj = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise StateError("Ошибка чтения истории PNL") from exc
        points = obj.get("points") if isinstance(obj, dict) else None
        if not isinstance(points, list):
            raise StateError("Некорректная история PNL")
        return {"points": points}


def _clean_history_point(item):
    """Validate one client reading and drop nothing silently.

    A reading that carries no number is not a zero reading: turning it into zero
    would invent PNL out of a failed sync. Malformed input rejects the whole
    batch, and the check runs before anything is written, so a bad request can
    never damage the stored series.
    """
    if not isinstance(item, dict):
        raise StateError("Неверный формат точки истории PNL")
    try:
        moment = int(item.get("t"))
    except (TypeError, ValueError):
        raise StateError("В точке истории PNL нет времени")
    point = {"t": moment}
    for key in ("spot", "futures", "total", "futuresAccount", "totalAccount"):
        raw = item.get(key)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise StateError("Некорректное значение в истории PNL")
        if not math.isfinite(value):
            raise StateError("Некорректное значение в истории PNL")
        point[key] = value
    if len(point) == 1:
        raise StateError("В точке истории PNL нет значений")
    return point


def merge_history(points):
    """Append client readings to the durable series.

    The client never replaces the file: it only contributes points, so history
    collected by one browser (or an earlier one) is not wiped by the next.
    """
    if not isinstance(points, list):
        raise StateError("Неверный формат истории PNL")
    if len(points) > 5000:
        raise StateError("Слишком много точек истории PNL")
    clean = [_clean_history_point(item) for item in points]
    with LOCK:
        existing = read_history()["points"]
        if not clean:
            return {"points": len(existing)}
        merged = compact_history(existing + clean)
        raw = json.dumps({"points": merged}, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":")).encode("utf-8")
        _write_private(HISTORY_PATH, raw)
    return {"points": len(merged)}



def read_equity_history():
    """Historical *observed* UTA equity, never transaction-log cash balance.

    Existing 90-day equity history cannot be backfilled by the wallet endpoint.
    Only authenticated API snapshots collected since this feature was enabled
    are included. Values and account IDs are private to this server.
    """
    with LOCK:
        if not EQUITY_HISTORY_PATH.is_file():
            return {"points": []}
        try:
            raw = json.loads(EQUITY_HISTORY_PATH.read_text(encoding="utf-8"))
            rows = raw.get("points") if isinstance(raw, dict) else None
            if not isinstance(rows, list):
                raise ValueError("not list")
            return {"points": rows}
        except (OSError, UnicodeError, ValueError) as exc:
            raise StateError("История стоимости субаккаунтов повреждена") from exc


def merge_equity_history(points):
    if not isinstance(points, list) or len(points) > 100:
        raise StateError("Некорректный пакет стоимости субаккаунтов")
    clean = []
    now = int(time.time() * 1000)
    for item in points:
        if not isinstance(item, dict):
            raise StateError("Некорректный снимок баланса")
        try:
            t = int(item.get("t"))
            account_id = str(item.get("accountId") or "").strip()
            equity = float(item.get("equity"))
        except (ValueError, TypeError) as exc:
            raise StateError("В снимке баланса не хватает полей") from exc
        if not (1000000000000 <= t <= now + 60000 and
                1 <= len(account_id) <= 100 and
                math.isfinite(equity) and equity >= 0):
            raise StateError("Недопустимое значение снимка баланса")
        clean.append({"t": t, "accountId": account_id, "equity": round(equity, 8)})
    if not clean:
        return {"points": 0}
    with LOCK:
        existing = read_equity_history()["points"]
        combined = {}
        for row in existing + clean:
            try:
                t = int(row["t"])
                account = str(row["accountId"])
                equity = float(row["equity"])
            except (KeyError, ValueError, TypeError):
                continue
            if not math.isfinite(equity) or equity < 0:
                continue
            bucket = _history_bucket_ms(max(0, now-t))
            k = (account, t//bucket*bucket)
            previous = combined.get(k)
            if previous is None or t>=previous["t"]:
                combined[k] = {"t": t, "accountId": account, "equity": round(equity, 8)}
        rows = sorted(combined.values(), key=lambda row:(row["t"], row["accountId"]))[-50000:]
        raw = json.dumps({"points": rows}, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":")).encode("utf-8")
        _write_private(EQUITY_HISTORY_PATH, raw)
        return {"points": len(rows)}


def is_ready():
    _cipher()
    return True
