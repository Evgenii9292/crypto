# FXMR4 · Design system v1.1

This document fixes the visual baseline for the portfolio web app. The canonical stylesheet is [styles.css](./styles.css). Keep these tokens consistent when adding screens.

## Foundation
- Typography: native `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", sans-serif`, 14px base and 1.45 line height.
- Light background `#fafbfc`, white cards `#ffffff`, secondary surface `#f5f6f8`, subtle borders `#e6e8ec`.
- Primary text `#22262e`; subdued `#666f7b`; muted `#858d99`.
- Positive PNL `#168c58`; negative PNL `#dc4d52`.
- Asset accents: BTC `#f2a23a`, ETH `#7c8de8`, reserved capital `#8993a3`.
- Cards: 16px radius; main app shell: 22px radius; buttons: 9px radius.
- Spacing is intentionally compact, with 10–20px card/grid gaps; retain original icon weight (1.8).

## Responsive behavior
- Desktop >960px: 238px persistent left sidebar, 2-column overview and 2-column positions if there is room.
- Mobile/tablet: compact horizontal 5-tab navigation, original small-card behavior, no sidebar column.
- The theme honors system dark mode and reduced-motion preferences.
- Always distinguish a missing account connection from an actual zero balance.

## Data semantics and security
- `Overview / Spot / Purchases` show manually recorded assets, with gains calculated using saved entry costs.
- `Trading / Futures / Bots` currently intentionally have no account data; placeholders are not balances.
- Public spot price updates: on load, on demand, and every 60 seconds while the page is visible; fallback providers are labeled.
- Entries and PNL observations currently live in the browser's local storage. They are not synced across devices.
- Never commit or collect Bybit API secrets in GitHub Pages. Implement read-only authenticated access through a private backend first.
- Public prices may differ from real executions; the first two purchases ($25 each) have provisional entry costs and dates until verified.

## Integration plan
1. Private backend with HTTPS, authentication, encrypted key storage, Bybit read-only permissions and server IP allowlisting.
2. Read wallet balances and spot transactions, reconstruct accurate cost basis and fees.
3. Read futures positions, realized/unrealized PNL, then add bot integrations.
4. Mark all data sources, update times and synchronization errors clearly in the UI.

No trading, order placement, transfers or withdrawals are part of this design.
