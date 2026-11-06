#!/usr/bin/env bash
# Safe upgrade after git pull: leaves existing web service on port 8080 alone.
set -Eeuo pipefail
cd /opt/fxmr4
[[ "$(id -u)" == "0" ]] || { echo "Нужен root"; exit 1; }
echo "[1/4] Проверяем код"
python3 -m py_compile backend/server.py backend/state.py
python3 -m unittest discover -s backend -p 'test_*.py' -v
echo "[2/4] Проверяем сохранность старого API"
if [[ ! -s /var/lib/fxmr4/bybit.cred ]] &&
   ! grep -Eq '^BYBIT_SUBACCOUNT_KEY=[^[:space:]]{10,}' /etc/fxmr4/fxmr4.env; then
  echo "СТОП: старый API-ключ не обнаружен на диске. Перезапуск может потерять ключ из RAM."
  echo "Проверь, сохранён ли он на VPS, прежде чем перезапускать."
  exit 1
fi
echo "[3/4] Резервная копия"
umask 077
backup="/root/fxmr4-before-multi-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup"
cp -a /var/lib/fxmr4 "$backup/"
echo "Резервная копия: $backup"
echo "[4/4] Перезапускаем только FXMR4"
systemctl restart fxmr4
systemctl is-active --quiet fxmr4 || { journalctl -u fxmr4 -n 25 --no-pager; exit 1; }
code="$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8768/api/accounts || true)"
[[ "$code" == "401" ]] || { echo "Ошибка проверки нового API: HTTP $code"; exit 1; }
echo "FXMR4 работает. Новый /api/accounts защищён авторизацией (HTTP 401 без входа)."
echo "Старый ключ и покупки не изменены."
