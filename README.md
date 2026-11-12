# meshcentral-b24-contacts (`b24contacts`)

Плагин для MeshCentral, который отображает контактные телефоны аптеки из Битрикс24 прямо на вкладке **«Сводка» (Summary / General)** карточки устройства.

## Особенности
- Подключается к REST API Битрикс24 через входящий вебхук (`user.get`, только активные пользователи `ACTIVE: true`).
- Загружает и кеширует справочник пользователей в оперативной памяти сервера (In-Memory кеш, по умолчанию обновление при старте и далее каждые 90 минут), поддерживая пагинацию Битрикс24 (`next` / `start`).
- Устойчивое сопоставление названий устройств из MeshCentral и профилей аптек в Битрикс24 с удалением префиксов (`ст.`, `г.`, `ул.`, `д.`, `ВА |`), суффиксов касс и отделов (`касса`, `ИБ`, `ЮБ`), нормализацией `ё -> е`, нечётким сравнением токенов и защитой от ложных совпадений по разным номерам домов.
- Безопасный интерфейс: при сбоях сети/API Битрикс24 сервер MeshCentral продолжает работу в штатном режиме, сохраняется последний удачный кеш, а в интерфейсе отображается состояние загрузки, кликабельные ссылки `tel:` или статус «Связанный профиль в Битрикс24 не найден».

---

## Важное примечание по имени папки плагина в MeshCentral

Ядро MeshCentral (`pluginHandler.js`) при передаче клиентских хуков в браузер генерирует JavaScript-код вида `obj.<shortName> = {};` и загружает модуль по пути `plugins/<shortName>/<shortName>.js`.  
Поскольку дефис `-` недопустим в идентификаторах JavaScript (`obj.meshcentral-b24-contacts` вызовет `SyntaxError` в браузере), внутри каталога MeshCentral папка и главный файл должны называться **`b24contacts`** и **`b24contacts.js`** (аналогично плагинам `zabbix`, `restic`, `routeplus`).

---

## Установка (ручная)

1. Определите расположение каталога `meshcentral-data` на сервере MeshCentral (обычно `/opt/meshcentral/meshcentral-data` в Linux или `C:\meshcentral\meshcentral-data` в Windows).
2. Создайте папку `b24contacts` внутри `meshcentral-data/plugins/`:
   - Linux: `/opt/meshcentral/meshcentral-data/plugins/b24contacts/`
   - Windows: `C:\meshcentral\meshcentral-data\plugins\b24contacts\`
3. Скопируйте в неё файлы плагина со следующей структурой:
   ```text
   meshcentral-data/
   ├── config.json
   └── plugins/
       └── b24contacts/
           ├── b24contacts.js
           ├── config.json
           └── changelog.md
   ```
   *(На Linux при необходимости выдайте права пользователю, от которого работает сервис MeshCentral: `chown -R meshcentral:meshcentral /opt/meshcentral/meshcentral-data/plugins/b24contacts`.)*

---

## Настройка через Web-интерфейс MeshCentral (рекомендуется)

1. Установите и включите плагин в **My Server → Plugins** по URL:
   `https://raw.githubusercontent.com/Sokol549/meshcentral-b24-contacts/main/config.json`
2. Обновите страницу браузера (`Ctrl+F5`).
3. Перейдите в **Моя учетная запись → Действия учетной записи → Настройка Битрикс24 (Контакты)** (или нажмите кнопку **⚙ / Настроить подключение Битрикс24** прямо в карточке на вкладке «Сводка» любого компьютера).
4. Вставьте URL входящего вебхука Битрикс24 (например `https://portal.bitrix24.ru/rest/1/ваш_токен/`), при необходимости настройте интервал обновления и нажмите **«Сохранить и синхронизировать»**. Настройки сохраняются на сервере в `meshcentral-data/b24contacts-settings.json` с правами доступа `0600` и применяются сразу без перезапуска MeshCentral.

