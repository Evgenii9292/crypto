#!/usr/bin/env bash
# One-time FXMR4 upgrade to private encrypted storage and public HTTPS.
# Run as root on VPS AFTER git pull. Leaves port 8080 untouched.
set -Eeuo pipefail
DOMAIN="fxmr4-144-31-38-125.sslip.io"
IP="144.31.38.125"
REPO="/opt/fxmr4"
ENVFILE="/etc/fxmr4/fxmr4.env"
CADDY="/etc/caddy/Caddyfile"
SERVICE="/etc/systemd/system/fxmr4.service"
BACKUP="/etc/caddy/Caddyfile.backup.fxmr4.$(date +%Y%m%d%H%M%S)"

if [[ "$(id -u)" != "0" ]]; then echo "Нужен root"; exit 1; fi
if [[ ! -f "$REPO/backend/state.py" ]]; then echo "Сначала: git pull --ff-only"; exit 1; fi
if [[ ! -f "$ENVFILE" || ! -f "$CADDY" ]]; then echo "Не найдена конфигурация FXMR4 или Caddy"; exit 1; fi
if ! id fxmr4 >/dev/null 2>&1; then echo "Пользователь fxmr4 не найден"; exit 1; fi

echo "[1/6] Проверяем DNS бесплатного адреса"
resolved="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')" || true
if [[ "$resolved" != "$IP" ]]; then
  echo "DNS $DOMAIN вернул '$resolved' вместо $IP. Конфигурацию не меняем."
  exit 1
fi
echo "$DOMAIN -> $resolved"

echo "[2/6] Библиотека шифрования"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y python3-cryptography >/dev/null
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM; print('AES-GCM: OK')"
python3 -m unittest discover -s "$REPO/backend" -p 'test_*.py' -q

echo "[3/6] Сохраняем старый пароль, добавляем ключ шифрования"
chmod 600 "$ENVFILE"
chown root:root "$ENVFILE"
if ! grep -q '^FXMR4_SEAL_KEY=' "$ENVFILE"; then
  printf '\nFXMR4_SEAL_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ENVFILE"
fi
install -d -m 0700 -o fxmr4 -g fxmr4 /var/lib/fxmr4
install -m 0644 "$REPO/deploy/fxmr4.service" "$SERVICE"

echo "[4/6] Настраиваем HTTPS через Caddy"
cp -p "$CADDY" "$BACKUP"
if grep -q 'bybitapi.vps.oblako.sh' "$CADDY" && ! grep -q "$DOMAIN" "$CADDY"; then
  sed -i "s/bybitapi.vps.oblako.sh/$DOMAIN/g" "$CADDY"
elif ! grep -q "$DOMAIN" "$CADDY"; then
  cat >> "$CADDY" <<EOF

$DOMAIN {
  reverse_proxy 127.0.0.1:8768 {
    header_up X-Forwarded-Proto https
  }
}
EOF
fi
if ! caddy validate --config "$CADDY" >/dev/null; then
  echo "Ошибка конфигурации Caddy. Восстанавливаем копию $BACKUP"
  cp -p "$BACKUP" "$CADDY"
  exit 1
fi

echo "[5/6] Перезапускаем только FXMR4 и перечитываем Caddy"
systemctl daemon-reload
systemctl restart fxmr4
if ! systemctl is-active --quiet fxmr4; then
  journalctl -u fxmr4 -n 25 --no-pager
  exit 1
fi
systemctl reload caddy || systemctl restart caddy
echo "FXMR4: $(systemctl is-active fxmr4), Caddy: $(systemctl is-active caddy)"
for i in {1..10}; do
  if [[ "$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8768/api/status || true)" == "401" ]]; then
    echo "FXMR4 backend: HTTP 401 (авторизация включена)"
    break
  fi
  sleep 1
done

echo "[6/6] Проверяем сертификат"
code="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "https://$DOMAIN" 2>/dev/null || true)"
if [[ "$code" == "401" ]]; then
  echo "HTTPS работает: HTTP 401 (авторизация включена)"
else
  echo "HTTPS пока не подтверждён: HTTP $code"
  echo "Для диагностики: journalctl -u caddy -n 35 --no-pager"
fi
echo
echo "Сайт: https://$DOMAIN"
echo "Логин FXMR4: fxmr4"
echo "Пароль: прежний FXMR4_PASSWORD в /etc/fxmr4/fxmr4.env"
echo "Данные и зашифрованный API-ключ: /var/lib/fxmr4"
echo "Старый сервис на порту 8080 НЕ затронут."
