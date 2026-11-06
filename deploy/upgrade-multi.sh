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
# HTTP 401 alone is insufficient: the OLD server also returns 401 for unknown paths.
# Authenticate to test the actual new API. Feed credentials via curl stdin,
# never echo them or put them in process arguments.
auth_user="$(sed -n 's/^FXMR4_USER=//p' /etc/fxmr4/fxmr4.env | tail -n 1)"
auth_pass="$(sed -n 's/^FXMR4_PASSWORD=//p' /etc/fxmr4/fxmr4.env | tail -n 1)"
auth_user="${auth_user:-fxmr4}"
if [[ -z "$auth_pass" ]]; then
  echo "Пароль FXMR4 отсутствует в env, проверь конфигурацию"; exit 1
fi
api_result="$(printf 'user = "%s:%s"\\n' "$auth_user" "$auth_pass" |
  curl --fail --silent --show-error --max-time 12 --config - http://127.0.0.1:8768/api/accounts)"
printf '%s' "$api_result" | python3 -c 'import json,sys; obj=json.load(sys.stdin); assert isinstance(obj.get("accounts"),list), "Новый API не отвечает"; print("API субаккаунтов работает, число подключений:",len(obj["accounts"]))'
ui="$(printf 'user = "%s:%s"\\n' "$auth_user" "$auth_pass" |
  curl --fail --silent --show-error --max-time 10 --config - http://127.0.0.1:8768/)"
printf '%s' "$ui" | grep -q 'fxmr4-ui-release' || { echo "ОШИБКА: VPS показывает старый index.html"; exit 1; }
js="$(printf 'user = "%s:%s"\\n' "$auth_user" "$auth_pass" |
  curl --fail --silent --show-error --max-time 10 --config - http://127.0.0.1:8768/bybit-account.js)"
printf '%s' "$js" | grep -q 'bybitExchangeBadge' || { echo "ОШИБКА: на VPS старый bybit-account.js"; exit 1; }
unset auth_pass auth_user api_result ui js
echo "Готово: обновлённый интерфейс и новый API реально отдаются VPS."
echo "Сохранённые API-ключи и покупки не изменены."