---

## Настройка `config.json` MeshCentral (опционально)

Откройте основной файл конфигурации `meshcentral-data/config.json` и добавьте в секцию `"settings"` блок `"plugins"` с включением плагинов, списком `"list"` (для ручной установки) и настройками `"b24contacts"`:

```json
{
  "settings": {
    "cert": "mesh.example.ru",
    "plugins": {
      "enabled": true,
      "list": [
        "b24contacts"
      ],
      "b24contacts": {
        "webhookUrl": "https://your-portal.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/",
        "cacheTtlMinutes": 90,
        "minMatchScore": 0.55,
        "requestTimeoutMs": 15000,
        "rejectUnauthorized": true
      }
    }
  }
}
```

### Параметры `b24contacts`
| Параметр | По умолчанию | Описание |
|---|---|---|
| `webhookUrl` | — (обязательно) | URL входящего вебхука Битрикс24 с правами на чтение пользователей (`user`), например `https://portal.bitrix24.ru/rest/1/token/`. |
| `cacheTtlMinutes` | `90` | Интервал фонового обновления кеша в минутах (от `5` до `1440`; 60–120 мин соответствует 1–2 часам). |
| `minMatchScore` | `0.55` | Порог уверенности нечёткого сопоставления (`0.2`–`0.95`). |
| `requestTimeoutMs` | `15000` | Таймаут HTTP-запроса одной страницы `user.get` (мс). |
| `rejectUnauthorized` | `true` | Проверка TLS-сертификата (поставьте `false`, только если используется коробочный Битрикс24 с самоподписанным сертификатом). |

> **Примечание:** если вы уже используете другие плагины в `settings.plugins.list`, просто добавьте `"b24contacts"` в существующий массив. Если плагины у вас устанавливаются через Web-интерфейс (**My Server → Plugins**), блок `"list"` можно не указывать — достаточно `"enabled": true` и секции `"b24contacts"`.

---

## Перезапуск MeshCentral

После копирования файлов и сохранения `config.json` перезапустите сервер MeshCentral:

- **systemd (Linux):**
  ```bash
  sudo systemctl restart meshcentral
  ```
- **PM2:**
  ```bash
  pm2 restart meshcentral
  ```
- **Docker:**
  ```bash
  docker restart meshcentral
  ```
- **Windows-служба:**
  ```powershell
  Restart-Service MeshCentral
  ```
- **Через Web-интерфейс:** *My Server → Server Actions → Restart Server*.

---

## Проверка работы и логов

1. **Логи сервера (поиск строк с префиксом `[b24contacts]`):**
   - systemd (Linux):
     ```bash
     sudo journalctl -u meshcentral -f | grep b24contacts
     ```
   - PM2:
     ```bash
     pm2 logs meshcentral --lines 100
     ```
   - Docker:
     ```bash
     docker logs -f meshcentral 2>&1 | grep b24contacts
     ```
   При успешном запуске в логах появятся сообщения (токен вебхука автоматически маскируется звёздочками `***`):
   ```text
   [b24contacts] Плагин запущен. TTL кеша: 90 мин. Webhook: https://portal.bitrix24.ru/rest/1/***/
   [b24contacts] HTTP-маршруты плагина зарегистрированы.
   [b24contacts] Обновление кеша пользователей Битрикс24 (startup), webhook: https://portal.bitrix24.ru/rest/1/***/
   [b24contacts] Кеш обновлён: загружено 245 активных профилей за 842 мс.
   ```
2. **Проверка в браузере:**
   - Обновите страницу MeshCentral (`Ctrl+F5`).
   - Откройте любое устройство → вкладка **Сводка (General)**.
   - Под блоком сведений устройства должен появиться блок **«Контакты аптеки (Битрикс24)»** с индикатором загрузки, а затем с найденными телефонами (`tel:` ссылки) или сообщением `Связанный профиль в Битрикс24 не найден`.
