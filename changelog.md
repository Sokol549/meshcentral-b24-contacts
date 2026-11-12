# Changelog

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
