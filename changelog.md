# Changelog

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
