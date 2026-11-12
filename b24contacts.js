'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
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
    // Strip any sample method suffix (e.g. "/profile.json") from Bitrix24 request generator URLs
    var restBase = /^(.*\/rest\/\d+\/[^/]+)(?:\/.*)?$/i.exec(parsed.pathname);
    if (restBase) {
        parsed.pathname = restBase[1] + '/user.get.json';
    } else if (!/\/user\.get(\.json)?$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/user.get.json';
    }
    return parsed.toString();
}

function extractPortalOrigin(webhookUrl, portalUrl) {
    var candidate = (typeof portalUrl === 'string' && portalUrl.trim()) ? portalUrl.trim() : webhookUrl;
    if (typeof candidate !== 'string' || !candidate.trim()) return '';
    try {
        var parsed = new URL(candidate.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.origin;
    } catch (e) {
        return '';
    }
}

function buildBitrixUserLinks(userId, portalOrigin) {
    if (!portalOrigin || typeof userId !== 'string') return { profileUrl: '', chatUrl: '' };
    var id = userId.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { profileUrl: '', chatUrl: '' };
    var encId = encodeURIComponent(id);
    return {
        profileUrl: portalOrigin + '/company/personal/user/' + encId + '/',
        chatUrl: portalOrigin + '/online/?IM_DIALOG=' + encId
    };
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

function getSavedSettingsPath(server) {
    if (!server || !server.datapath) return null;
    return path.join(server.datapath, 'b24contacts-settings.json');
}

function readSavedSettings(server) {
    var filePath = getSavedSettingsPath(server);
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath)) return null;
        var parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
        console.warn('[b24contacts] Не удалось прочитать сохранённые настройки:', e.message);
        return null;
    }
}

function writeSavedSettings(server, nextSettings) {
    var filePath = getSavedSettingsPath(server);
    if (!filePath) {
        throw new Error('Каталог данных MeshCentral (datapath) недоступен для сохранения настроек');
    }
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    var tmpPath = filePath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(nextSettings, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpPath, filePath);
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    }
}

