# FXMR4 · Design system v1.2

**Основной файл стилей: [styles.css](./styles.css)**. Текущие цвета, системный шрифт, пропорции карточек и иконки остаются базой для всех новых экранов.

## Визуальная база (без изменений)

- Системный шрифт: `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", sans-serif`.
- Основные цвета: фон `#fafbfc`, карточки `#ffffff`, вторичная поверхность `#f5f6f8`, обводка `#e6e8ec`.
- Текст: `#22262e`, вспомогательный `#666f7b`, muted `#858d99`.
- PNL: плюс `#168c58`, минус `#dc4d52`.
- Монеты: BTC `#f2a23a`, ETH `#7c8de8`, резерв `#8993a3`.
- Радиусы: карточки 16 px, оболочка 22 px, кнопки 9 px.
- Отступы компактные, в основном 10–20 px. Линии иконок тонкие: 1.8.

## Навигация v1.2

Главное левое меню на десктопе и горизонтальные вкладки на телефоне:
1. **Обзор:** известный капитал и его PNL, отдельно Spot/Futures; PNL-график Spot; раскрывающиеся биржи, затем аккаунты, затем позиции.
2. **Spot:** капитал в ручном учёте, список BTC/ETH, подробности монеты, резерв, рыночные котировки, встроенная история покупок с формой добавления/правки/удаления.
3. **Futures:** депозит/PNL/позиции для всех бирж (пока не подключены), место под будущий график, режимы «Все позиции / По биржам / По субаккаунтам», сортировка, добавление названий бирж и субаккаунтов. Нет фиктивных сумм.

**Подключения** доступны отдельной кнопкой, не занимают основной раздел меню.

## Ответственные расчёты и безопасное хранение

- До подключения Futures **нельзя** показывать Spot как суммарный капитал всех бирж.
- `—` означает отсутствие данных, а не $0 или нулевой PNL.
- Первые покупки BTC и ETH по $25 имеют предварительные даты и цены до подтверждения.
- Спотовый капитал $1000 является **выделенным бюджетом ручного учёта**, не подтверждённым биржевым балансом.
- Ручные покупки, источники/названия субаккаунтов и история котировок сохраняются в **localStorage** одного браузера, через прежний ключ: `fxmr4_portfolio_public_preview_v1`.
- Спотовые публичные цены загружаются при открытии, по кнопке и каждые 60 сек при видимой вкладке. Пробуются официальные Bybit ID, global, bytick; резервные публичные источники помечаются отдельно. В браузере возможны CORS/региональные блокировки.
- PNL-график основан на реальных сохранённых наблюдениях. У осей подписаны USD и даты; вымышленных точек нет.

## Следующий этап

- Защищённый backend + HTTPS + авторизация, раздельные read-only ключи каждой биржи и субаккаунта, IP allowlist.
- API кошельков/позиций и реальные прибыли, комиссии и активы. Нужна защита от двойного счёта при Unified Trading Account.
- Отдельные PNL-истории Spot/Futures, фильтрация, загрузка Veles/ботов.
- Только после отдельного согласования можно рассматривать торговые действия, с собственными правами и подтверждением. Нынешняя версия **не отправляет ордера и не управляет средствами**.

Version: 1.2 · 6 Nov 2026.

## Spot levels (v1.3)

`levels.js` и `levels.css` развивают тот же визуальный стиль, не переписывая основные CSS-токены.

- BTC/USDT и ETH/USDT имеют отдельные графики цены в Spot. История свечей запрашивается из публичного `/v5/market/kline` Bybit (Spot); при недоступности используется CryptoCompare, если доступен.
- BTC: исходная пользовательская ориентировочная **зона $75,000–$70,000**, по умолчанию две редактируемые линии. Конкретные суммы на каждую линию **не были указаны**, поэтому не выдумываются.
- ETH: пользователь не указал конкретные ценовые уровни, начально список пустой, доступны добавление/правка/удаление.
- Прогресс отображает цену уровня, расстояние в % от текущего котируемого курса, планируемую сумму в USD, свободный лимит монеты.
- Переход котировки через уровень подсвечивается. Уведомление браузера возможно только после явного разрешения и пока приложение открыто; ни Telegram, ни push без сервера не подключены.
- Новые уровни живут отдельно под ключом `fxmr4_spot_levels_v1` в `localStorage`; исходный список покупок не меняется, уровни сами по себе не выполняют сделок.
- Если реальная история свечей недоступна, показываются только честные текущие котировки и горизонтальные уровни без искусственной ценовой кривой.

**Стратегия на присланных скриншотах:** 50% капитала первоначально, остальные 50% в резерв; далее 10% от *резервной* половины (следовательно, всего задействовано 55%, хотя автор поста написал 60%). Это референс, а не автоматическое правило исполнения или подтверждение фактического инвестирования пользователя.

## v1.5 · Overview / settings changes (2026-11-06)

- Overview hero: invested Spot purchase cost **plus confirmed Bybit position initial margin** (`positionIM`), not the entire planned $1,000 capital or total UTA equity. When Bybit margin is unavailable, show `—`, not a fabricated number. Total live PNL = manual Spot floating PNL + Bybit `totalPerpUPL`, when both are available.
- The right-hand Spot and Futures summary tiles still show the two separate balances. User-facing labels remove internal UTA and Read-Only jargon; the conceptual difference remains documented internally.
- Portfolio PNL chart filters: `Все / Спот / Фьючерсы` and `24h / 7d / 30d / 90d`. Combined/Futures graphs use recorded live browser snapshots only. They do not synthesize history before initial API connection.
- Move the spot asset-allocation bar to the Spot tab. Navigation renamed to `Обзор / Спот / Фьючерсы`.
- Sidebar `Настройки` opens `Подключения / Капитал`. The latter manages planned Spot budget in localStorage and keeps half the budget for each coin. A responsive Settings button is included on mobile.
- Each account row shows current floating PNL and an all-time PNL placeholder. **All-time PNL remains unavailable until the full historical ledger is imported**; `cumRealisedPnl` on currently open positions alone is not an all-account history.
- Local manually added subaccounts can be removed after confirmation in Settings. The connected API subaccount can be disconnected through an authenticated server endpoint; no trading API or Bybit account deletion is performed.
- Chevrons use small centered CSS-drawn rounded-angle strokes, not the old large `⌄` glyph.
- The private backend now exposes `positionIM` and `cumRealisedPnl`; the latter is not misrepresented as full account lifetime PNL. Updating the running Python service requires a restart; credentials that were input only into RAM must be reentered.
