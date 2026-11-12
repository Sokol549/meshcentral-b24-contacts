'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PLUGIN_NAME = 'b24contacts';
const DEFAULT_CACHE_TTL_MINUTES = 90;
const DEFAULT_MIN_MATCH_SCORE = 0.55;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_DELAY_MS = 250;
const MAX_PAGES = 500;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const ERROR_RETRY_COOLDOWN_MS = 60000;

// Address, device-role, and department noise tokens stripped during matching.
const HARD_STOP_WORDS = new Set([
    'г', 'город', 'ст', 'ст-ца', 'станица', 'с', 'село', 'п', 'пос', 'поселок',
    'пгт', 'рп', 'х', 'хут', 'хутор', 'аул', 'дп', 'р-н', 'район', 'обл', 'область', 'край',
    'ул', 'улица', 'пер', 'переулок', 'пр', 'пр-т', 'пр-кт', 'просп', 'проспект',
    'проезд', 'б-р', 'бул', 'бульвар', 'ш', 'шоссе', 'туп', 'тупик', 'наб', 'набережная',
    'пл', 'площадь', 'мкр', 'мкр-н', 'микрорайон', 'кв-л', 'квартал',
    'д', 'дом', 'к', 'корп', 'корпус', 'стр', 'строение', 'лит', 'литера',
    'кв', 'пом', 'помещение', 'оф', 'офис', 'эт', 'этаж',
    'касса', 'ккт', 'ккм', 'рм', 'рмк', 'пк', 'комп', 'компьютер', 'ноутбук', 'бук',
    'сервер', 'терминал', 'рабочее', 'место', 'основной', 'основная', 'резерв', 'резервный',
    'зав', 'заведующая', 'админ', 'администратор', 'оператор', 'менеджер', 'директор',
    'фармацевт', 'первостольник', 'склад', 'зал', 'торговый', 'иб', 'юб', 'ва', 'цо'
]);

// Glued prefixes with dot (e.g. "ст.Калининская", "ул.Советская", "д.38") or building prefix glued to digits ("д38", "к1")
const GLUED_PREFIX_RE = /(^|[\s,;|/\\(\["'«№-])(?:(?:ст-ца|станица|ст|город|г|село|с|пгт|поселок|пос|п|хут|х|улица|ул|переулок|пер|проспект|просп|пр-т|пр-кт|пр|бульвар|бул|б-р|шоссе|ш|набережная|наб|площадь|пл|микрорайон|мкр-н|мкр|квартал|кв-л|дом|д|корпус|корп|строение|стр|литера|лит|помещение|пом|офис|оф|кв|к)\.\s*(?=[а-яёa-z0-9])|(?:д|к|корп|стр|пом|оф|кв)(?=\d))/gi;

function clampNumber(value, fallback, min, max) {
    var num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < min) return min;
    if (num > max) return max;
    return num;
}

function maskWebhookUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl) return '(не задан)';
    try {
        var parsed = new URL(rawUrl);
        var segments = parsed.pathname.split('/');
        for (var i = 0; i < segments.length; i++) {
            if (segments[i] === 'rest' && i + 2 < segments.length && segments[i + 2]) {
                segments[i + 2] = '***';
                break;
            }
        }
        parsed.pathname = segments.join('/');
        return parsed.toString();
    } catch (e) {
        return '(некорректный URL)';
    }
}

function buildUserGetUrl(webhookUrl) {
    if (typeof webhookUrl !== 'string' || !webhookUrl.trim()) {
        throw new Error('Bitrix24 webhookUrl не настроен');
    }
    var trimmed = webhookUrl.trim().replace(/\/+$/, '');
    var parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Неподдерживаемый протокол webhookUrl: ' + parsed.protocol);
    }
    if (!/\/user\.get(\.json)?$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/user.get.json';
    }
    return parsed.toString();
}

function extractPluginConfigFromObject(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    var settings = (cfg.settings && typeof cfg.settings === 'object') ? cfg.settings : null;
    var plugins = (settings && settings.plugins && typeof settings.plugins === 'object') ? settings.plugins : null;
    var candidates = [
        plugins && plugins.b24contacts,
        plugins && plugins._b24contacts,
        plugins && plugins['meshcentral-b24-contacts'],
        settings && settings.b24contacts,
        cfg.b24contacts
    ];
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] && typeof candidates[i] === 'object') {
            return candidates[i];
        }
    }
    return null;
}