function loadSettings(server) {
    var fromMemory = server && server.config ? extractPluginConfigFromObject(server.config) : null;
    var fromDisk = (!fromMemory || !fromMemory.webhookUrl) && server && server.datapath
        ? extractPluginConfigFromObject(readDiskConfig(server.datapath))
        : null;
    var fromSaved = readSavedSettings(server);
    var merged = Object.assign({}, fromDisk || {}, fromMemory || {}, fromSaved || {});
    var envUrl = (typeof process !== 'undefined' && process.env && process.env.B24_WEBHOOK_URL)
        ? String(process.env.B24_WEBHOOK_URL).trim()
        : '';

    return {
        webhookUrl: typeof merged.webhookUrl === 'string' && merged.webhookUrl.trim()
            ? merged.webhookUrl.trim()
            : envUrl,
        portalUrl: typeof merged.portalUrl === 'string' ? merged.portalUrl.trim() : '',
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
    var personalPhone = cleanPhoneValue(user.PERSONAL_PHONE);
    var innerPhone = cleanPhoneValue(user.UF_PHONE_INNER);

    var phones = extractPhonesList(workPhone, 'work', 'Рабочий')
        .concat(extractPhonesList(mobilePhone, 'mobile', 'Мобильный'));

    var seenHrefs = new Set(phones.map(function (p) { return p.href; }));
    extractPhonesList(personalPhone, 'mobile', 'Доп. телефон').forEach(function (p) {
        if (!seenHrefs.has(p.href)) {
            seenHrefs.add(p.href);
            phones.push(p);
        }
    });
    extractPhonesList(innerPhone, 'work', 'Внутренний').forEach(function (p) {
        if (!seenHrefs.has(p.href)) {
            seenHrefs.add(p.href);
            phones.push(p);
        }
    });

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
                needsConfig: true,
                matched: false,
                error: 'Вебхук Битрикс24 не настроен',
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
        var profile = match.profile;
        if (profile && profile.id) {
            var portalOrigin = extractPortalOrigin(settings.webhookUrl, settings.portalUrl);
            var links = buildBitrixUserLinks(profile.id, portalOrigin);
            profile = Object.assign({}, profile, links);
        }
        return {
            ok: true,
            matched: match.matched,
            score: match.score,
            profile: profile,
            phones: profile ? profile.phones : [],
            cacheSize: cache.users.length,
            lastUpdated: cache.lastUpdated
        };
    }

    function getSettingsSummary(settings) {
        var s = settings || getSettings();
        return {
            hasWebhook: Boolean(s.webhookUrl),
            maskedWebhookUrl: maskWebhookUrl(s.webhookUrl),
            cacheTtlMinutes: s.cacheTtlMinutes,
            minMatchScore: s.minMatchScore,
            requestTimeoutMs: s.requestTimeoutMs,
            rejectUnauthorized: s.rejectUnauthorized,
            cacheSize: cache.users.length,
            lastUpdated: cache.lastUpdated,
            lastError: cache.lastError
        };
    }

    function rescheduleRefreshTimer(settings) {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        var s = settings || getSettings();
        var intervalMs = s.cacheTtlMinutes * 60 * 1000;
        refreshTimer = setInterval(function () {
            refreshCache('scheduled').catch(function (err) {
                console.error('[b24contacts] Ошибка планового обновления кеша:', err && err.message);
            });
        }, intervalMs);
        if (refreshTimer && typeof refreshTimer.unref === 'function') {
            refreshTimer.unref();
        }
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

            rescheduleRefreshTimer(settings);
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
        var requestId = typeof command.requestId === 'string' ? command.requestId : '';

        if (action === 'getContacts') {
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

        if (action === 'getSettings') {
            if (!isUserAdmin(client.user)) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    ok: false,
                    error: 'Требуются права администратора MeshCentral'
                });
                return;
            }
            sendToClient(client, Object.assign({
                action: 'plugin',
                plugin: PLUGIN_NAME,
                method: 'onSettingsResult',
                requestId: requestId,
                ok: true
            }, getSettingsSummary()));
            return;
        }

        if (action === 'saveSettings') {
            if (!isUserAdmin(client.user)) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    ok: false,
                    error: 'Требуются права администратора MeshCentral'
                });
                return;
            }
            (async function () {
                try {
                    var incoming = (command.settings && typeof command.settings === 'object') ? command.settings : {};
                    var current = getSettings();
                    var rawUrl = typeof incoming.webhookUrl === 'string' ? incoming.webhookUrl.trim() : '';
                    var nextWebhookUrl = rawUrl || current.webhookUrl;
                    if (incoming.clearWebhook === true) {
                        nextWebhookUrl = '';
                    }
                    if (nextWebhookUrl) {
                        buildUserGetUrl(nextWebhookUrl);
                    }
                    var nextSettings = {
                        webhookUrl: nextWebhookUrl,
                        portalUrl: typeof incoming.portalUrl === 'string' ? incoming.portalUrl.trim() : current.portalUrl,
                        cacheTtlMinutes: clampNumber(incoming.cacheTtlMinutes, current.cacheTtlMinutes, 5, 1440),
                        minMatchScore: clampNumber(incoming.minMatchScore, current.minMatchScore, 0.2, 0.95),
                        requestTimeoutMs: clampNumber(incoming.requestTimeoutMs, current.requestTimeoutMs, 2000, 60000),
                        pageDelayMs: current.pageDelayMs,
                        rejectUnauthorized: incoming.rejectUnauthorized !== false
                    };
                    writeSavedSettings(getServer(), nextSettings);
                    rescheduleRefreshTimer(nextSettings);

                    var ok = false;
                    if (nextSettings.webhookUrl) {
                        ok = await refreshCache('settings-saved');
                    } else {
                        cache.users = [];
                        cache.lastUpdated = 0;
                        cache.lastError = 'URL вебхука Битрикс24 не настроен';
                    }

                    sendToClient(client, Object.assign({
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onSettingsResult',
                        requestId: requestId,
                        saved: true,
                        ok: nextSettings.webhookUrl ? ok : true,
                        error: nextSettings.webhookUrl && !ok ? cache.lastError : null
                    }, getSettingsSummary(nextSettings)));
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onSettingsResult',
                        requestId: requestId,
                        saved: false,
                        ok: false,
                        error: err && err.message ? err.message : 'Не удалось сохранить настройки'
                    });
                }
            })();
            return;
        }

        if (action === 'testMatch') {
            if (!isUserAdmin(client.user)) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    ok: false,
                    error: 'Требуются права администратора MeshCentral'
                });
                return;
            }
            var testName = typeof command.nodeName === 'string' ? command.nodeName.slice(0, 512) : '';
            lookupContacts(testName).then(function (result) {
                sendToClient(client, Object.assign({
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    testResult: result
                }, getSettingsSummary()));
            }).catch(function (err) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    ok: false,
                    error: err && err.message
                });
            });
            return;
        }

        if (action === 'refreshCache') {
            if (!isUserAdmin(client.user)) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    ok: false,
                    error: 'Требуются права администратора MeshCentral'
                });
                return;
            }
            refreshCache('manual').then(function (ok) {
                var payload = Object.assign({
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    refreshed: true,
                    ok: ok,
                    error: ok ? null : cache.lastError
                }, getSettingsSummary());
                sendToClient(client, payload);
            }).catch(function (err) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
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
        writeSavedSettings: writeSavedSettings,
        refreshCache: refreshCache,
        getCacheState: function () { return cache; }
    };

    // Browser-serialized hooks (MUST NOT reference Node closure variables)
    obj.exports = ['onWebUIStartupEnd', 'onDeviceRefreshEnd', 'onContactsResult', 'onSettingsResult', 'openSettings'];

    obj.onWebUIStartupEnd = function () {
        if (window.B24ContactsPlugin) {
            window.B24ContactsPlugin.inject();
            return;
        }

        var PLUGIN = 'b24contacts';
        var CARD_ID = 'b24-contacts-card';
        var STYLE_ID = 'b24-contacts-style';
        var ACCOUNT_LINK_ID = 'plugin_b24contactsSettings';
        var MODAL_ID = 'b24c-settings-overlay';
        var FRONTEND_CACHE_TTL_MS = 5 * 60 * 1000;
        var WS_TIMEOUT_MS = 8000;

        var pendingContacts = new Map();
        var pendingSettings = new Map();
        var responseCache = new Map();
        var requestSeq = 0;
        var configRevision = 0;

        function isCurrentUserAdmin() {
            var u = window.userinfo;
            if (!u) return false;
            if (u.siteadmin === -1 || u.siteadmin === 0xFFFFFFFF || u.siteadmin === true) return true;
            if (typeof u.siteadmin === 'number' && (u.siteadmin & 1) !== 0) return true;
            return false;
        }

        function injectStyles() {
            if (document.getElementById(STYLE_ID)) return;
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = [
                '#' + CARD_ID + '{clear:both;margin:10px 0 12px;padding:11px 14px;border:1px solid #d5dce6;border-radius:6px;background:rgba(248,250,252,0.95);color:#1e293b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;box-sizing:border-box;max-width:680px}',
                '#' + CARD_ID + ' .b24c-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}',
                '#' + CARD_ID + ' .b24c-title{margin:0;font-size:13px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px}',
                '#' + CARD_ID + ' .b24c-actions{display:flex;align-items:center;gap:4px}',
                '#' + CARD_ID + ' .b24c-icon-btn{background:transparent;border:1px solid #cbd5e1;border-radius:4px;color:#475569;cursor:pointer;font-size:12px;line-height:1;padding:3px 7px}',
                '#' + CARD_ID + ' .b24c-icon-btn:hover{background:#e2e8f0;color:#0f172a}',
                '#' + CARD_ID + ' .b24c-icon-btn:disabled{opacity:0.5;cursor:default}',
                '#' + CARD_ID + ' .b24c-loader-wrap{display:flex;align-items:center;gap:8px;color:#64748b;padding:2px 0}',
                '#' + CARD_ID + ' .b24c-spinner{width:14px;height:14px;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:b24c-spin 0.8s linear infinite;flex-shrink:0}',
                '#' + CARD_ID + ' .b24c-profile{font-size:12px;color:#475569;margin-bottom:6px;word-break:break-word}',
                '#' + CARD_ID + ' .b24c-phones{display:flex;flex-direction:column;gap:6px}',
                '#' + CARD_ID + ' .b24c-phone-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
                '#' + CARD_ID + ' .b24c-icon{width:15px;height:15px;flex-shrink:0;color:#2563eb}',
                '#' + CARD_ID + ' .b24c-label{color:#64748b;font-size:12px;min-width:86px}',
                '#' + CARD_ID + ' .b24c-link{color:#1d4ed8;font-weight:600;text-decoration:none}',
                '#' + CARD_ID + ' .b24c-link:hover{text-decoration:underline}',
                '#' + CARD_ID + ' .b24c-links{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0}',
                '#' + CARD_ID + ' .b24c-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#1d4ed8;font-size:12px;font-weight:600;text-decoration:none}',
                '#' + CARD_ID + ' .b24c-pill:hover{background:#eff6ff;border-color:#93c5fd;text-decoration:none}',
                '#' + CARD_ID + ' .b24c-pill svg{width:14px;height:14px;flex-shrink:0}',
                '#' + CARD_ID + ' .b24c-muted{color:#6b7280;font-size:12px}',
                '#' + CARD_ID + ' .b24c-error{color:#b91c1c;font-size:12px}',
                '#' + CARD_ID + ' .b24c-inline-btn{margin-top:6px;background:#1769f5;color:#fff;border:1px solid #1769f5;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer}',
                '#' + CARD_ID + ' .b24c-inline-btn:hover{background:#0758d8}',
                '#' + MODAL_ID + '{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(14,25,43,.58);box-sizing:border-box}',
                '#' + MODAL_ID + ' form{box-sizing:border-box;width:min(620px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;color:#202a35;border-radius:7px;box-shadow:0 16px 48px #0005;font:14px Arial,sans-serif}',
                '#' + MODAL_ID + ' *{box-sizing:border-box}',
                '#' + MODAL_ID + ' .b24c-m-header{padding:16px 22px 12px;border-bottom:1px solid #dfe5ed}',
                '#' + MODAL_ID + ' .b24c-m-header h2{margin:0;font-size:19px}',
                '#' + MODAL_ID + ' .b24c-m-sub{margin:4px 0 0;color:#5c6a7a;font-size:12px}',
                '#' + MODAL_ID + ' .b24c-m-body{padding:14px 22px;display:flex;flex-direction:column;gap:12px}',
                '#' + MODAL_ID + ' .b24c-m-card{padding:12px 14px;border:1px solid #dfe5ed;border-radius:5px;background:#f8fafc}',
                '#' + MODAL_ID + ' label{display:block;color:#334155;font-size:12px;font-weight:600;margin-bottom:8px}',
                '#' + MODAL_ID + ' label:last-child{margin-bottom:0}',
                '#' + MODAL_ID + ' input:not([type=checkbox]){display:block;width:100%;height:31px;margin:4px 0 0;padding:5px 8px;border:1px solid #b9c4d2;border-radius:3px;background:#fff;color:#202a35;font:13px Arial,sans-serif}',
                '#' + MODAL_ID + ' input:focus{outline:2px solid #90bcff;border-color:#1769f5}',
                '#' + MODAL_ID + ' .b24c-m-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}',
                '#' + MODAL_ID + ' .b24c-m-check{display:flex;align-items:center;gap:6px;font-weight:400;margin-top:8px}',
                '#' + MODAL_ID + ' .b24c-m-note{margin:4px 0 8px;color:#5c6a7a;font-size:12px;word-break:break-all}',
                '#' + MODAL_ID + ' .b24c-m-test-row{display:flex;gap:8px;align-items:center}',
                '#' + MODAL_ID + ' .b24c-m-test-row input{flex:1;margin:0}',
                '#' + MODAL_ID + ' .b24c-m-test-out{margin-top:8px;font-size:12px;color:#1e293b;white-space:pre-wrap}',
                '#' + MODAL_ID + ' .b24c-m-footer{padding:10px 22px 14px;border-top:1px solid #e5eaf0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
                '#' + MODAL_ID + ' .b24c-m-status{flex:1;min-width:160px;margin:0;color:#40536b;font-size:12px}',
                '#' + MODAL_ID + ' button:not(.b24c-m-primary){background:#fff;color:#285580;border:1px solid #b9c9dc;border-radius:3px;padding:6px 10px;cursor:pointer;font:13px Arial,sans-serif}',
                '#' + MODAL_ID + ' button:not(.b24c-m-primary):hover{background:#edf4ff}',
                '#' + MODAL_ID + ' .b24c-m-primary{background:#1769f5;color:#fff;border:1px solid #1769f5;border-radius:3px;padding:6px 12px;cursor:pointer;font:13px Arial,sans-serif}',
                '#' + MODAL_ID + ' .b24c-m-primary:hover{background:#0758d8}',
                '@keyframes b24c-spin{to{transform:rotate(360deg)}}',
                '@media(max-width:600px){#' + MODAL_ID + ' .b24c-m-grid{grid-template-columns:1fr}}'
            ].join('\n');
            document.head.appendChild(style);
        }

        function createSvgIcon(kind) {
            var ns = 'http://www.w3.org/2000/svg';
            var svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('class', 'b24c-icon');
            svg.setAttribute('aria-hidden', 'true');

            if (kind === 'mobile') {
                var rect = document.createElementNS(ns, 'rect');
                rect.setAttribute('x', '6');
                rect.setAttribute('y', '2');
                rect.setAttribute('width', '12');
                rect.setAttribute('height', '20');
                rect.setAttribute('rx', '2');
                rect.setAttribute('ry', '2');
                var dot = document.createElementNS(ns, 'line');
                dot.setAttribute('x1', '12');
                dot.setAttribute('y1', '18');
                dot.setAttribute('x2', '12.01');
                dot.setAttribute('y2', '18');
                svg.appendChild(rect);
                svg.appendChild(dot);
            } else if (kind === 'chat') {
                var chatPath = document.createElementNS(ns, 'path');
                chatPath.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
                svg.appendChild(chatPath);
            } else if (kind === 'user') {
                var userBody = document.createElementNS(ns, 'path');
                userBody.setAttribute('d', 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2');
                var userHead = document.createElementNS(ns, 'circle');
                userHead.setAttribute('cx', '12');
                userHead.setAttribute('cy', '7');
                userHead.setAttribute('r', '4');
                svg.appendChild(userBody);
                svg.appendChild(userHead);
            } else {
                var p = document.createElementNS(ns, 'path');
                p.setAttribute('d', 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z');
                svg.appendChild(p);
            }
            return svg;
        }

        function isSummaryVisible() {
            var p10 = document.getElementById('p10');
            if (!p10) return true;
            return p10.style.display !== 'none';
        }

        function getTargetContainer() {
            return (
                document.getElementById('p10info') ||
                document.getElementById('p10html3') ||
                document.getElementById('p10html') ||
                document.getElementById('p10')
            );
        }

        function ensureAccountLink() {
            if (!isCurrentUserAdmin()) return;
            var host = document.querySelector('#p2AccountActions > p.mL') || document.getElementById('p2AccountActions');
            if (!host || document.getElementById(ACCOUNT_LINK_ID)) return;

            var wrap = document.createElement('span');
            wrap.id = ACCOUNT_LINK_ID;
            wrap.style.display = 'block';

            var link = document.createElement('a');
            link.href = '#';
            link.textContent = 'Настройка Битрикс24 (Контакты)';
            link.onclick = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                openSettingsModal();
                return false;
            };

            wrap.appendChild(link);
            host.appendChild(wrap);
        }

        function placeCardInContainer(container, card) {
            var anchor = container.querySelector('table, #p10html');
            while (anchor && anchor.parentNode && anchor.parentNode !== container) {
                anchor = anchor.parentNode;
            }
            if (anchor && anchor.parentNode === container) {
                container.insertBefore(card, anchor);
                return;
            }
            var lastBtn = null;
            var children = container.children || [];
            for (var i = 0; i < children.length; i++) {
                var ch = children[i];
                if (ch !== card && (ch.id === 'zabbix-open' || ch.id === 'restic-open' || ch.tagName === 'BUTTON')) {
                    lastBtn = ch;
                }
            }
            if (lastBtn) {
                container.insertBefore(card, lastBtn.nextSibling || null);
            } else {
                container.insertBefore(card, container.firstChild || null);
            }
        }

        function ensureCardElement(node) {
            injectStyles();
            var container = getTargetContainer();
            if (!container) return null;

            var card = document.getElementById(CARD_ID);
            if (card && card.parentNode !== container) {
                card.remove();
                card = null;
            }
            if (!card) {
                card = document.createElement('div');
                card.id = CARD_ID;

                var header = document.createElement('div');
                header.className = 'b24c-header';

                var title = document.createElement('div');
                title.className = 'b24c-title';
                title.textContent = 'Контакты аптеки (Битрикс24)';

                var actions = document.createElement('div');
                actions.className = 'b24c-actions';

                if (isCurrentUserAdmin()) {
                    var cfgBtn = document.createElement('button');
                    cfgBtn.type = 'button';
                    cfgBtn.className = 'b24c-icon-btn b24c-cfg-btn';
                    cfgBtn.title = 'Настройки подключения Битрикс24';
                    cfgBtn.textContent = '⚙';
                    cfgBtn.onclick = function () { openSettingsModal(); };
                    actions.appendChild(cfgBtn);
                }

                var refreshBtn = document.createElement('button');
                refreshBtn.type = 'button';
                refreshBtn.className = 'b24c-icon-btn b24c-refresh';
                refreshBtn.title = 'Обновить контакты';
                refreshBtn.textContent = '↻';
                refreshBtn.onclick = function () {
                    if (window.currentNode) {
                        loadContactsForNode(window.currentNode, true);
                    }
                };
                actions.appendChild(refreshBtn);

                header.appendChild(title);
                header.appendChild(actions);

                var body = document.createElement('div');
                body.className = 'b24c-body';

                card.appendChild(header);
                card.appendChild(body);
                placeCardInContainer(container, card);
            }

            if (node) {
                card.dataset.nodeId = node._id || '';
                card.dataset.nodeName = node.name || '';
                card.dataset.configRev = String(configRevision);
            }
            return card;
        }

        function setRefreshBusy(card, busy) {
            if (!card) return;
            var btn = card.querySelector('.b24c-refresh');
            if (btn) btn.disabled = !!busy;
        }

        function renderLoading(node) {
            var card = ensureCardElement(node);
            if (!card) return;
            setRefreshBusy(card, true);

            var body = card.querySelector('.b24c-body');
            body.replaceChildren();

            var wrap = document.createElement('div');
            wrap.className = 'b24c-loader-wrap';

            var spinner = document.createElement('span');
            spinner.className = 'b24c-spinner';
            spinner.setAttribute('aria-hidden', 'true');

            var text = document.createElement('span');
            text.textContent = 'Поиск контактов в Битрикс24...';

            wrap.appendChild(spinner);
            wrap.appendChild(text);
            body.appendChild(wrap);
        }

        function isSafeTelHref(href) {
            return typeof href === 'string' && /^tel:[+\d*#]+$/.test(href);
        }

        function isSafeHttpUrl(url) {
            return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
        }

        function createActionLink(url, text, iconKind) {
            var a = document.createElement('a');
            a.className = 'b24c-pill';
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.appendChild(createSvgIcon(iconKind));
            var span = document.createElement('span');
            span.textContent = text;
            a.appendChild(span);
            return a;
        }

        function renderResult(node, data) {
            var card = ensureCardElement(node);
            if (!card) return;
            setRefreshBusy(card, false);

            var body = card.querySelector('.b24c-body');
            body.replaceChildren();

            if (!data || data.ok === false) {
                var errEl = document.createElement('div');
                errEl.className = (data && data.needsConfig) ? 'b24c-muted' : 'b24c-error';
                errEl.textContent = (data && data.error) ? data.error : 'Не удалось загрузить контакты Битрикс24';
                body.appendChild(errEl);

                if (data && data.needsConfig && isCurrentUserAdmin()) {
                    var setupBtn = document.createElement('button');
                    setupBtn.type = 'button';
                    setupBtn.className = 'b24c-inline-btn';
                    setupBtn.textContent = 'Настроить подключение Битрикс24';
                    setupBtn.onclick = function () { openSettingsModal(); };
                    body.appendChild(setupBtn);
                }
                return;
            }

            if (!data.matched || !data.profile) {
                var emptyEl = document.createElement('div');
                emptyEl.className = 'b24c-muted';
                emptyEl.textContent = 'Связанный профиль в Битрикс24 не найден';
                body.appendChild(emptyEl);
                return;
            }

            if (data.profile.displayName) {
                var profEl = document.createElement('div');
                profEl.className = 'b24c-profile';
                profEl.textContent = data.profile.displayName;
                body.appendChild(profEl);
            }

            var phones = Array.isArray(data.phones) ? data.phones : [];
            if (phones.length === 0) {
                var noPhones = document.createElement('div');
                noPhones.className = 'b24c-muted';
                noPhones.textContent = 'Профиль найден, но номера телефонов не указаны';
                body.appendChild(noPhones);
            } else {
                var list = document.createElement('div');
                list.className = 'b24c-phones';

                for (var i = 0; i < phones.length; i++) {
                    var phone = phones[i];
                    if (!phone || !phone.display) continue;

                    var row = document.createElement('div');
                    row.className = 'b24c-phone-row';

                    var icon = createSvgIcon(phone.type === 'mobile' ? 'mobile' : 'work');
                    var label = document.createElement('span');
                    label.className = 'b24c-label';
                    label.textContent = (phone.label || (phone.type === 'mobile' ? 'Мобильный' : 'Рабочий')) + ':';

                    row.appendChild(icon);
                    row.appendChild(label);

                    if (isSafeTelHref(phone.href)) {
                        var link = document.createElement('a');
                        link.className = 'b24c-link';
                        link.href = phone.href;
                        link.textContent = phone.display;
                        row.appendChild(link);
                    } else {
                        var span = document.createElement('span');
                        span.textContent = phone.display;
                        row.appendChild(span);
                    }

                    list.appendChild(row);
                }

                body.appendChild(list);
            }

            var hasChat = isSafeHttpUrl(data.profile.chatUrl);
            var hasProfile = isSafeHttpUrl(data.profile.profileUrl);
            if (hasChat || hasProfile) {
                var linksBar = document.createElement('div');
                linksBar.className = 'b24c-links';
                if (hasChat) linksBar.appendChild(createActionLink(data.profile.chatUrl, 'Чат в Битрикс24', 'chat'));
                if (hasProfile) linksBar.appendChild(createActionLink(data.profile.profileUrl, 'Профиль в Битрикс24', 'user'));
                body.appendChild(linksBar);
            }
        }

        function sendPluginAction(pluginaction, extra, pendingMap) {
            return new Promise(function (resolve, reject) {
                if (typeof meshserver === 'undefined' || !meshserver || typeof meshserver.send !== 'function') {
                    return reject(new Error('WebSocket MeshCentral недоступен'));
                }
                var requestId = 'b24c_' + Date.now() + '_' + (++requestSeq);
                var timer = setTimeout(function () {
                    pendingMap.delete(requestId);
                    reject(new Error('Таймаут ответа сервера MeshCentral'));
                }, WS_TIMEOUT_MS);

                pendingMap.set(requestId, {
                    resolve: function (msg) {
                        clearTimeout(timer);
                        resolve(msg);
                    }
                });

                try {
                    meshserver.send(Object.assign({
                        action: 'plugin',
                        plugin: PLUGIN,
                        pluginaction: pluginaction,
                        requestId: requestId
                    }, extra || {}));
                } catch (err) {
                    clearTimeout(timer);
                    pendingMap.delete(requestId);
                    reject(err);
                }
            });
        }

        function loadContactsForNode(node, forceRefresh) {
            if (!node || !node._id) return;
            if (!isSummaryVisible()) return;
            if (!getTargetContainer()) return;

            var nodeName = typeof node.name === 'string' ? node.name : '';
            var key = node._id + '|' + nodeName;
            var existingCard = document.getElementById(CARD_ID);

            if (!forceRefresh && existingCard && existingCard.dataset.nodeId === (node._id || '') && existingCard.dataset.nodeName === nodeName && existingCard.dataset.configRev === String(configRevision)) {
                return;
            }

            if (!forceRefresh && responseCache.has(key)) {
                var cached = responseCache.get(key);
                if ((Date.now() - cached.ts) < FRONTEND_CACHE_TTL_MS) {
                    renderResult(node, cached.data);
                    return;
                }
                responseCache.delete(key);
            }

            renderLoading(node);

            sendPluginAction('getContacts', { nodeId: node._id || '', nodeName: nodeName }, pendingContacts)
                .then(function (data) {
                    if (data && data.ok !== false) {
                        responseCache.set(key, { ts: Date.now(), data: data });
                    }
                    var activeNode = window.currentNode;
                    var activeKey = activeNode ? (activeNode._id + '|' + (activeNode.name || '')) : '';
                    if (activeKey && activeKey !== key) return;
                    renderResult(activeNode || node, data);
                })
                .catch(function (err) {
                    var activeNode = window.currentNode;
                    var activeKey = activeNode ? (activeNode._id + '|' + (activeNode.name || '')) : '';
                    if (activeKey && activeKey !== key) return;
                    renderResult(activeNode || node, {
                        ok: false,
                        matched: false,
                        error: (err && err.message) ? err.message : 'Ошибка запроса к серверу MeshCentral'
                    });
                });
        }

        function formatStatusLine(msg) {
            var updated = msg.lastUpdated ? new Date(msg.lastUpdated).toLocaleString() : 'не обновлялся';
            var line = 'Профилей в кеше: ' + (msg.cacheSize || 0) + ' · Обновлён: ' + updated;
            if (msg.lastError) line += ' · Ошибка: ' + msg.lastError;
            return line;
        }

        function openSettingsModal() {
            injectStyles();
            if (document.getElementById(MODAL_ID)) return;

            var overlay = document.createElement('div');
            overlay.id = MODAL_ID;
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            ['keydown', 'keypress', 'keyup'].forEach(function (type) {
                overlay.addEventListener(type, function (e) { e.stopPropagation(); });
            });

            var form = document.createElement('form');

            var header = document.createElement('div');
            header.className = 'b24c-m-header';
            var h2 = document.createElement('h2');
            h2.textContent = 'Настройка Битрикс24 (Контакты аптек)';
            var sub = document.createElement('p');
            sub.className = 'b24c-m-sub';
            sub.textContent = 'Загрузка состояния кеша...';
            header.appendChild(h2);
            header.appendChild(sub);

            var body = document.createElement('div');
            body.className = 'b24c-m-body';

            var connCard = document.createElement('section');
            connCard.className = 'b24c-m-card';

            var webhookLabel = document.createElement('label');
            webhookLabel.textContent = 'URL входящего вебхука Битрикс24';
            var webhookInput = document.createElement('input');
            webhookInput.type = 'url';
            webhookInput.name = 'webhookUrl';
            webhookInput.placeholder = 'https://portal.bitrix24.ru/rest/1/ваш_токен/';
            webhookInput.autocomplete = 'off';
            webhookLabel.appendChild(webhookInput);

            var currentWebhookNote = document.createElement('p');
            currentWebhookNote.className = 'b24c-m-note';
            currentWebhookNote.textContent = 'Текущий вебхук: не настроен';

            var grid = document.createElement('div');
            grid.className = 'b24c-m-grid';

            function makeNumField(labelText, name, min, max, step, defVal) {
                var lbl = document.createElement('label');
                lbl.textContent = labelText;
                var inp = document.createElement('input');
                inp.type = 'number';
                inp.name = name;
                inp.min = String(min);
                inp.max = String(max);
                if (step) inp.step = String(step);
                inp.value = String(defVal);
                lbl.appendChild(inp);
                return { lbl: lbl, inp: inp };
            }

            var ttlField = makeNumField('Обновление кеша (мин)', 'cacheTtlMinutes', 5, 1440, 1, 90);
            var scoreField = makeNumField('Порог совпадения', 'minMatchScore', 0.2, 0.95, 0.05, 0.55);
            var timeoutField = makeNumField('Таймаут (мс)', 'requestTimeoutMs', 2000, 60000, 500, 15000);
            grid.appendChild(ttlField.lbl);
            grid.appendChild(scoreField.lbl);
            grid.appendChild(timeoutField.lbl);

            var sslLabel = document.createElement('label');
            sslLabel.className = 'b24c-m-check';
            var sslInput = document.createElement('input');
            sslInput.type = 'checkbox';
            sslInput.name = 'rejectUnauthorized';
            sslInput.checked = true;
            var sslText = document.createElement('span');
            sslText.textContent = 'Проверять SSL-сертификат (TLS)';
            sslLabel.appendChild(sslInput);
            sslLabel.appendChild(sslText);

            connCard.appendChild(webhookLabel);
            connCard.appendChild(currentWebhookNote);
            connCard.appendChild(grid);
            connCard.appendChild(sslLabel);

            var testCard = document.createElement('section');
            testCard.className = 'b24c-m-card';
            var testLabel = document.createElement('label');
            testLabel.textContent = 'Проверка сопоставления по имени ПК';
            var testRow = document.createElement('div');
            testRow.className = 'b24c-m-test-row';
            var testInput = document.createElement('input');
            testInput.type = 'text';
            testInput.placeholder = 'Например: ст.Калининская ул.Советская, д.38 - касса ИБ';
            if (window.currentNode && window.currentNode.name) {
                testInput.value = window.currentNode.name;
            }
            var testBtn = document.createElement('button');
            testBtn.type = 'button';
            testBtn.textContent = 'Проверить';
            testRow.appendChild(testInput);
            testRow.appendChild(testBtn);
            var testOut = document.createElement('div');
            testOut.className = 'b24c-m-test-out';
            testCard.appendChild(testLabel);
            testCard.appendChild(testRow);
            testCard.appendChild(testOut);

            body.appendChild(connCard);
            body.appendChild(testCard);

            var footer = document.createElement('div');
            footer.className = 'b24c-m-footer';
            var status = document.createElement('p');
            status.className = 'b24c-m-status';
            status.setAttribute('role', 'status');
            status.textContent = 'Загрузка текущих настроек...';

            var refreshNowBtn = document.createElement('button');
            refreshNowBtn.type = 'button';
            refreshNowBtn.textContent = 'Обновить кеш';

            var closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.textContent = 'Закрыть';

            var saveBtn = document.createElement('button');
            saveBtn.type = 'submit';
            saveBtn.className = 'b24c-m-primary';
            saveBtn.textContent = 'Сохранить и синхронизировать';

            footer.appendChild(status);
            footer.appendChild(refreshNowBtn);
            footer.appendChild(closeBtn);
            footer.appendChild(saveBtn);

            form.appendChild(header);
            form.appendChild(body);
            form.appendChild(footer);
            overlay.appendChild(form);
            document.body.appendChild(overlay);

            function applyState(msg) {
                if (!msg) return;
                sub.textContent = formatStatusLine(msg);
                currentWebhookNote.textContent = msg.hasWebhook
                    ? ('Текущий вебхук: ' + msg.maskedWebhookUrl + ' (оставьте поле пустым, чтобы не менять)')
                    : 'Текущий вебхук: не настроен';
                if (msg.cacheTtlMinutes != null) ttlField.inp.value = String(msg.cacheTtlMinutes);
                if (msg.minMatchScore != null) scoreField.inp.value = String(msg.minMatchScore);
                if (msg.requestTimeoutMs != null) timeoutField.inp.value = String(msg.requestTimeoutMs);
                if (typeof msg.rejectUnauthorized === 'boolean') sslInput.checked = msg.rejectUnauthorized;
            }

            function setBusy(busy) {
                saveBtn.disabled = !!busy;
                refreshNowBtn.disabled = !!busy;
                testBtn.disabled = !!busy;
            }

            closeBtn.onclick = function () { overlay.remove(); };
            overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

            refreshNowBtn.onclick = function () {
                setBusy(true);
                status.textContent = 'Загрузка пользователей из Битрикс24...';
                sendPluginAction('refreshCache', {}, pendingSettings)
                    .then(function (msg) {
                        setBusy(false);
                        applyState(msg);
                        configRevision++;
                        responseCache.clear();
                        if (window.currentNode) loadContactsForNode(window.currentNode, true);
                        status.textContent = msg.ok
                            ? ('Кеш обновлён: ' + (msg.cacheSize || 0) + ' профилей.')
                            : ('Ошибка: ' + (msg.error || 'не удалось обновить кеш'));
                    })
                    .catch(function (err) {
                        setBusy(false);
                        status.textContent = 'Ошибка: ' + err.message;
                    });
            };

            testBtn.onclick = function () {
                var q = testInput.value.trim();
                if (!q) {
                    testOut.textContent = 'Введите имя компьютера для проверки.';
                    return;
                }
                setBusy(true);
                testOut.textContent = 'Поиск...';
                sendPluginAction('testMatch', { nodeName: q }, pendingSettings)
                    .then(function (msg) {
                        setBusy(false);
                        applyState(msg);
                        var res = msg.testResult;
                        if (!res || res.ok === false) {
                            testOut.textContent = (res && res.error) ? res.error : (msg.error || 'Ошибка проверки');
                            return;
                        }
                        if (!res.matched || !res.profile) {
                            testOut.textContent = 'Совпадение не найдено (лучший балл: ' + (res.score || 0) + ').';
                            return;
                        }
                        var lines = ['Профиль: ' + res.profile.displayName + ' (балл: ' + res.score + ')'];
                        if (Array.isArray(res.phones) && res.phones.length) {
                            res.phones.forEach(function (p) { lines.push(p.label + ': ' + p.display); });
                        } else {
                            lines.push('Телефоны в профиле не заполнены.');
                        }
                        testOut.textContent = lines.join('\n');
                    })
                    .catch(function (err) {
                        setBusy(false);
                        testOut.textContent = 'Ошибка: ' + err.message;
                    });
            };

            form.onsubmit = function (e) {
                e.preventDefault();
                setBusy(true);
                status.textContent = 'Сохранение настроек и загрузка справочника...';
                sendPluginAction('saveSettings', {
                    settings: {
                        webhookUrl: webhookInput.value.trim(),
                        cacheTtlMinutes: Number(ttlField.inp.value),
                        minMatchScore: Number(scoreField.inp.value),
                        requestTimeoutMs: Number(timeoutField.inp.value),
                        rejectUnauthorized: sslInput.checked
                    }
                }, pendingSettings)
                    .then(function (msg) {
                        setBusy(false);
                        applyState(msg);
                        webhookInput.value = '';
                        configRevision++;
                        responseCache.clear();
                        if (window.currentNode) loadContactsForNode(window.currentNode, true);
                        if (msg.saved && msg.ok) {
                            status.textContent = 'Сохранено. Загружено профилей: ' + (msg.cacheSize || 0) + '.';
                        } else if (msg.saved) {
                            status.textContent = 'Настройки сохранены, но синхронизация завершилась с ошибкой: ' + (msg.error || '');
                        } else {
                            status.textContent = 'Ошибка: ' + (msg.error || 'не удалось сохранить');
                        }
                    })
                    .catch(function (err) {
                        setBusy(false);
                        status.textContent = 'Ошибка: ' + err.message;
                    });
            };

            setBusy(true);
            sendPluginAction('getSettings', {}, pendingSettings)
                .then(function (msg) {
                    setBusy(false);
                    applyState(msg);
                    status.textContent = msg.ok ? 'Готово.' : ('Ошибка: ' + (msg.error || ''));
                })
                .catch(function (err) {
                    setBusy(false);
                    status.textContent = 'Ошибка загрузки настроек: ' + err.message;
                });
        }

        function handleRefresh() {
            try {
                ensureAccountLink();
                if (!window.currentNode || !window.currentNode._id) return;
                loadContactsForNode(window.currentNode, false);
            } catch (e) {}
        }

        function setupObservers() {
            var summaryBtn = document.getElementById('MainDevGeneral') || document.getElementById('MainDevSummary');
            if (summaryBtn && !summaryBtn._b24ContactsBound) {
                summaryBtn._b24ContactsBound = true;
                summaryBtn.addEventListener('click', function () {
                    setTimeout(handleRefresh, 60);
                });
            }

            var p10 = document.getElementById('p10');
            if (p10 && typeof MutationObserver === 'function' && !p10._b24ContactsObserver) {
                var scheduled = false;
                var observer = new MutationObserver(function () {
                    if (scheduled) return;
                    scheduled = true;
                    setTimeout(function () {
                        scheduled = false;
                        if (!window.currentNode || !isSummaryVisible()) return;
                        var card = document.getElementById(CARD_ID);
                        var activeName = typeof window.currentNode.name === 'string' ? window.currentNode.name : '';
                        if (!card || card.dataset.nodeId !== (window.currentNode._id || '') || card.dataset.nodeName !== activeName || card.dataset.configRev !== String(configRevision)) {
                            handleRefresh();
                        }
                    }, 80);
                });
                observer.observe(p10, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
                p10._b24ContactsObserver = observer;
            }
        }

        window.B24ContactsPlugin = {
            inject: function () {
                setupObservers();
                handleRefresh();
            },
            onDeviceRefreshEnd: function () {
                setupObservers();
                handleRefresh();
            },
            onContactsResult: function (message) {
                if (!message || typeof message !== 'object') return;
                var reqId = message.requestId;
                if (reqId && pendingContacts.has(reqId)) {
                    var entry = pendingContacts.get(reqId);
                    pendingContacts.delete(reqId);
                    entry.resolve(message);
                }
            },
            onSettingsResult: function (message) {
                if (!message || typeof message !== 'object') return;
                var reqId = message.requestId;
                if (reqId && pendingSettings.has(reqId)) {
                    var entry = pendingSettings.get(reqId);
                    pendingSettings.delete(reqId);
                    entry.resolve(message);
                }
            },
            openSettings: openSettingsModal,
            refresh: function () {
                if (window.currentNode) {
                    loadContactsForNode(window.currentNode, true);
                }
            }
        };

        window.B24ContactsPlugin.inject();
        setInterval(function () {
            if (window.B24ContactsPlugin) window.B24ContactsPlugin.inject();
        }, 1500);
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

    obj.onSettingsResult = function (server, message) {
        var payload = (message && typeof message === 'object') ? message : server;
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.onSettingsResult === 'function') {
            window.B24ContactsPlugin.onSettingsResult(payload);
        }
    };

    obj.openSettings = function () {
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.openSettings === 'function') {
            window.B24ContactsPlugin.openSettings();
        }
    };

    return obj;
}

module.exports = createPlugin;
module.exports.b24contacts = createPlugin;
