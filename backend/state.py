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
import os
import secrets
import threading
from pathlib import Path

DATA_DIR = Path(os.environ.get("FXMR4_STATE_DIR", "/var/lib/fxmr4"))
SEAL_KEY_HEX = os.environ.get("FXMR4_SEAL_KEY", "")
LOCK = threading.RLock()
CREDS_PATH = DATA_DIR / "bybit.cred"
PROFILE_PATH = DATA_DIR / "user-data.json"


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


def write_credentials(key: str, secret: str, label: str):
    if not (10 <= len(key) <= 256 and 10 <= len(secret) <= 256):
        raise StateError("Некорректные учётные данные")
    if not isinstance(label, str) or len(label) > 40:
        raise StateError("Некорректное имя субаккаунта")
    payload = json.dumps({"key": key, "secret": secret, "label": label},
                         ensure_ascii=False).encode("utf-8")
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


def delete_credentials():
    with LOCK:
        CREDS_PATH.unlink(missing_ok=True)


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


def is_ready():
    _cipher()
    return True
