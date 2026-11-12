# Changelog

## 1.5.0
- Added a full-featured **Bitrix24 Chats** tab in the MeshCentral left sidebar (`#page_leftbar`) displaying all recent Bitrix24 chats (`im.recent.list`) with search, unread filter, full message history, linked PC quick-jump buttons, and unread counter badge.
- Added unread highlighting for synced computers in the MeshCentral device list (`#xdevices`): device rows and icons glow/highlight with a clickable unread count badge (`💬 N`) when their matched Bitrix24 contact has unread messages (unsynced computers are not highlighted).
- Enabled automatic read confirmation (`im.dialog.read`) whenever a chat is opened in either the left Chats tab or the Device Summary mini-chat.

## 1.4.0
- Added manual device-to-Bitrix24 user binding in the plugin settings modal (`⚙`) and quick **«Привязать вручную»** button when automatic matching finds no profile.
- Added searchable Bitrix24 user picker and management list of all manual bindings stored persistently in `b24contacts-settings.json` (`manualLinks`).
- Added `ручная привязка` badge on manually linked Device Summary cards and preserved manual links across general settings updates.

## 1.3.1
- Fixed HTTP 404 on `/plugin/b24contacts/oauth/callback` by promoting plugin HTTP routes right after `query`/`expressInit` (supports both Express 4 and Express 5 router stacks), registering `/*/plugin/b24contacts/oauth/callback`, registering on both `server.webserver.app` and `server.app`, and versioning the route registration flag (`ROUTES_VERSION`) so upgrades do not skip new routes.
- Added Bitrix24 `server_domain` handling (e.g. `oauth.bitrix24.tech` / `oauth.bitrix.info`, strictly allowlisted) and `client_endpoint` persistence for OAuth token exchange and automatic token refresh.

## 1.3.0
- Added embedded 4-message Bitrix24 mini-chat right next to the pharmacy phones on the Device Summary card.
- Added per-user Bitrix24 authentication (each MeshCentral user logs in with their own Bitrix24 account via OAuth 2.0 Local Application or personal webhook, stored encrypted per user with AES-256-GCM).
- Added OAuth 2.0 Client ID / Secret settings and Redirect URI display in the admin settings modal.

## 1.2.0
- Added direct Bitrix24 Chat (`/online/?IM_DIALOG=<ID>`) and Profile (`/company/personal/user/<ID>/`) links to the Device Summary contacts card.

## 1.1.2
- Placed the contacts card at the top of `#p10info` (immediately above the Summary table / below action buttons) instead of the bottom below graphs.
- Fixed stale card state when returning to a device Summary tab after configuring the Bitrix24 webhook from My Account.

## 1.1.1
- Normalized sample method suffixes (e.g. `/profile.json`) when pasting URLs from Bitrix24's webhook request generator.

## 1.1.0
- Moved all frontend UI directly into `onWebUIStartupEnd` so the plugin works immediately without depending on extra `/plugin/...` HTTP static script routes.
- Added **Настройка Битрикс24 (Контакты)** link in **Моя учетная запись → Действия учетной записи** (`#p2AccountActions`) and quick `⚙` setup button in the Device Summary card.
- Added persistent admin settings storage (`meshcentral-data/b24contacts-settings.json`), instant Bitrix24 cache sync on save, and a built-in matching tester inside the settings modal.
- Added `PERSONAL_PHONE` and `UF_PHONE_INNER` fallback extraction in addition to `WORK_PHONE` and `PERSONAL_MOBILE`.

## 1.0.0
- Initial release of `meshcentral-b24-contacts` (`b24contacts`).
- Bitrix24 `user.get` webhook integration with pagination and in-memory cache (90-minute refresh by default).
- Fuzzy & token-based pharmacy address matching between MeshCentral device names and Bitrix24 user profiles.
- Device Summary (`#p10`) DOM injection with loading indicator, `tel:` links, SVG phone icons, and empty/error states.