function readDiskConfig(datapath) {
    if (!datapath) return null;
    try {
        var cfgPath = path.join(datapath, 'config.json');
        if (!fs.existsSync(cfgPath)) return null;
        var raw = fs.readFileSync(cfgPath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.warn('[b24contacts] Не удалось прочитать config.json с диска:', e.message);
        return null;
    }
}

function loadSettings(server) {
    var fromMemory = server && server.config ? extractPluginConfigFromObject(server.config) : null;
    var fromDisk = (!fromMemory || !fromMemory.webhookUrl) && server && server.datapath
        ? extractPluginConfigFromObject(readDiskConfig(server.datapath))
        : null;
    var merged = Object.assign({}, fromDisk || {}, fromMemory || {});
    var envUrl = (typeof process !== 'undefined' && process.env && process.env.B24_WEBHOOK_URL)
        ? String(process.env.B24_WEBHOOK_URL).trim()
        : '';

    return {
        webhookUrl: typeof merged.webhookUrl === 'string' && merged.webhookUrl.trim()
            ? merged.webhookUrl.trim()
            : envUrl,
        cacheTtlMinutes: clampNumber(merged.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES, 5, 1440),
        minMatchScore: clampNumber(merged.minMatchScore, DEFAULT_MIN_MATCH_SCORE, 0.2, 0.95),
        requestTimeoutMs: clampNumber(merged.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 2000, 60000),
        pageDelayMs: clampNumber(merged.pageDelayMs, DEFAULT_PAGE_DELAY_MS, 0, 5000),
        rejectUnauthorized: merged.rejectUnauthorized !== false
    };
}

function normalizeAndTokenize(raw) {
    if (typeof raw !== 'string') return [];
    var text = raw.trim();
    if (!text) return [];

    // Strip department prefix before pipe (e.g. "ВА | ...")
    text = text.replace(/^\s*[^|]{1,18}\|\s*/g, ' ');
    // Strip trailing short uppercase department/branch tags (e.g. " - ЮБ", " - ИБ")
    text = text.replace(/(?:\s+[-–—]\s+[А-ЯЁA-Z]{2,4})+\s*$/g, ' ');

    text = text.toLowerCase().replace(/ё/g, 'е');

    // Remove workstation designations together with trailing slot digits ("касса 2", "касса №1", "рмк 3")
    text = text.replace(/(?:^|[\s,;|/\\(\[-])(?:касса|ккт|ккм|рмк|рм|пк|компьютер|комп|ноутбук|сервер|терминал|рабочее\s+место)\s*(?:№|#)?\s*\d*(?=$|[\s,;|/\\)\]-])/gi, ' ');

    // Detach glued address prefixes like "ст.Калининская", "ул.Советская", "д.38"
    text = text.replace(GLUED_PREFIX_RE, '$1');

    // Replace delimiters with spaces
    text = text.replace(/[^а-яa-z0-9]+/g, ' ');

    var rawTokens = text.split(/\s+/);
    var result = [];
    var seen = new Set();

    for (var i = 0; i < rawTokens.length; i++) {
        var tok = rawTokens[i].trim();
        if (!tok) continue;
        if (HARD_STOP_WORDS.has(tok)) continue;
        if (/^(?:касса|рмк?|пк|терминал)\d+$/.test(tok)) continue;

        var isNumeric = /^\d+$/.test(tok);
        if (!isNumeric && tok.length < 2) continue;

        if (!seen.has(tok)) {
            seen.add(tok);
            result.push(tok);
        }
    }
    return result;
}

function levenshtein(a, b) {
    if (a === b) return 0;
    var la = a.length;
    var lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;

    var prev = new Array(lb + 1);
    var curr = new Array(lb + 1);
    for (var j = 0; j <= lb; j++) prev[j] = j;

    for (var i = 1; i <= la; i++) {
        curr[0] = i;
        var ca = a.charCodeAt(i - 1);
        for (var j2 = 1; j2 <= lb; j2++) {
            var cost = ca === b.charCodeAt(j2 - 1) ? 0 : 1;
            var del = prev[j2] + 1;
            var ins = curr[j2 - 1] + 1;
            var sub = prev[j2 - 1] + cost;
            curr[j2] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
        }
        var tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[lb];
}

function commonPrefixLength(a, b) {
    var limit = a.length < b.length ? a.length : b.length;
    var idx = 0;
    while (idx < limit && a.charCodeAt(idx) === b.charCodeAt(idx)) idx++;
    return idx;
}

function isHouseToken(tok) {
    return /^\d+[а-яa-z]?$/.test(tok);
}

function extractNumericRoot(tok) {
    var m = /^(\d+)/.exec(tok);
    return m ? m[1] : null;
}

function tokenSimilarity(a, b) {
    if (a === b) return 1.0;

    var aHouse = isHouseToken(a);
    var bHouse = isHouseToken(b);
    if (aHouse || bHouse) {
        if (!aHouse || !bHouse) return 0;
        var rootA = extractNumericRoot(a);
        var rootB = extractNumericRoot(b);
        if (rootA !== rootB) return 0;
        // One has building letter ("38а" vs "38") or different letter ("38а" vs "38б")
        if (a.length === rootA.length || b.length === rootB.length) return 0.85;
        return 0.55;
    }

    var maxLen = a.length > b.length ? a.length : b.length;
    var minLen = a.length < b.length ? a.length : b.length;
    if (minLen < 4) return 0;

    var prefix = commonPrefixLength(a, b);
    if (prefix >= 5 && (prefix / maxLen) >= 0.72) {
        return 0.82;
    }

    var maxDist = maxLen >= 7 ? 2 : 1;
    if (Math.abs(a.length - b.length) <= maxDist) {
        var dist = levenshtein(a, b);
        if (dist <= maxDist) return 0.78;
    }
    return 0;
}

function tokenWeight(tok) {
    return isHouseToken(tok) ? 1.25 : 1.0;
}

function scoreCandidate(queryTokens, candTokens, candHasPhone) {
    if (!queryTokens.length || !candTokens.length) return 0;

    var pairs = [];
    for (var qi = 0; qi < queryTokens.length; qi++) {
        for (var ci = 0; ci < candTokens.length; ci++) {
            var sim = tokenSimilarity(queryTokens[qi], candTokens[ci]);
            if (sim > 0) {
                pairs.push({ qi: qi, ci: ci, sim: sim });
            }
        }
    }

    if (pairs.length === 0) return 0;
    pairs.sort(function (x, y) { return y.sim - x.sim; });

    var usedQ = new Set();
    var usedC = new Set();
    var matchedWeight = 0;
    var matchedCount = 0;

    for (var p = 0; p < pairs.length; p++) {
        var pair = pairs[p];
        if (usedQ.has(pair.qi) || usedC.has(pair.ci)) continue;
        usedQ.add(pair.qi);
        usedC.add(pair.ci);
        matchedCount++;
        var w = tokenWeight(queryTokens[pair.qi]);
        matchedWeight += w * pair.sim;
    }

    // Prevent single generic token (like city name alone) from false-matching
    if (queryTokens.length >= 2 && matchedCount < 2) return 0;
    if (queryTokens.length === 1 && (candTokens.length > 1 || matchedWeight < 0.99)) return 0;

    var totalQWeight = 0;
    for (var q = 0; q < queryTokens.length; q++) totalQWeight += tokenWeight(queryTokens[q]);
    var totalCWeight = 0;
    for (var c = 0; c < candTokens.length; c++) totalCWeight += tokenWeight(candTokens[c]);

    var qCov = matchedWeight / totalQWeight;
    var cCov = matchedWeight / totalCWeight;
    var f1 = (qCov + cCov) > 0 ? (2 * qCov * cCov) / (qCov + cCov) : 0;

    // House number conflict guard: if both have numeric house roots and none overlap, penalize heavily
    var qNums = new Set();
    var cNums = new Set();
    for (var i = 0; i < queryTokens.length; i++) {
        var rn = extractNumericRoot(queryTokens[i]);
        if (rn) qNums.add(rn);
    }
    for (var j = 0; j < candTokens.length; j++) {
        var cn = extractNumericRoot(candTokens[j]);
        if (cn) cNums.add(cn);
    }
    if (qNums.size > 0 && cNums.size > 0) {
        var numOverlap = false;
        qNums.forEach(function (n) {
            if (cNums.has(n)) numOverlap = true;
        });
        if (!numOverlap) {
            f1 *= 0.35;
        }
    }

    if (candHasPhone) {
        f1 += 0.02;
    }
    return Math.min(f1, 1.0);
}

function cleanPhoneValue(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    return String(raw).trim();
}

function buildTelHref(phoneText) {
    if (!phoneText) return '';
    var cleaned = phoneText.replace(/[^\d+*#]/g, '');
    if (!cleaned) return '';
    // Keep "+" only at the beginning if present
    var hasPlus = phoneText.trim().startsWith('+');
    cleaned = cleaned.replace(/\+/g, '');
    if (!cleaned) return '';
    return 'tel:' + (hasPlus ? '+' : '') + cleaned;
}

function extractPhonesList(raw, type, label) {
    var text = cleanPhoneValue(raw);
    if (!text) return [];
    var parts = text.split(/[;,]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        var item = parts[i].trim();
        if (!item) continue;
        var href = buildTelHref(item);
        if (!href) continue;
        out.push({
            type: type,
            label: label,
            display: item,
            href: href
        });
    }
    return out;
}

function buildProfileDisplayName(user) {
    var parts = [];
    [user.LAST_NAME, user.NAME, user.SECOND_NAME].forEach(function (part) {
        if (typeof part === 'string') {
            var trimmed = part.trim();
            if (trimmed && parts.indexOf(trimmed) === -1) {
                parts.push(trimmed);
            }
        }
    });
    return parts.join(' ');
}

function normalizeBitrixUser(user) {
    if (!user || typeof user !== 'object') return null;
    var displayName = buildProfileDisplayName(user);
    if (!displayName) return null;

    var workPhone = cleanPhoneValue(user.WORK_PHONE);
    var mobilePhone = cleanPhoneValue(user.PERSONAL_MOBILE);
    var phones = extractPhonesList(workPhone, 'work', 'Рабочий')
        .concat(extractPhonesList(mobilePhone, 'mobile', 'Мобильный'));

    return {
        id: user.ID != null ? String(user.ID) : '',
        displayName: displayName,
        name: cleanPhoneValue(user.NAME),
        lastName: cleanPhoneValue(user.LAST_NAME),
        secondName: cleanPhoneValue(user.SECOND_NAME),
        workPhone: workPhone,
        mobilePhone: mobilePhone,
        phones: phones,
        tokens: normalizeAndTokenize(displayName)
    };
}

function findBestContactMatch(nodeName, cachedUsers, minScore) {
    var threshold = clampNumber(minScore, DEFAULT_MIN_MATCH_SCORE, 0.2, 0.95);
    var queryTokens = normalizeAndTokenize(nodeName);
    if (queryTokens.length === 0 || !Array.isArray(cachedUsers) || cachedUsers.length === 0) {
        return { matched: false, score: 0, queryTokens: queryTokens, profile: null };
    }

    var bestUser = null;
    var bestScore = 0;

    for (var i = 0; i < cachedUsers.length; i++) {
        var candidate = cachedUsers[i];
        if (!candidate || !Array.isArray(candidate.tokens) || candidate.tokens.length === 0) continue;
        var hasPhone = Array.isArray(candidate.phones) && candidate.phones.length > 0;
        var score = scoreCandidate(queryTokens, candidate.tokens, hasPhone);
        if (score > bestScore) {
            bestScore = score;
            bestUser = candidate;
        }
    }

    if (!bestUser || bestScore < threshold) {
        return { matched: false, score: Number(bestScore.toFixed(3)), queryTokens: queryTokens, profile: null };
    }

    return {
        matched: true,
        score: Number(bestScore.toFixed(3)),
        queryTokens: queryTokens,
        profile: {
            id: bestUser.id,
            displayName: bestUser.displayName,
            workPhone: bestUser.workPhone,
            mobilePhone: bestUser.mobilePhone,
            phones: bestUser.phones
        }
    };
}

function postJson(targetUrl, payload, options, redirectCount) {
    var hops = redirectCount || 0;
    return new Promise(function (resolve, reject) {
        try {
            var parsed = new URL(targetUrl);
            var body = JSON.stringify(payload || {});
            var transport = parsed.protocol === 'http:' ? http : https;
            var reqOpts = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || undefined,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            };
            if (parsed.protocol === 'https:' && options && options.rejectUnauthorized === false) {
                reqOpts.rejectUnauthorized = false;
            }

            var settled = false;
            var timeoutMs = (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;

            var req = transport.request(reqOpts, function (res) {
                var status = res.statusCode || 0;
                if ([301, 302, 307, 308].indexOf(status) !== -1 && res.headers.location && hops < 2) {
                    res.resume();
                    settled = true;
                    var nextUrl = new URL(res.headers.location, parsed).toString();
                    postJson(nextUrl, payload, options, hops + 1).then(resolve, reject);
                    return;
                }

                var chunks = [];
                var totalBytes = 0;
                res.on('data', function (chunk) {
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_RESPONSE_BYTES) {
                        if (!settled) {
                            settled = true;
                            req.destroy(new Error('Ответ Bitrix24 превышает допустимый размер'));
                            reject(new Error('Ответ Bitrix24 превышает допустимый размер'));
                        }
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', function () {
                    if (settled) return;
                    settled = true;
                    var raw = Buffer.concat(chunks).toString('utf8');
                    var data = null;
                    try {
                        data = JSON.parse(raw);
                    } catch (e) {
                        reject(new Error('Некорректный JSON от Bitrix24 (HTTP ' + status + ')'));
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        var errMsg = (data && (data.error_description || data.error)) || ('HTTP ' + status);
                        reject(new Error('Ошибка Bitrix24: ' + errMsg));
                        return;
                    }
                    if (data && data.error) {
                        reject(new Error('Ошибка Bitrix24 API: ' + (data.error_description || data.error)));
                        return;
                    }
                    resolve(data);
                });
            });

            req.setTimeout(timeoutMs, function () {
                if (settled) return;
                settled = true;
                req.destroy(new Error('Таймаут запроса к Bitrix24 (' + timeoutMs + ' мс)'));
                reject(new Error('Таймаут запроса к Bitrix24 (' + timeoutMs + ' мс)'));
            });

            req.on('error', function (err) {
                if (settled) return;
                settled = true;
                reject(err);
            });

            req.write(body);
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

function delay(ms) {
    return new Promise(function (resolve) {
        if (!ms || ms <= 0) return resolve();
        setTimeout(resolve, ms);
    });
}

async function fetchAllActiveUsers(settings) {
    var endpointUrl = buildUserGetUrl(settings.webhookUrl);
    var allUsers = [];
    var start = 0;

    for (var page = 0; page < MAX_PAGES; page++) {
        if (page > 0 && settings.pageDelayMs > 0) {
            await delay(settings.pageDelayMs);
        }

        var response = await postJson(
            endpointUrl,
            {
                FILTER: { ACTIVE: true },
                SORT: 'ID',
                ORDER: 'ASC',
                start: start
            },
            {
                timeoutMs: settings.requestTimeoutMs,
                rejectUnauthorized: settings.rejectUnauthorized
            }
        );

        var batch = Array.isArray(response && response.result) ? response.result : [];
        for (var i = 0; i < batch.length; i++) {
            var normalized = normalizeBitrixUser(batch[i]);
            if (normalized) allUsers.push(normalized);
        }

        var next = response && response.next;
        if (typeof next === 'number' && Number.isFinite(next) && next > start) {
            start = next;
        } else {
            break;
        }
    }

    return allUsers;
}

function createPlugin(parent) {
    var obj = {};
    obj.parent = parent || {};
    obj.meshServer = (parent && (parent.parent || parent.meshServer)) || parent || {};

    var cache = {
        users: [],
        lastUpdated: 0,
        lastError: null,
        refreshPromise: null,
        lastAttemptAt: 0
    };

    var started = false;
    var refreshTimer = null;
    var routesRetryTimer = null;
    var routesRetryStarted = false;

    function getServer() {
        return obj.meshServer || (obj.parent && (obj.parent.parent || obj.parent.meshServer)) || null;
    }

    function getSettings() {
        return loadSettings(getServer());
    }

    async function refreshCache(reason) {
        if (cache.refreshPromise) {
            return cache.refreshPromise;
        }

        var settings = getSettings();
        if (!settings.webhookUrl) {
            cache.lastError = 'URL вебхука Битрикс24 не настроен в config.json';
            console.warn('[b24contacts] ' + cache.lastError);
            return false;
        }

        cache.lastAttemptAt = Date.now();
        var startedAt = Date.now();
        console.log('[b24contacts] Обновление кеша пользователей Битрикс24 (' + (reason || 'manual') + '), webhook: ' + maskWebhookUrl(settings.webhookUrl));

        cache.refreshPromise = (async function () {
            try {
                var users = await fetchAllActiveUsers(settings);
                cache.users = users;
                cache.lastUpdated = Date.now();
                cache.lastError = null;
                console.log('[b24contacts] Кеш обновлён: загружено ' + users.length + ' активных профилей за ' + (Date.now() - startedAt) + ' мс.');
                return true;
            } catch (err) {
                cache.lastError = err && err.message ? err.message : String(err);
                console.error('[b24contacts] Ошибка обновления кеша Битрикс24 (сохраняется предыдущий кеш: ' + cache.users.length + ' записей):', cache.lastError);
                return false;
            } finally {
                cache.refreshPromise = null;
            }
        })();

        return cache.refreshPromise;
    }

    async function ensureCacheReady() {
        if (cache.refreshPromise) {
            await cache.refreshPromise;
            return;
        }
        if (cache.users.length === 0 && (Date.now() - cache.lastAttemptAt) > ERROR_RETRY_COOLDOWN_MS) {
            await refreshCache('on-demand');
        }
    }

    function sendToClient(client, payload) {
        if (!client) return;
        try {
            if (typeof client.send === 'function') {
                client.send(payload);
            } else if (client.ws && typeof client.ws.send === 'function') {
                client.ws.send(JSON.stringify(payload));
            }
        } catch (err) {
            console.error('[b24contacts] Ошибка отправки ответа клиенту:', err.message);
        }
    }

    function isUserAdmin(user) {
        if (!user) return false;
        return user.siteadmin === 0xFFFFFFFF || user.siteadmin === -1 || user.siteadmin === true || (typeof user.siteadmin === 'number' && (user.siteadmin & 1) !== 0);
    }

    function getUserFromReq(req) {
        var server = getServer();
        if (!server) return null;

        if (req.session && req.session.userid) {
            if (server.users && server.users[req.session.userid]) return server.users[req.session.userid];
            if (server.webserver && server.webserver.users && server.webserver.users[req.session.userid]) {
                return server.webserver.users[req.session.userid];
            }
        }

        try {
            var cookieHeader = req.headers && req.headers.cookie;
            if (cookieHeader && typeof server.decodeCookie === 'function') {
                var pairs = cookieHeader.split(';');
                for (var i = 0; i < pairs.length; i++) {
                    var idx = pairs[i].indexOf('=');
                    if (idx === -1) continue;
                    var key = pairs[i].slice(0, idx).trim();
                    if (key !== 'xid') continue;
                    var val = decodeURIComponent(pairs[i].slice(idx + 1).trim());
                    var decoded = server.decodeCookie(val, server.loginCookieEncryptionKey);
                    if (decoded && decoded.userid) {
                        if (server.users && server.users[decoded.userid]) return server.users[decoded.userid];
                        if (server.webserver && server.webserver.users && server.webserver.users[decoded.userid]) {
                            return server.webserver.users[decoded.userid];
                        }
                    }
                }
            }
        } catch (e) {}

        return null;
    }

    function verifyNodeAccess(client, nodeId) {
        return new Promise(function (resolve) {
            if (!nodeId || typeof nodeId !== 'string') return resolve(true);
            var server = getServer();
            var web = server && server.webserver;
            if (!web || typeof web.GetNodeWithRights !== 'function' || !client.domain) {
                return resolve(true);
            }
            try {
                web.GetNodeWithRights(client.domain, client.user, nodeId, function (node, rights, visible) {
                    resolve(Boolean(visible && node));
                });
            } catch (e) {
                resolve(false);
            }
        });
    }

    async function lookupContacts(nodeName) {
        var settings = getSettings();
        if (!settings.webhookUrl) {
            return {
                ok: false,
                matched: false,
                error: 'Вебхук Битрикс24 не настроен в config.json',
                cacheSize: cache.users.length
            };
        }

        await ensureCacheReady();

        if (cache.users.length === 0 && cache.lastError) {
            return {
                ok: false,
                matched: false,
                error: 'Не удалось загрузить справочник Битрикс24: ' + cache.lastError,
                cacheSize: 0
            };
        }

        var match = findBestContactMatch(nodeName, cache.users, settings.minMatchScore);
        return {
            ok: true,
            matched: match.matched,
            score: match.score,
            profile: match.profile,
            phones: match.profile ? match.profile.phones : [],
            cacheSize: cache.users.length,
            lastUpdated: cache.lastUpdated
        };
    }

    function getExpressApp() {
        var server = getServer();
        if (!server) return null;
        return server.app || (server.webserver && server.webserver.app) || null;
    }

    function registerRoutes(app) {
        if (!app || typeof app.get !== 'function') return false;
        if (app._b24ContactsRoutesRegistered) return true;
        app._b24ContactsRoutesRegistered = true;

        var clientJsPath = path.join(__dirname, 'public', 'b24contacts.js');

        app.get('/plugin/b24contacts/b24contacts.js', function (req, res) {
            try {
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                if (fs.existsSync(clientJsPath)) {
                    res.sendFile(clientJsPath);
                } else {
                    res.status(404).send('// b24contacts client script not found');
                }
            } catch (e) {
                res.status(500).send('// error serving b24contacts.js');
            }
        });

        app.get('/plugin/b24contacts/api/contacts', async function (req, res) {
            try {
                var user = getUserFromReq(req);
                if (!user && (!req.session || !req.session.userid)) {
                    return res.status(401).json({ ok: false, error: 'Unauthorized' });
                }

                var nodeName = typeof req.query.nodeName === 'string' ? req.query.nodeName.slice(0, 512) : '';
                if (!nodeName.trim()) {
                    return res.status(400).json({ ok: false, error: 'Missing nodeName parameter' });
                }

                var result = await lookupContacts(nodeName);
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.status(200).json(result);
            } catch (err) {
                console.error('[b24contacts] Ошибка HTTP API /api/contacts:', err.message);
                return res.status(500).json({ ok: false, matched: false, error: 'Внутренняя ошибка плагина' });
            }
        });

        // Promote plugin routes ahead of MeshCentral's catch-all 404 middleware
        if (app._router && Array.isArray(app._router.stack)) {
            var stack = app._router.stack;
            var layers = [];
            for (var i = stack.length - 1; i >= 0; i--) {
                var routePath = stack[i] && stack[i].route ? stack[i].route.path : '';
                if (typeof routePath === 'string' && routePath.indexOf('/plugin/b24contacts/') === 0) {
                    layers.unshift(stack.splice(i, 1)[0]);
                }
            }
            if (layers.length > 0) {
                stack.splice(2, 0, ...layers);
            }
        }

        console.log('[b24contacts] HTTP-маршруты плагина зарегистрированы.');
        return true;
    }

    function tryRegisterRoutes(attemptsLeft) {
        routesRetryTimer = null;
        try {
            if (registerRoutes(getExpressApp())) return;
        } catch (e) {
            console.warn('[b24contacts] Не удалось зарегистрировать HTTP-маршруты:', e.message);
        }
        if (attemptsLeft > 0) {
            routesRetryTimer = setTimeout(function () { tryRegisterRoutes(attemptsLeft - 1); }, 1000);
            if (routesRetryTimer && typeof routesRetryTimer.unref === 'function') {
                routesRetryTimer.unref();
            }
        }
    }

    if (parent && typeof parent.registerPermissions === 'function') {
        try {
            parent.registerPermissions(PLUGIN_NAME, {
                can_view: {
                    title: 'Просмотр контактов Битрикс24',
                    desc: 'Просмотр телефонов аптек из Битрикс24 в сводке устройства',
                    default: 'allowed'
                }
            });
        } catch (e) {}
    }

    obj.hook_setupHttpHandlers = function (webserver) {
        try {
            registerRoutes(webserver && (webserver.app || webserver));
        } catch (e) {
            console.error('[b24contacts] Ошибка hook_setupHttpHandlers:', e.message);
        }
    };

    obj.server_startup = function () {
        if (started) return;
        started = true;

        try {
            var settings = getSettings();
            console.log('[b24contacts] Плагин запущен. TTL кеша: ' + settings.cacheTtlMinutes + ' мин. Webhook: ' + maskWebhookUrl(settings.webhookUrl));

            if (!routesRetryStarted) {
                routesRetryStarted = true;
                tryRegisterRoutes(30);
            }

            // Initial non-blocking cache warm-up
            refreshCache('startup').catch(function (err) {
                console.error('[b24contacts] Непредвиденная ошибка стартового обновления кеша:', err && err.message);
            });

            var intervalMs = settings.cacheTtlMinutes * 60 * 1000;
            refreshTimer = setInterval(function () {
                refreshCache('scheduled').catch(function (err) {
                    console.error('[b24contacts] Ошибка планового обновления кеша:', err && err.message);
                });
            }, intervalMs);
            if (refreshTimer && typeof refreshTimer.unref === 'function') {
                refreshTimer.unref();
            }
        } catch (err) {
            console.error('[b24contacts] Ошибка инициализации server_startup:', err.message);
        }
    };

    obj.server_shutdown = function () {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        if (routesRetryTimer) {
            clearTimeout(routesRetryTimer);
            routesRetryTimer = null;
        }
        started = false;
    };

    obj.serveraction = function (command, client) {
        if (!command || !client || !client.user) return;
        var action = command.pluginaction;

        if (action === 'getContacts') {
            var requestId = typeof command.requestId === 'string' ? command.requestId : '';
            var nodeId = typeof command.nodeId === 'string' ? command.nodeId : '';
            var nodeName = typeof command.nodeName === 'string' ? command.nodeName.slice(0, 512) : '';

            (async function () {
                try {
                    if (parent && typeof parent.checkPluginPermission === 'function') {
                        if (!parent.checkPluginPermission(client.user, PLUGIN_NAME, 'can_view', nodeId || undefined)) {
                            sendToClient(client, {
                                action: 'plugin',
                                plugin: PLUGIN_NAME,
                                method: 'onContactsResult',
                                requestId: requestId,
                                nodeId: nodeId,
                                nodeName: nodeName,
                                ok: false,
                                matched: false,
                                error: 'Недостаточно прав для просмотра контактов Битрикс24'
                            });
                            return;
                        }
                    }

                    var hasNodeAccess = await verifyNodeAccess(client, nodeId);
                    if (!hasNodeAccess) {
                        sendToClient(client, {
                            action: 'plugin',
                            plugin: PLUGIN_NAME,
                            method: 'onContactsResult',
                            requestId: requestId,
                            nodeId: nodeId,
                            nodeName: nodeName,
                            ok: false,
                            matched: false,
                            error: 'Доступ к устройству запрещён'
                        });
                        return;
                    }

                    var result = await lookupContacts(nodeName);
                    sendToClient(client, Object.assign({
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onContactsResult',
                        requestId: requestId,
                        nodeId: nodeId,
                        nodeName: nodeName
                    }, result));
                } catch (err) {
                    console.error('[b24contacts] Ошибка serveraction getContacts:', err.message);
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onContactsResult',
                        requestId: requestId,
                        nodeId: nodeId,
                        nodeName: nodeName,
                        ok: false,
                        matched: false,
                        error: 'Внутренняя ошибка сервера при поиске контактов'
                    });
                }
            })();
            return;
        }

        if (action === 'refreshCache') {
            if (!isUserAdmin(client.user)) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onContactsResult',
                    requestId: typeof command.requestId === 'string' ? command.requestId : '',
                    ok: false,
                    error: 'Требуются права администратора MeshCentral'
                });
                return;
            }
            refreshCache('manual').then(function (ok) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onContactsResult',
                    requestId: typeof command.requestId === 'string' ? command.requestId : '',
                    refreshed: true,
                    ok: ok,
                    cacheSize: cache.users.length,
                    error: ok ? null : cache.lastError
                });
            }).catch(function (err) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onContactsResult',
                    requestId: typeof command.requestId === 'string' ? command.requestId : '',
                    refreshed: true,
                    ok: false,
                    error: err && err.message
                });
            });
        }
    };

    obj.handleServerMessage = obj.serveraction;

    // Expose internals for automated testing
    obj._internal = {
        normalizeAndTokenize: normalizeAndTokenize,
        findBestContactMatch: findBestContactMatch,
        normalizeBitrixUser: normalizeBitrixUser,
        scoreCandidate: scoreCandidate,
        buildUserGetUrl: buildUserGetUrl,
        maskWebhookUrl: maskWebhookUrl,
        loadSettings: loadSettings,
        refreshCache: refreshCache,
        getCacheState: function () { return cache; }
    };

    // Browser-serialized hooks (MUST NOT reference Node closure variables)
    obj.exports = ['onWebUIStartupEnd', 'onDeviceRefreshEnd', 'onContactsResult'];

    obj.onWebUIStartupEnd = function () {
        if (document.getElementById('b24contacts-loader')) return;
        var s = document.createElement('script');
        s.id = 'b24contacts-loader';
        s.src = 'plugin/b24contacts/b24contacts.js';
        document.head.appendChild(s);
    };

    obj.onDeviceRefreshEnd = function () {
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.onDeviceRefreshEnd === 'function') {
            window.B24ContactsPlugin.onDeviceRefreshEnd();
        }
    };

    obj.onContactsResult = function (server, message) {
        var payload = (message && typeof message === 'object') ? message : server;
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.onContactsResult === 'function') {
            window.B24ContactsPlugin.onContactsResult(payload);
        }
    };

    return obj;
}

module.exports = createPlugin;
module.exports.b24contacts = createPlugin;
