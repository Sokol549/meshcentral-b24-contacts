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

function buildMethodUrl(webhookUrl, methodName) {
    if (typeof webhookUrl !== 'string' || !webhookUrl.trim()) {
        throw new Error('Bitrix24 webhookUrl не настроен');
    }
    var method = String(methodName || 'user.get').replace(/\.json$/i, '');
    var trimmed = webhookUrl.trim().replace(/\/+$/, '');
    var parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Неподдерживаемый протокол webhookUrl: ' + parsed.protocol);
    }
    var restBase = /^(.*\/rest\/\d+\/[^/]+)(?:\/.*)?$/i.exec(parsed.pathname);
    if (restBase) {
        parsed.pathname = restBase[1] + '/' + method + '.json';
    } else {
        var cleanPath = parsed.pathname.replace(/\/+$/, '');
        if (!new RegExp('\\/' + method.replace('.', '\\.') + '(\\.json)?$', 'i').test(cleanPath)) {
            parsed.pathname = cleanPath + '/' + method + '.json';
        }
    }
    return parsed.toString();
}

function buildUserGetUrl(webhookUrl) {
    return buildMethodUrl(webhookUrl, 'user.get');
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

function normalizeManualLinks(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
        var nodeId = String(keys[i] || '').trim();
        if (!nodeId) continue;
        var val = raw[keys[i]];
        if (typeof val === 'string' || typeof val === 'number') {
            var idOnly = String(val).trim();
            if (idOnly) {
                out[nodeId] = { b24UserId: idOnly, nodeName: '', updatedAt: 0 };
            }
        } else if (val && typeof val === 'object') {
            var b24Id = val.b24UserId != null ? String(val.b24UserId).trim() : '';
            if (b24Id) {
                out[nodeId] = {
                    b24UserId: b24Id,
                    nodeName: typeof val.nodeName === 'string' ? val.nodeName.slice(0, 512) : '',
                    updatedAt: Number(val.updatedAt) || 0
                };
            }
        }
    }
    return out;
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
        oauthClientId: typeof merged.oauthClientId === 'string' ? merged.oauthClientId.trim() : '',
        oauthClientSecret: typeof merged.oauthClientSecret === 'string' ? merged.oauthClientSecret.trim() : '',
        cacheTtlMinutes: clampNumber(merged.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES, 5, 1440),
        minMatchScore: clampNumber(merged.minMatchScore, DEFAULT_MIN_MATCH_SCORE, 0.2, 0.95),
        requestTimeoutMs: clampNumber(merged.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 2000, 60000),
        pageDelayMs: clampNumber(merged.pageDelayMs, DEFAULT_PAGE_DELAY_MS, 0, 5000),
        rejectUnauthorized: merged.rejectUnauthorized !== false,
        manualLinks: normalizeManualLinks(merged.manualLinks)
    };
}

function getUserAuthDir(server) {
    if (!server || !server.datapath) return null;
    return path.join(server.datapath, 'b24contacts-users');
}

function getOrCreateStorageKey(server) {
    var dir = getUserAuthDir(server);
    if (!dir) return null;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    var keyFile = path.join(dir, '.key');
    if (fs.existsSync(keyFile)) {
        var existing = fs.readFileSync(keyFile);
        if (existing.length === 32) return existing;
    }
    var fresh = crypto.randomBytes(32);
    var tmpKey = keyFile + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
        fs.writeFileSync(tmpKey, fresh, { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpKey, keyFile);
    } finally {
        try { if (fs.existsSync(tmpKey)) fs.unlinkSync(tmpKey); } catch (e) {}
    }
    return fresh;
}

function getUserAuthFilePath(server, meshUserId) {
    var dir = getUserAuthDir(server);
    if (!dir || typeof meshUserId !== 'string' || !meshUserId) return null;
    var hash = crypto.createHash('sha256').update(meshUserId).digest('hex');
    return path.join(dir, hash + '.json');
}

function readUserChatAuth(server, meshUserId) {
    var filePath = getUserAuthFilePath(server, meshUserId);
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath)) return null;
        var key = getOrCreateStorageKey(server);
        if (!key) return null;
        var envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        var decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        var plain = Buffer.concat([
            decipher.update(Buffer.from(envelope.data, 'base64')),
            decipher.final()
        ]).toString('utf8');
        return JSON.parse(plain);
    } catch (e) {
        console.warn('[b24contacts] Не удалось прочитать сессию чата пользователя:', e.message);
        return null;
    }
}

function writeUserChatAuth(server, meshUserId, authObj) {
    var filePath = getUserAuthFilePath(server, meshUserId);
    if (!filePath) throw new Error('Каталог данных MeshCentral (datapath) недоступен');
    var key = getOrCreateStorageKey(server);
    var iv = crypto.randomBytes(12);
    var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    var enc = Buffer.concat([cipher.update(JSON.stringify(authObj), 'utf8'), cipher.final()]);
    var tag = cipher.getAuthTag();
    var envelope = {
        v: 1,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: enc.toString('base64')
    };
    var tmpPath = filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpPath, filePath);
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    }
}

function deleteUserChatAuth(server, meshUserId) {
    var filePath = getUserAuthFilePath(server, meshUserId);
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
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

function requestJson(targetUrl, bodyString, contentType, options, redirectCount) {
    var hops = redirectCount || 0;
    return new Promise(function (resolve, reject) {
        try {
            var parsed = new URL(targetUrl);
            var body = bodyString || '';
            var transport = parsed.protocol === 'http:' ? http : https;
            var reqOpts = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || undefined,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': contentType,
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
                    requestJson(nextUrl, bodyString, contentType, options, hops + 1).then(resolve, reject);
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
                        var parseErr = new Error('Некорректный JSON от Bitrix24 (HTTP ' + status + ')');
                        parseErr.httpStatus = status;
                        reject(parseErr);
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        var errMsg = (data && (data.error_description || data.error)) || ('HTTP ' + status);
                        var httpErr = new Error('Ошибка Bitrix24: ' + errMsg);
                        httpErr.httpStatus = status;
                        httpErr.b24Code = data && data.error;
                        reject(httpErr);
                        return;
                    }
                    if (data && data.error) {
                        var apiErr = new Error('Ошибка Bitrix24 API: ' + (data.error_description || data.error));
                        apiErr.httpStatus = status;
                        apiErr.b24Code = data.error;
                        reject(apiErr);
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

function postJson(targetUrl, payload, options) {
    return requestJson(targetUrl, JSON.stringify(payload || {}), 'application/json', options, 0);
}

function postForm(targetUrl, paramsObj, options) {
    var usp = new URLSearchParams();
    Object.keys(paramsObj || {}).forEach(function (k) {
        if (paramsObj[k] != null) usp.set(k, String(paramsObj[k]));
    });
    return requestJson(targetUrl, usp.toString(), 'application/x-www-form-urlencoded', options, 0);
}

function cleanBitrixBbCode(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/\[BR\s*\/?\]/gi, '\n')
        .replace(/\[URL=([^\]]*)\]([\s\S]*?)\[\/URL\]/gi, '$2')
        .replace(/\[USER=[^\]]*\]([\s\S]*?)\[\/USER\]/gi, '$1')
        .replace(/\[CHAT=[^\]]*\]([\s\S]*?)\[\/CHAT\]/gi, '$1')
        .replace(/\[\/?(?:B|I|U|S|SIZE|COLOR|QUOTE|CODE|LIST|DISK)[^\]]*\]/gi, '')
        .trim();
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

    function enrichProfileWithLinks(profile, settings) {
        if (!profile || !profile.id) return profile;
        var portalOrigin = extractPortalOrigin(settings.webhookUrl, settings.portalUrl);
        var links = buildBitrixUserLinks(profile.id, portalOrigin);
        return Object.assign({}, profile, links);
    }

    async function lookupContacts(nodeName, nodeId) {
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

        var safeNodeId = typeof nodeId === 'string' ? nodeId.trim() : '';
        var manualEntry = (safeNodeId && settings.manualLinks && settings.manualLinks[safeNodeId])
            ? settings.manualLinks[safeNodeId]
            : null;
        if (manualEntry && manualEntry.b24UserId) {
            var manualProfile = null;
            for (var i = 0; i < cache.users.length; i++) {
                if (cache.users[i] && String(cache.users[i].id) === String(manualEntry.b24UserId)) {
                    manualProfile = enrichProfileWithLinks(cache.users[i], settings);
                    break;
                }
            }
            if (manualProfile) {
                return {
                    ok: true,
                    matched: true,
                    manualLinked: true,
                    manualB24UserId: String(manualEntry.b24UserId),
                    score: 1,
                    profile: manualProfile,
                    phones: manualProfile.phones || [],
                    cacheSize: cache.users.length,
                    lastUpdated: cache.lastUpdated
                };
            }
            return {
                ok: true,
                matched: false,
                manualLinked: true,
                missingManualUser: true,
                manualB24UserId: String(manualEntry.b24UserId),
                score: 0,
                profile: null,
                phones: [],
                error: 'Привязанный вручную профиль Битрикс24 (ID ' + manualEntry.b24UserId + ') не найден среди активных пользователей',
                cacheSize: cache.users.length,
                lastUpdated: cache.lastUpdated
            };
        }

        var match = findBestContactMatch(nodeName, cache.users, settings.minMatchScore);
        var profile = enrichProfileWithLinks(match.profile, settings);
        return {
            ok: true,
            matched: match.matched,
            manualLinked: false,
            score: match.score,
            profile: profile,
            phones: profile ? profile.phones : [],
            cacheSize: cache.users.length,
            lastUpdated: cache.lastUpdated
        };
    }

    var oauthStates = new Map();

    function cleanupOAuthStates() {
        var now = Date.now();
        oauthStates.forEach(function (entry, key) {
            if (!entry || (now - entry.createdAt) > 10 * 60 * 1000) {
                oauthStates.delete(key);
            }
        });
    }

    function getSafePortalOrigin(settings) {
        return extractPortalOrigin(settings.webhookUrl, settings.portalUrl);
    }

    function getUserChatAuthStatus(meshUserId, settings) {
        var s = settings || getSettings();
        var auth = readUserChatAuth(getServer(), meshUserId);
        var portalOrigin = getSafePortalOrigin(s);
        var oauthConfigured = Boolean(s.oauthClientId && s.oauthClientSecret && portalOrigin);
        if (!auth) {
            return {
                authenticated: false,
                mode: null,
                b24UserId: '',
                b24UserName: '',
                oauthConfigured: oauthConfigured
            };
        }
        return {
            authenticated: true,
            mode: auth.mode || 'oauth',
            b24UserId: auth.b24UserId || '',
            b24UserName: auth.b24UserName || '',
            oauthConfigured: oauthConfigured
        };
    }

    function extractAllowedHost(raw) {
        var str = String(raw || '').trim();
        if (!str) return '';
        if (/^https?:\/\//i.test(str)) {
            return new URL(str).hostname.toLowerCase();
        }
        if (/^[a-z0-9.-]+(?::\d+)?$/i.test(str)) {
            return str.replace(/:\d+$/, '').toLowerCase();
        }
        return '';
    }

    function resolveOAuthTokenOrigin(serverDomain, portalOrigin) {
        var host = extractAllowedHost(serverDomain);
        if (!host) {
            return portalOrigin;
        }
        if (host === 'oauth.bitrix24.tech' || host === 'oauth.bitrix.info') {
            return 'https://' + host;
        }
        if (portalOrigin) {
            var portalHost = new URL(portalOrigin).hostname.toLowerCase();
            if (host === portalHost) {
                return portalOrigin;
            }
        }
        throw new Error('Недопустимый OAuth-сервер Битрикс24: ' + String(serverDomain || ''));
    }

    function resolveRestEndpoint(clientEndpoint, portalOrigin) {
        var fallback = String(portalOrigin || '').replace(/\/+$/, '') + '/rest';
        if (typeof clientEndpoint !== 'string' || !clientEndpoint.trim()) {
            return fallback;
        }
        try {
            var parsed = new URL(clientEndpoint.trim());
            var portalUrl = portalOrigin ? new URL(portalOrigin) : null;
            if ((parsed.protocol === 'https:' || (portalUrl && parsed.protocol === portalUrl.protocol)) &&
                (!portalUrl || parsed.host.toLowerCase() === portalUrl.host.toLowerCase())) {
                return parsed.origin + parsed.pathname.replace(/\/+$/, '');
            }
        } catch (e) {}
        return fallback;
    }

    async function refreshOAuthToken(settings, auth) {
        var portalOrigin = getSafePortalOrigin(settings);
        if (!portalOrigin || !settings.oauthClientId || !settings.oauthClientSecret || !auth || !auth.refreshToken) {
            throw new Error('Невозможно обновить OAuth-токен Битрикс24');
        }
        var tokenOrigin = resolveOAuthTokenOrigin(auth.oauthTokenOrigin, portalOrigin);
        var data = await postForm(
            tokenOrigin + '/oauth/token/',
            {
                grant_type: 'refresh_token',
                client_id: settings.oauthClientId,
                client_secret: settings.oauthClientSecret,
                refresh_token: auth.refreshToken
            },
            {
                timeoutMs: settings.requestTimeoutMs,
                rejectUnauthorized: settings.rejectUnauthorized
            }
        );
        if (!data || !data.access_token) {
            throw new Error('Битрикс24 не вернул новый access_token');
        }
        var expiresIn = Number(data.expires_in) || 3600;
        return Object.assign({}, auth, {
            mode: 'oauth',
            accessToken: String(data.access_token),
            refreshToken: data.refresh_token ? String(data.refresh_token) : auth.refreshToken,
            expiresAt: Date.now() + expiresIn * 1000,
            oauthTokenOrigin: tokenOrigin,
            restBaseUrl: data.client_endpoint ? resolveRestEndpoint(data.client_endpoint, portalOrigin) : (auth.restBaseUrl || (portalOrigin + '/rest'))
        });
    }

    async function callBitrixAsUser(meshUserId, method, params) {
        var server = getServer();
        var settings = getSettings();
        var auth = readUserChatAuth(server, meshUserId);
        if (!auth) {
            var authErr = new Error('Требуется вход в свой аккаунт Битрикс24');
            authErr.authRequired = true;
            throw authErr;
        }

        var reqOpts = {
            timeoutMs: settings.requestTimeoutMs,
            rejectUnauthorized: settings.rejectUnauthorized
        };

        if (auth.mode === 'webhook') {
            var hookUrl = buildMethodUrl(auth.personalWebhookUrl, method);
            return await postJson(hookUrl, params || {}, reqOpts);
        }

        var portalOrigin = getSafePortalOrigin(settings);
        if (!portalOrigin) {
            throw new Error('Не указан адрес портала Битрикс24');
        }

        var currentAuth = auth;
        if (currentAuth.expiresAt && Date.now() > (currentAuth.expiresAt - 60000) && currentAuth.refreshToken) {
            try {
                currentAuth = await refreshOAuthToken(settings, currentAuth);
                writeUserChatAuth(server, meshUserId, currentAuth);
            } catch (refreshErr) {
                deleteUserChatAuth(server, meshUserId);
                var expiredErr = new Error('Сессия Битрикс24 истекла, войдите повторно');
                expiredErr.authRequired = true;
                throw expiredErr;
            }
        }

        var restBase = resolveRestEndpoint(currentAuth.restBaseUrl, portalOrigin);
        var endpoint = restBase + '/' + String(method).replace(/\.json$/i, '') + '.json';
        try {
            return await postJson(endpoint, Object.assign({}, params || {}, { auth: currentAuth.accessToken }), reqOpts);
        } catch (err) {
            var isExpired = err && (err.httpStatus === 401 || /expired_token|invalid_token/i.test(String(err.b24Code || err.message)));
            if (isExpired && currentAuth.refreshToken) {
                try {
                    currentAuth = await refreshOAuthToken(settings, currentAuth);
                    writeUserChatAuth(server, meshUserId, currentAuth);
                    var refreshedBase = resolveRestEndpoint(currentAuth.restBaseUrl, portalOrigin);
                    var refreshedEndpoint = refreshedBase + '/' + String(method).replace(/\.json$/i, '') + '.json';
                    return await postJson(refreshedEndpoint, Object.assign({}, params || {}, { auth: currentAuth.accessToken }), reqOpts);
                } catch (retryErr) {
                    deleteUserChatAuth(server, meshUserId);
                    var reloginErr = new Error('Сессия Битрикс24 истекла, войдите повторно');
                    reloginErr.authRequired = true;
                    throw reloginErr;
                }
            }
            if (isExpired) {
                deleteUserChatAuth(server, meshUserId);
                err.authRequired = true;
            }
            throw err;
        }
    }

    function validateDialogId(dialogId) {
        var safeDialogId = typeof dialogId === 'string' || typeof dialogId === 'number' ? String(dialogId).trim() : '';
        if (!/^[a-zA-Z0-9_-]+$/.test(safeDialogId)) {
            throw new Error('Некорректный идентификатор диалога Битрикс24');
        }
        return safeDialogId;
    }

    async function markDialogReadForUser(meshUserId, dialogId, lastMessageId) {
        var safeDialogId = validateDialogId(dialogId);
        var params = { DIALOG_ID: safeDialogId };
        var msgId = Number(lastMessageId);
        if (Number.isFinite(msgId) && msgId > 0) {
            params.MESSAGE_ID = msgId;
        }
        try {
            await callBitrixAsUser(meshUserId, 'im.dialog.read', params);
            return true;
        } catch (err) {
            if (err && err.authRequired) throw err;
            console.warn('[b24contacts] Не удалось отметить диалог прочитанным:', err && err.message);
            return false;
        }
    }

    async function fetchChatMessagesForUser(meshUserId, dialogId, limit, markRead) {
        var safeDialogId = validateDialogId(dialogId);
        var maxCount = clampNumber(limit, 4, 1, 50);
        var auth = readUserChatAuth(getServer(), meshUserId);
        var myB24Id = auth && auth.b24UserId ? String(auth.b24UserId) : '';

        var data;
        try {
            data = await callBitrixAsUser(meshUserId, 'im.dialog.messages.get', {
                DIALOG_ID: safeDialogId,
                LIMIT: maxCount
            });
        } catch (err) {
            var code = String((err && (err.b24Code || err.message)) || '');
            if (/DIALOG_NOT_FOUND|CHAT_ID_EMPTY/i.test(code)) {
                return { messages: [], auth: getUserChatAuthStatus(meshUserId) };
            }
            throw err;
        }

        var result = (data && data.result) || {};
        var usersList = Array.isArray(result.users) ? result.users : [];
        var userMap = {};
        for (var u = 0; u < usersList.length; u++) {
            var usr = usersList[u];
            if (usr && usr.id != null) {
                userMap[String(usr.id)] = usr.name ? String(usr.name) : ('ID ' + usr.id);
            }
        }

        var rawMsgs = Array.isArray(result.messages) ? result.messages : [];
        var normalized = rawMsgs.map(function (m) {
            var authorId = m.author_id != null ? String(m.author_id) : '0';
            var authorName = authorId === '0'
                ? 'Система'
                : (userMap[authorId] || (myB24Id && authorId === myB24Id ? (auth.b24UserName || 'Вы') : ('Сотрудник #' + authorId)));
            var text = cleanBitrixBbCode(m.text != null ? String(m.text) : '');
            if (!text && Array.isArray(m.params && m.params.FILE_ID) && m.params.FILE_ID.length) {
                text = '[Файл]';
            }
            return {
                id: Number(m.id) || 0,
                authorId: authorId,
                authorName: authorName,
                isMine: Boolean(myB24Id && authorId === myB24Id),
                date: m.date ? String(m.date) : '',
                text: text || '(сообщение без текста)'
            };
        });

        normalized.sort(function (a, b) { return a.id - b.id; });
        var maxMsgId = normalized.length ? normalized[normalized.length - 1].id : 0;
        if (normalized.length > maxCount) {
            normalized = normalized.slice(normalized.length - maxCount);
        }

        if (markRead) {
            await markDialogReadForUser(meshUserId, safeDialogId, maxMsgId);
        }

        return {
            messages: normalized,
            auth: getUserChatAuthStatus(meshUserId)
        };
    }

    async function sendChatMessageForUser(meshUserId, dialogId, messageText, limit) {
        var safeDialogId = validateDialogId(dialogId);
        var text = typeof messageText === 'string' ? messageText.trim() : '';
        if (!text) throw new Error('Введите текст сообщения');
        if (text.length > 4000) throw new Error('Сообщение слишком длинное (максимум 4000 символов)');

        await callBitrixAsUser(meshUserId, 'im.message.add', {
            DIALOG_ID: safeDialogId,
            MESSAGE: text
        });

        return await fetchChatMessagesForUser(meshUserId, safeDialogId, limit || 4, true);
    }

    async function fetchRecentDialogsForUser(meshUserId) {
        var data = await callBitrixAsUser(meshUserId, 'im.recent.list', {});
        var result = (data && data.result) || {};
        var items = Array.isArray(result.items) ? result.items : (Array.isArray(result) ? result : []);

        var settings = getSettings();
        var portalOrigin = getSafePortalOrigin(settings);
        var cacheById = new Map();
        for (var i = 0; i < cache.users.length; i++) {
            var cu = cache.users[i];
            if (cu && cu.id != null) cacheById.set(String(cu.id), cu);
        }

        var dialogs = [];
        var unreadTotal = 0;
        var unreadDialogsCount = 0;

        for (var j = 0; j < items.length; j++) {
            var item = items[j];
            if (!item || typeof item !== 'object') continue;
            var dialogId = '';
            if (item.id != null) {
                dialogId = String(item.id).trim();
            } else if (item.chat_id != null) {
                dialogId = 'chat' + String(item.chat_id).trim();
            }
            if (!dialogId || !/^[a-zA-Z0-9_-]+$/.test(dialogId)) continue;

            var type = String(item.type || (dialogId.indexOf('chat') === 0 ? 'chat' : 'user'));
            var userObj = (item.user && typeof item.user === 'object') ? item.user : null;
            var cachedProfile = cacheById.get(dialogId) || null;
            var title = (typeof item.title === 'string' && item.title.trim()) ? item.title.trim() : '';
            if (!title && userObj) {
                title = (typeof userObj.name === 'string' && userObj.name.trim())
                    ? userObj.name.trim()
                    : [userObj.first_name, userObj.last_name].filter(Boolean).join(' ').trim();
            }
            if (!title && cachedProfile) {
                title = cachedProfile.displayName;
            }
            if (!title) {
                title = (type === 'chat' ? 'Групповой чат #' : 'Пользователь #') + dialogId;
            }

            var counter = Math.max(0, Number(item.counter) || 0);
            var manualUnread = Boolean(item.unread);
            var effectiveUnread = counter > 0 ? counter : (manualUnread ? 1 : 0);
            if (effectiveUnread > 0) {
                unreadTotal += effectiveUnread;
                unreadDialogsCount++;
            }

            var msg = (item.message && typeof item.message === 'object') ? item.message : {};
            var lastText = cleanBitrixBbCode(msg.text != null ? String(msg.text) : '');
            if (!lastText && Array.isArray(msg.params && msg.params.FILE_ID) && msg.params.FILE_ID.length) {
                lastText = '[Файл]';
            }

            var links = type === 'user' ? buildBitrixUserLinks(dialogId, portalOrigin) : { chatUrl: '', profileUrl: '' };
            dialogs.push({
                dialogId: dialogId,
                type: type,
                title: title,
                counter: effectiveUnread,
                unread: effectiveUnread > 0,
                pinned: Boolean(item.pinned),
                lastMessage: {
                    id: Number(msg.id) || 0,
                    date: msg.date ? String(msg.date) : '',
                    text: lastText || '',
                    authorId: msg.author_id != null ? String(msg.author_id) : ''
                },
                phones: cachedProfile && Array.isArray(cachedProfile.phones) ? cachedProfile.phones : [],
                chatUrl: links.chatUrl,
                profileUrl: links.profileUrl
            });
        }

        return {
            dialogs: dialogs,
            unreadTotal: unreadTotal,
            unreadDialogsCount: unreadDialogsCount,
            auth: getUserChatAuthStatus(meshUserId, settings)
        };
    }

    var settingsRevCounter = 0;
    var nodeBindingsMemo = new Map();

    async function resolveClientNodeBindings(client, rawNodes) {
        var settings = getSettings();
        if (settings.webhookUrl && cache.users.length === 0) {
            try { await ensureCacheReady(); } catch (e) {}
        }

        var list = Array.isArray(rawNodes) ? rawNodes.slice(0, 5000) : [];
        var normalized = [];
        var hash = crypto.createHash('sha1');
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item || typeof item !== 'object') continue;
            var nid = typeof item.id === 'string' ? item.id.trim().slice(0, 128) : '';
            var nname = typeof item.name === 'string' ? item.name.slice(0, 512) : '';
            if (!nid) continue;
            normalized.push({ id: nid, name: nname });
            hash.update(nid + '\0' + nname + '\n');
        }

        var userId = (client && client.user && client.user._id) ? String(client.user._id) : 'anon';
        var memoKey = userId + '|' + String(cache.lastUpdated) + '|' + String(settingsRevCounter) + '|' + String(settings.minMatchScore) + '|' + hash.digest('hex');
        if (nodeBindingsMemo.has(memoKey)) {
            return nodeBindingsMemo.get(memoKey);
        }

        var cacheById = new Map();
        for (var u = 0; u < cache.users.length; u++) {
            if (cache.users[u] && cache.users[u].id != null) {
                cacheById.set(String(cache.users[u].id), cache.users[u]);
            }
        }

        var nodeToB24 = {};
        var b24ToNodes = {};

        for (var k = 0; k < normalized.length; k++) {
            var nodeInfo = normalized[k];
            var manualEntry = (settings.manualLinks && settings.manualLinks[nodeInfo.id])
                ? settings.manualLinks[nodeInfo.id]
                : null;
            var matchedB24Id = '';
            var matchedB24Name = '';
            var isManual = false;

            if (manualEntry && manualEntry.b24UserId) {
                var hasAccess = await verifyNodeAccess(client, nodeInfo.id);
                if (hasAccess) {
                    var manualUser = cacheById.get(String(manualEntry.b24UserId));
                    if (manualUser) {
                        matchedB24Id = String(manualUser.id);
                        matchedB24Name = manualUser.displayName;
                        isManual = true;
                    }
                }
            }

            if (!matchedB24Id && nodeInfo.name && cache.users.length > 0) {
                var match = findBestContactMatch(nodeInfo.name, cache.users, settings.minMatchScore);
                if (match.matched && match.profile && match.profile.id) {
                    matchedB24Id = String(match.profile.id);
                    matchedB24Name = match.profile.displayName || '';
                }
            }

            if (matchedB24Id) {
                nodeToB24[nodeInfo.id] = {
                    b24UserId: matchedB24Id,
                    b24UserName: matchedB24Name,
                    manualLinked: isManual
                };
                if (!b24ToNodes[matchedB24Id]) b24ToNodes[matchedB24Id] = [];
                b24ToNodes[matchedB24Id].push({
                    nodeId: nodeInfo.id,
                    nodeName: nodeInfo.name || nodeInfo.id,
                    manualLinked: isManual
                });
            }
        }

        if (nodeBindingsMemo.size > 32) {
            nodeBindingsMemo.clear();
        }
        var res = { nodeToB24: nodeToB24, b24ToNodes: b24ToNodes };
        nodeBindingsMemo.set(memoKey, res);
        return res;
    }

    async function completeOAuthCallback(code, state, serverDomain) {
        cleanupOAuthStates();
        var stateEntry = (typeof state === 'string' && oauthStates.has(state)) ? oauthStates.get(state) : null;
        if (!stateEntry) {
            throw new Error('Ссылка авторизации устарела или уже использована. Повторите вход из MeshCentral.');
        }
        oauthStates.delete(state);

        var settings = getSettings();
        var portalOrigin = getSafePortalOrigin(settings);
        if (!portalOrigin || !settings.oauthClientId || !settings.oauthClientSecret) {
            throw new Error('OAuth-приложение Битрикс24 не настроено администратором MeshCentral.');
        }

        var tokenOrigin = resolveOAuthTokenOrigin(serverDomain, portalOrigin);
        var tokenData = await postForm(
            tokenOrigin + '/oauth/token/',
            {
                grant_type: 'authorization_code',
                client_id: settings.oauthClientId,
                client_secret: settings.oauthClientSecret,
                code: String(code || ''),
                redirect_uri: stateEntry.redirectUri
            },
            {
                timeoutMs: settings.requestTimeoutMs,
                rejectUnauthorized: settings.rejectUnauthorized
            }
        );

        if (!tokenData || !tokenData.access_token) {
            throw new Error('Битрикс24 не выдал access_token');
        }

        var restBaseUrl = resolveRestEndpoint(tokenData.client_endpoint, portalOrigin);
        var meData = await postJson(
            restBaseUrl + '/user.current.json',
            { auth: String(tokenData.access_token) },
            {
                timeoutMs: settings.requestTimeoutMs,
                rejectUnauthorized: settings.rejectUnauthorized
            }
        );
        var me = (meData && meData.result) || {};
        var b24Name = [me.NAME, me.LAST_NAME].filter(Boolean).join(' ').trim() || me.EMAIL || ('ID ' + (me.ID || ''));
        var expiresIn = Number(tokenData.expires_in) || 3600;

        writeUserChatAuth(getServer(), stateEntry.userId, {
            mode: 'oauth',
            accessToken: String(tokenData.access_token),
            refreshToken: tokenData.refresh_token ? String(tokenData.refresh_token) : '',
            expiresAt: Date.now() + expiresIn * 1000,
            oauthTokenOrigin: tokenOrigin,
            restBaseUrl: restBaseUrl,
            b24UserId: me.ID != null ? String(me.ID) : '',
            b24UserName: b24Name
        });

        return {
            userId: stateEntry.userId,
            auth: getUserChatAuthStatus(stateEntry.userId, settings)
        };
    }

    function buildManualLinksSummary(manualLinks) {
        var links = normalizeManualLinks(manualLinks);
        var byId = new Map();
        for (var i = 0; i < cache.users.length; i++) {
            var u = cache.users[i];
            if (u && u.id != null) byId.set(String(u.id), u);
        }
        var out = {};
        var keys = Object.keys(links);
        for (var j = 0; j < keys.length; j++) {
            var nodeId = keys[j];
            var entry = links[nodeId];
            var user = byId.get(String(entry.b24UserId));
            out[nodeId] = {
                nodeId: nodeId,
                nodeName: entry.nodeName || '',
                b24UserId: String(entry.b24UserId),
                b24UserName: user ? user.displayName : '',
                activeInCache: Boolean(user),
                updatedAt: entry.updatedAt || 0
            };
        }
        return out;
    }

    function buildBitrixUsersSummary() {
        var list = [];
        for (var i = 0; i < cache.users.length; i++) {
            var u = cache.users[i];
            if (!u || !u.id) continue;
            list.push({
                id: String(u.id),
                displayName: u.displayName || ('ID ' + u.id),
                phones: Array.isArray(u.phones) ? u.phones.map(function (p) { return p.display; }).filter(Boolean) : []
            });
        }
        list.sort(function (a, b) {
            return a.displayName.localeCompare(b.displayName, 'ru');
        });
        return list;
    }

    function getSettingsSummary(settings, includeUsers) {
        var s = settings || getSettings();
        var summary = {
            hasWebhook: Boolean(s.webhookUrl),
            maskedWebhookUrl: maskWebhookUrl(s.webhookUrl),
            portalUrl: s.portalUrl,
            oauthClientId: s.oauthClientId,
            hasOAuthSecret: Boolean(s.oauthClientSecret),
            oauthConfigured: Boolean(s.oauthClientId && s.oauthClientSecret && getSafePortalOrigin(s)),
            cacheTtlMinutes: s.cacheTtlMinutes,
            minMatchScore: s.minMatchScore,
            requestTimeoutMs: s.requestTimeoutMs,
            rejectUnauthorized: s.rejectUnauthorized,
            manualLinks: buildManualLinksSummary(s.manualLinks),
            cacheSize: cache.users.length,
            lastUpdated: cache.lastUpdated,
            lastError: cache.lastError
        };
        if (includeUsers) {
            summary.bitrixUsers = buildBitrixUsersSummary();
        }
        return summary;
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

    var ROUTES_VERSION = '1.5.1';

    function getExpressApps() {
        var server = getServer();
        if (!server) return [];
        var candidates = [server.webserver && server.webserver.app, server.app];
        var apps = [];
        for (var i = 0; i < candidates.length; i++) {
            var a = candidates[i];
            if (a && typeof a.get === 'function' && apps.indexOf(a) === -1) {
                apps.push(a);
            }
        }
        return apps;
    }

    function escapeHtmlText(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function isOwnPluginRoutePath(routePath) {
        return typeof routePath === 'string' && (
            routePath.indexOf('/plugin/b24contacts/') === 0 ||
            routePath.indexOf('/*/plugin/b24contacts/') === 0
        );
    }

    function registerRoutes(app) {
        if (!app || typeof app.get !== 'function') return false;

        var existingRouter = app._router || app.router;
        if (app._b24ContactsRouteVer === ROUTES_VERSION && existingRouter && Array.isArray(existingRouter.stack)) {
            var hasOAuthRoute = existingRouter.stack.some(function (layer) {
                return layer && layer.route && layer.route.path === '/plugin/b24contacts/oauth/callback';
            });
            if (hasOAuthRoute) return true;
        }

        // Remove any older b24contacts layers before re-registering (supports updates without duplicate handlers)
        if (existingRouter && Array.isArray(existingRouter.stack)) {
            for (var r = existingRouter.stack.length - 1; r >= 0; r--) {
                var oldPath = existingRouter.stack[r] && existingRouter.stack[r].route ? existingRouter.stack[r].route.path : '';
                if (isOwnPluginRoutePath(oldPath)) {
                    existingRouter.stack.splice(r, 1);
                }
            }
        }

        app.get('/plugin/b24contacts/api/contacts', async function (req, res) {
            try {
                var user = getUserFromReq(req);
                if (!user && (!req.session || !req.session.userid)) {
                    return res.status(401).json({ ok: false, error: 'Unauthorized' });
                }

                var nodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId.slice(0, 128) : '';
                var nodeName = typeof req.query.nodeName === 'string' ? req.query.nodeName.slice(0, 512) : '';
                if (!nodeName.trim() && !nodeId.trim()) {
                    return res.status(400).json({ ok: false, error: 'Missing nodeName parameter' });
                }

                var result = await lookupContacts(nodeName, nodeId);
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.status(200).json(result);
            } catch (err) {
                console.error('[b24contacts] Ошибка HTTP API /api/contacts:', err.message);
                return res.status(500).json({ ok: false, matched: false, error: 'Внутренняя ошибка плагина' });
            }
        });

        async function oauthCallbackHandler(req, res) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            try {
                if (req.query && req.query.error) {
                    throw new Error(String(req.query.error_description || req.query.error));
                }
                if (!req.query || !req.query.code || !req.query.state) {
                    throw new Error('Отсутствуют параметры code или state от Битрикс24');
                }
                await completeOAuthCallback(req.query.code, req.query.state, req.query.server_domain);
                return res.status(200).send(
                    '<!doctype html><meta charset="utf-8"><title>Битрикс24</title>' +
                    '<body style="font:14px Arial,sans-serif;padding:24px;text-align:center">' +
                    '<h3>Вход в Битрикс24 выполнен</h3><p>Окно закроется автоматически…</p>' +
                    '<script>try{if(window.opener){window.opener.postMessage({type:"b24c-oauth-done",ok:true},window.location.origin);}}catch(e){}setTimeout(function(){window.close();},300);</script>' +
                    '</body>'
                );
            } catch (err) {
                return res.status(400).send(
                    '<!doctype html><meta charset="utf-8"><title>Ошибка входа Битрикс24</title>' +
                    '<body style="font:14px Arial,sans-serif;padding:24px">' +
                    '<h3>Не удалось выполнить вход в Битрикс24</h3><p>' + escapeHtmlText(err && err.message) + '</p>' +
                    '<script>try{if(window.opener){window.opener.postMessage({type:"b24c-oauth-done",ok:false,error:' + JSON.stringify(String((err && err.message) || 'Ошибка')) + '},window.location.origin);}}catch(e){}</script>' +
                    '</body>'
                );
            }
        }

        app.get('/plugin/b24contacts/oauth/callback', oauthCallbackHandler);
        app.get('/*/plugin/b24contacts/oauth/callback', oauthCallbackHandler);

        // Promote plugin routes ahead of MeshCentral's catch-all 404 middleware (Express 4 & Express 5)
        var insertIdx = 0;
        var layersCount = 0;
        var stackLen = 0;
        var routerObj = app._router || app.router;
        if (routerObj && Array.isArray(routerObj.stack)) {
            var stack = routerObj.stack;
            var layers = [];
            for (var i = stack.length - 1; i >= 0; i--) {
                var routePath = stack[i] && stack[i].route ? stack[i].route.path : '';
                if (isOwnPluginRoutePath(routePath)) {
                    layers.unshift(stack.splice(i, 1)[0]);
                }
            }
            if (layers.length > 0) {
                while (insertIdx < stack.length && stack[insertIdx] && (stack[insertIdx].name === 'query' || stack[insertIdx].name === 'expressInit')) {
                    insertIdx++;
                }
                stack.splice(insertIdx, 0, ...layers);
                layersCount = layers.length;
                stackLen = stack.length;
            }
        }

        app._b24ContactsRouteVer = ROUTES_VERSION;
        app._b24ContactsRoutesRegistered = true;
        console.log('[b24contacts] HTTP-маршруты плагина v' + ROUTES_VERSION + ' зарегистрированы (слоев: ' + layersCount + ', позиция: ' + insertIdx + '/' + stackLen + ').');
        return true;
    }

    function tryRegisterRoutes(attemptsLeft) {
        routesRetryTimer = null;
        var registeredAny = false;
        try {
            var apps = getExpressApps();
            for (var i = 0; i < apps.length; i++) {
                if (registerRoutes(apps[i])) {
                    registeredAny = true;
                }
            }
        } catch (e) {
            console.warn('[b24contacts] Не удалось зарегистрировать HTTP-маршруты:', e.message);
        }
        if (registeredAny) return;
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

                    var result = await lookupContacts(nodeName, nodeId);
                    result.chatAuth = getUserChatAuthStatus(client.user._id);
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
            (async function () {
                var settings = getSettings();
                if (settings.webhookUrl && cache.users.length === 0) {
                    try { await ensureCacheReady(); } catch (e) {}
                }
                sendToClient(client, Object.assign({
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onSettingsResult',
                    requestId: requestId,
                    ok: true
                }, getSettingsSummary(settings, true)));
            })();
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
                    var rawOAuthSecret = typeof incoming.oauthClientSecret === 'string' ? incoming.oauthClientSecret.trim() : '';
                    var nextOAuthSecret = rawOAuthSecret || current.oauthClientSecret;
                    if (incoming.clearOAuthSecret === true) {
                        nextOAuthSecret = '';
                    }
                    var nextSettings = {
                        webhookUrl: nextWebhookUrl,
                        portalUrl: typeof incoming.portalUrl === 'string' ? incoming.portalUrl.trim() : current.portalUrl,
                        oauthClientId: typeof incoming.oauthClientId === 'string' ? incoming.oauthClientId.trim() : current.oauthClientId,
                        oauthClientSecret: nextOAuthSecret,
                        cacheTtlMinutes: clampNumber(incoming.cacheTtlMinutes, current.cacheTtlMinutes, 5, 1440),
                        minMatchScore: clampNumber(incoming.minMatchScore, current.minMatchScore, 0.2, 0.95),
                        requestTimeoutMs: clampNumber(incoming.requestTimeoutMs, current.requestTimeoutMs, 2000, 60000),
                        pageDelayMs: current.pageDelayMs,
                        rejectUnauthorized: incoming.rejectUnauthorized !== false,
                        manualLinks: current.manualLinks || {}
                    };
                    writeSavedSettings(getServer(), nextSettings);
                    settingsRevCounter++;
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
                    }, getSettingsSummary(nextSettings, true)));
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

        if (action === 'setManualLink') {
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
                    var targetNodeId = typeof command.nodeId === 'string' ? command.nodeId.trim().slice(0, 128) : '';
                    var targetNodeName = typeof command.nodeName === 'string' ? command.nodeName.trim().slice(0, 512) : '';
                    var b24UserId = (command.clearManualLink === true || command.b24UserId == null)
                        ? ''
                        : String(command.b24UserId).trim().slice(0, 64);

                    if (!targetNodeId) {
                        throw new Error('Не указан идентификатор компьютера (nodeId)');
                    }

                    var current = getSettings();
                    var nextLinks = Object.assign({}, current.manualLinks || {});

                    if (!b24UserId) {
                        delete nextLinks[targetNodeId];
                    } else {
                        if (current.webhookUrl && cache.users.length === 0) {
                            await ensureCacheReady();
                        }
                        var foundUser = null;
                        for (var i = 0; i < cache.users.length; i++) {
                            if (cache.users[i] && String(cache.users[i].id) === b24UserId) {
                                foundUser = cache.users[i];
                                break;
                            }
                        }
                        if (cache.users.length > 0 && !foundUser) {
                            throw new Error('Пользователь Битрикс24 с ID ' + b24UserId + ' не найден в списке активных сотрудников');
                        }
                        nextLinks[targetNodeId] = {
                            b24UserId: b24UserId,
                            nodeName: targetNodeName || (nextLinks[targetNodeId] && nextLinks[targetNodeId].nodeName) || '',
                            updatedAt: Date.now()
                        };
                    }

                    var nextSettings = {
                        webhookUrl: current.webhookUrl,
                        portalUrl: current.portalUrl,
                        oauthClientId: current.oauthClientId,
                        oauthClientSecret: current.oauthClientSecret,
                        cacheTtlMinutes: current.cacheTtlMinutes,
                        minMatchScore: current.minMatchScore,
                        requestTimeoutMs: current.requestTimeoutMs,
                        pageDelayMs: current.pageDelayMs,
                        rejectUnauthorized: current.rejectUnauthorized,
                        manualLinks: nextLinks
                    };
                    writeSavedSettings(getServer(), nextSettings);
                    settingsRevCounter++;

                    sendToClient(client, Object.assign({
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onSettingsResult',
                        requestId: requestId,
                        linkSaved: true,
                        linkedNodeId: targetNodeId,
                        cleared: !b24UserId,
                        ok: true
                    }, getSettingsSummary(nextSettings, true)));
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onSettingsResult',
                        requestId: requestId,
                        linkSaved: false,
                        ok: false,
                        error: err && err.message ? err.message : 'Не удалось сохранить привязку'
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
                }, getSettingsSummary(undefined, true));
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
            return;
        }

        if (action === 'getChatAuth') {
            sendToClient(client, {
                action: 'plugin',
                plugin: PLUGIN_NAME,
                method: 'onChatResult',
                requestId: requestId,
                ok: true,
                auth: getUserChatAuthStatus(client.user._id)
            });
            return;
        }

        if (action === 'startOAuth') {
            try {
                var s = getSettings();
                var portalOrigin = getSafePortalOrigin(s);
                if (!portalOrigin || !s.oauthClientId || !s.oauthClientSecret) {
                    throw new Error('Администратор ещё не настроил OAuth-приложение Битрикс24 в настройках плагина');
                }
                var origin = typeof command.origin === 'string' && /^https?:\/\/[^/\s]+$/i.test(command.origin.trim())
                    ? command.origin.trim()
                    : '';
                if (!origin) throw new Error('Не удалось определить адрес сервера MeshCentral для обратного редиректа');
                var redirectUri = origin + '/plugin/b24contacts/oauth/callback';
                cleanupOAuthStates();
                var stateToken = crypto.randomBytes(24).toString('hex');
                oauthStates.set(stateToken, {
                    userId: client.user._id,
                    redirectUri: redirectUri,
                    createdAt: Date.now()
                });
                var authUrl = portalOrigin + '/oauth/authorize/?client_id=' + encodeURIComponent(s.oauthClientId) +
                    '&response_type=code&redirect_uri=' + encodeURIComponent(redirectUri) +
                    '&state=' + encodeURIComponent(stateToken);
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onChatResult',
                    requestId: requestId,
                    ok: true,
                    authorizeUrl: authUrl
                });
            } catch (err) {
                sendToClient(client, {
                    action: 'plugin',
                    plugin: PLUGIN_NAME,
                    method: 'onChatResult',
                    requestId: requestId,
                    ok: false,
                    error: err && err.message
                });
            }
            return;
        }

        if (action === 'savePersonalWebhook') {
            (async function () {
                try {
                    var hookUrl = typeof command.webhookUrl === 'string' ? command.webhookUrl.trim() : '';
                    var meUrl = buildMethodUrl(hookUrl, 'user.current');
                    var s = getSettings();
                    var meData = await postJson(meUrl, {}, {
                        timeoutMs: s.requestTimeoutMs,
                        rejectUnauthorized: s.rejectUnauthorized
                    });
                    var me = (meData && meData.result) || {};
                    var b24Name = [me.NAME, me.LAST_NAME].filter(Boolean).join(' ').trim() || me.EMAIL || ('ID ' + (me.ID || ''));
                    writeUserChatAuth(getServer(), client.user._id, {
                        mode: 'webhook',
                        personalWebhookUrl: hookUrl,
                        b24UserId: me.ID != null ? String(me.ID) : '',
                        b24UserName: b24Name
                    });
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        ok: true,
                        auth: getUserChatAuthStatus(client.user._id, s)
                    });
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        ok: false,
                        error: err && err.message ? err.message : 'Не удалось проверить личный вебхук'
                    });
                }
            })();
            return;
        }

        if (action === 'logoutChat') {
            deleteUserChatAuth(getServer(), client.user._id);
            sendToClient(client, {
                action: 'plugin',
                plugin: PLUGIN_NAME,
                method: 'onChatResult',
                requestId: requestId,
                ok: true,
                auth: getUserChatAuthStatus(client.user._id)
            });
            return;
        }

        if (action === 'getChatMessages') {
            var chatNodeId = typeof command.nodeId === 'string' ? command.nodeId : '';
            var dialogId = typeof command.dialogId === 'string' ? command.dialogId : '';
            var shouldMarkRead = Boolean(command.markRead);
            (async function () {
                try {
                    var hasAccess = await verifyNodeAccess(client, chatNodeId);
                    if (!hasAccess) throw new Error('Доступ к устройству запрещён');
                    var res = await fetchChatMessagesForUser(client.user._id, dialogId, command.limit || 4, shouldMarkRead);
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        dialogId: dialogId,
                        markedRead: shouldMarkRead,
                        ok: true,
                        messages: res.messages,
                        auth: res.auth
                    });
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        dialogId: dialogId,
                        ok: false,
                        authRequired: Boolean(err && err.authRequired),
                        auth: getUserChatAuthStatus(client.user._id),
                        error: err && err.message ? err.message : 'Ошибка загрузки чата'
                    });
                }
            })();
            return;
        }

        if (action === 'sendChatMessage') {
            var sendNodeId = typeof command.nodeId === 'string' ? command.nodeId : '';
            var sendDialogId = typeof command.dialogId === 'string' ? command.dialogId : '';
            var msgText = typeof command.message === 'string' ? command.message : '';
            (async function () {
                try {
                    var hasAccess = await verifyNodeAccess(client, sendNodeId);
                    if (!hasAccess) throw new Error('Доступ к устройству запрещён');
                    var res = await sendChatMessageForUser(client.user._id, sendDialogId, msgText, command.limit || 4);
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        dialogId: sendDialogId,
                        ok: true,
                        sent: true,
                        messages: res.messages,
                        auth: res.auth
                    });
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        dialogId: sendDialogId,
                        ok: false,
                        authRequired: Boolean(err && err.authRequired),
                        auth: getUserChatAuthStatus(client.user._id),
                        error: err && err.message ? err.message : 'Не удалось отправить сообщение'
                    });
                }
            })();
            return;
        }

        if (action === 'markChatRead') {
            var readDialogId = typeof command.dialogId === 'string' ? command.dialogId : '';
            (async function () {
                try {
                    await markDialogReadForUser(client.user._id, readDialogId, command.lastMessageId);
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        dialogId: readDialogId,
                        ok: true,
                        markedRead: true
                    });
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        dialogId: readDialogId,
                        ok: false,
                        authRequired: Boolean(err && err.authRequired),
                        auth: getUserChatAuthStatus(client.user._id),
                        error: err && err.message ? err.message : 'Не удалось отметить чат прочитанным'
                    });
                }
            })();
            return;
        }

        if (action === 'getChatOverview') {
            (async function () {
                try {
                    var authStatus = getUserChatAuthStatus(client.user._id);
                    if (!authStatus.authenticated) {
                        sendToClient(client, {
                            action: 'plugin',
                            plugin: PLUGIN_NAME,
                            method: 'onChatResult',
                            requestId: requestId,
                            ok: true,
                            authenticated: false,
                            auth: authStatus,
                            unreadTotal: 0,
                            unreadDialogsCount: 0,
                            dialogs: [],
                            unreadNodeIds: {},
                            nodeToB24: {}
                        });
                        return;
                    }

                    var results = await Promise.all([
                        fetchRecentDialogsForUser(client.user._id),
                        resolveClientNodeBindings(client, command.nodes)
                    ]);
                    var recent = results[0];
                    var bindings = results[1];

                    var unreadNodeIds = {};
                    var dialogsOut = [];
                    for (var i = 0; i < recent.dialogs.length; i++) {
                        var d = recent.dialogs[i];
                        var linkedNodes = bindings.b24ToNodes[d.dialogId] || [];
                        if (d.counter > 0 && linkedNodes.length > 0) {
                            for (var n = 0; n < linkedNodes.length; n++) {
                                var ln = linkedNodes[n];
                                unreadNodeIds[ln.nodeId] = {
                                    count: d.counter,
                                    dialogId: d.dialogId,
                                    title: d.title,
                                    preview: (d.lastMessage && d.lastMessage.text) || ''
                                };
                            }
                        }
                        if (command.includeDialogs !== false) {
                            dialogsOut.push(Object.assign({}, d, { linkedNodes: linkedNodes }));
                        }
                    }

                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        ok: true,
                        authenticated: true,
                        auth: recent.auth,
                        unreadTotal: recent.unreadTotal,
                        unreadDialogsCount: recent.unreadDialogsCount,
                        dialogs: dialogsOut,
                        unreadNodeIds: unreadNodeIds,
                        nodeToB24: bindings.nodeToB24
                    });
                } catch (err) {
                    sendToClient(client, {
                        action: 'plugin',
                        plugin: PLUGIN_NAME,
                        method: 'onChatResult',
                        requestId: requestId,
                        ok: false,
                        authRequired: Boolean(err && err.authRequired),
                        auth: getUserChatAuthStatus(client.user._id),
                        error: err && err.message ? err.message : 'Не удалось загрузить список чатов Битрикс24'
                    });
                }
            })();
        }
    };

    obj.handleServerMessage = obj.serveraction;

    // Expose internals for automated testing
    obj._internal = {
        normalizeAndTokenize: normalizeAndTokenize,
        findBestContactMatch: findBestContactMatch,
        normalizeBitrixUser: normalizeBitrixUser,
        scoreCandidate: scoreCandidate,
        buildMethodUrl: buildMethodUrl,
        buildUserGetUrl: buildUserGetUrl,
        maskWebhookUrl: maskWebhookUrl,
        loadSettings: loadSettings,
        writeSavedSettings: writeSavedSettings,
        readUserChatAuth: readUserChatAuth,
        writeUserChatAuth: writeUserChatAuth,
        resolveOAuthTokenOrigin: resolveOAuthTokenOrigin,
        resolveRestEndpoint: resolveRestEndpoint,
        registerRoutes: registerRoutes,
        completeOAuthCallback: completeOAuthCallback,
        fetchRecentDialogsForUser: fetchRecentDialogsForUser,
        markDialogReadForUser: markDialogReadForUser,
        resolveClientNodeBindings: resolveClientNodeBindings,
        oauthStates: oauthStates,
        refreshCache: refreshCache,
        getCacheState: function () { return cache; }
    };

    // Browser-serialized hooks (MUST NOT reference Node closure variables)
    obj.exports = ['onWebUIStartupEnd', 'onDeviceRefreshEnd', 'goPageStart', 'onContactsResult', 'onSettingsResult', 'onChatResult', 'openSettings'];

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
        var LEFTBAR_TAB_ID = 'b24c-leftbar-tab';
        var LEFTBAR_BADGE_ID = 'b24c-leftbar-badge';
        var CHATS_PAGE_ID = 'b24c-chats-page';
        var FRONTEND_CACHE_TTL_MS = 5 * 60 * 1000;
        var WS_TIMEOUT_MS = 8000;

        var pendingContacts = new Map();
        var pendingSettings = new Map();
        var pendingChat = new Map();
        var responseCache = new Map();
        var requestSeq = 0;
        var configRevision = 0;
        var chatPollTimer = null;
        var unreadPollTimer = null;
        var activeChatContext = null;

        var overviewState = {
            authenticated: false,
            auth: null,
            unreadTotal: 0,
            unreadDialogsCount: 0,
            dialogs: [],
            unreadNodeIds: {},
            nodeToB24: {},
            lastFetchedAt: 0,
            inFlight: false
        };

        var chatsPageState = {
            open: false,
            selectedDialogId: '',
            filterMode: 'all',
            searchQuery: '',
            messages: [],
            loadingThread: false,
            threadError: '',
            renderedShell: false
        };

        if (typeof window.addEventListener === 'function' && !window._b24cOAuthListenerBound) {
            window._b24cOAuthListenerBound = true;
            window.addEventListener('message', function (ev) {
                try {
                    if (ev.origin !== window.location.origin) return;
                    if (!ev.data || ev.data.type !== 'b24c-oauth-done') return;
                    responseCache.clear();
                    configRevision++;
                    if (window.currentNode) {
                        loadContactsForNode(window.currentNode, true);
                    }
                    if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.refreshOverview === 'function') {
                        window.B24ContactsPlugin.refreshOverview(true);
                    }
                } catch (e) {}
            });
        }

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
                '#' + CARD_ID + '{clear:both;margin:10px 0 12px;padding:11px 14px;border:1px solid #d5dce6;border-radius:6px;background:rgba(248,250,252,0.95);color:#1e293b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;box-sizing:border-box;max-width:900px}',
                '#' + CARD_ID + ' .b24c-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}',
                '#' + CARD_ID + ' .b24c-title{margin:0;font-size:13px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px}',
                '#' + CARD_ID + ' .b24c-actions{display:flex;align-items:center;gap:4px}',
                '#' + CARD_ID + ' .b24c-icon-btn{background:transparent;border:1px solid #cbd5e1;border-radius:4px;color:#475569;cursor:pointer;font-size:12px;line-height:1;padding:3px 7px}',
                '#' + CARD_ID + ' .b24c-icon-btn:hover{background:#e2e8f0;color:#0f172a}',
                '#' + CARD_ID + ' .b24c-icon-btn:disabled{opacity:0.5;cursor:default}',
                '#' + CARD_ID + ' .b24c-grid{display:grid;grid-template-columns:minmax(230px,1fr) minmax(270px,1.25fr);gap:14px;align-items:start}',
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
                '#' + CARD_ID + ' .b24c-chat-box{background:#fff;border:1px solid #dce3ec;border-radius:5px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
                '#' + CARD_ID + ' .b24c-chat-head{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:#475569;border-bottom:1px solid #edf2f7;padding-bottom:4px}',
                '#' + CARD_ID + ' .b24c-chat-me{font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '#' + CARD_ID + ' .b24c-chat-head-btns{display:flex;align-items:center;gap:4px;flex-shrink:0}',
                '#' + CARD_ID + ' .b24c-chat-btn-link{background:none;border:none;color:#64748b;cursor:pointer;font-size:11px;padding:1px 4px;text-decoration:underline}',
                '#' + CARD_ID + ' .b24c-chat-btn-link:hover{color:#0f172a}',
                '#' + CARD_ID + ' .b24c-chat-msgs{display:flex;flex-direction:column;gap:4px;max-height:145px;overflow-y:auto;padding-right:2px}',
                '#' + CARD_ID + ' .b24c-chat-msg{padding:5px 7px;border-radius:4px;background:#f1f5f9;font-size:12px;line-height:1.35;word-break:break-word}',
                '#' + CARD_ID + ' .b24c-chat-msg.mine{background:#e0f2fe}',
                '#' + CARD_ID + ' .b24c-chat-meta{font-size:10px;color:#64748b;margin-bottom:2px;display:flex;justify-content:space-between;gap:6px}',
                '#' + CARD_ID + ' .b24c-chat-text{color:#0f172a;white-space:pre-wrap}',
                '#' + CARD_ID + ' .b24c-chat-form{display:flex;gap:6px;align-items:center}',
                '#' + CARD_ID + ' .b24c-chat-input{flex:1;min-width:0;height:28px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:4px;font:12px Arial,sans-serif;color:#0f172a;background:#fff}',
                '#' + CARD_ID + ' .b24c-chat-send{height:28px;padding:0 10px;border:1px solid #1769f5;border-radius:4px;background:#1769f5;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}',
                '#' + CARD_ID + ' .b24c-chat-send:hover{background:#0758d8}',
                '#' + CARD_ID + ' .b24c-chat-send:disabled{opacity:0.55;cursor:default}',
                '#' + CARD_ID + ' .b24c-chat-alt{display:flex;flex-direction:column;gap:6px;margin-top:4px}',
                '#' + CARD_ID + ' .b24c-muted{color:#6b7280;font-size:12px}',
                '#' + CARD_ID + ' .b24c-error{color:#b91c1c;font-size:12px}',
                '#' + CARD_ID + ' .b24c-empty-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
                '#' + CARD_ID + ' .b24c-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;background:#e0f2fe;color:#0369a1;font-size:10px;font-weight:600;vertical-align:middle}',
                '#' + CARD_ID + ' .b24c-inline-btn{margin-top:4px;background:#1769f5;color:#fff;border:1px solid #1769f5;border-radius:4px;padding:5px 10px;font-size:12px;cursor:pointer;align-self:flex-start}',
                '#' + CARD_ID + ' .b24c-inline-btn.secondary{margin-top:0;background:#fff;color:#1d4ed8;border-color:#cbd5e1;padding:3px 9px}',
                '#' + CARD_ID + ' .b24c-inline-btn.secondary:hover{background:#eff6ff;border-color:#93c5fd}',
                '#' + CARD_ID + ' .b24c-inline-btn:hover{background:#0758d8}',
                '@media(max-width:720px){#' + CARD_ID + ' .b24c-grid{grid-template-columns:1fr}}',
                '#' + MODAL_ID + '{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(14,25,43,.58);box-sizing:border-box}',
                '#' + MODAL_ID + ' form{box-sizing:border-box;width:min(640px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;color:#202a35;border-radius:7px;box-shadow:0 16px 48px #0005;font:14px Arial,sans-serif}',
                '#' + MODAL_ID + ' *{box-sizing:border-box}',
                '#' + MODAL_ID + ' .b24c-m-header{padding:16px 22px 12px;border-bottom:1px solid #dfe5ed}',
                '#' + MODAL_ID + ' .b24c-m-header h2{margin:0;font-size:19px}',
                '#' + MODAL_ID + ' .b24c-m-sub{margin:4px 0 0;color:#5c6a7a;font-size:12px}',
                '#' + MODAL_ID + ' .b24c-m-body{padding:14px 22px;display:flex;flex-direction:column;gap:12px}',
                '#' + MODAL_ID + ' .b24c-m-card{padding:12px 14px;border:1px solid #dfe5ed;border-radius:5px;background:#f8fafc}',
                '#' + MODAL_ID + ' label{display:block;color:#334155;font-size:12px;font-weight:600;margin-bottom:8px}',
                '#' + MODAL_ID + ' label:last-child{margin-bottom:0}',
                '#' + MODAL_ID + ' input:not([type=checkbox]),#' + MODAL_ID + ' select{display:block;width:100%;margin:4px 0 0;padding:5px 8px;border:1px solid #b9c4d2;border-radius:3px;background:#fff;color:#202a35;font:13px Arial,sans-serif}',
                '#' + MODAL_ID + ' input:not([type=checkbox]){height:31px}',
                '#' + MODAL_ID + ' select.b24c-m-select{height:auto;min-height:118px;padding:4px}',
                '#' + MODAL_ID + ' input:focus,#' + MODAL_ID + ' select:focus{outline:2px solid #90bcff;border-color:#1769f5}',
                '#' + MODAL_ID + ' .b24c-m-btn-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
                '#' + MODAL_ID + ' .b24c-m-links-list{margin-top:10px;border-top:1px solid #e2e8f0;padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:130px;overflow-y:auto}',
                '#' + MODAL_ID + ' .b24c-m-link-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;background:#fff;border:1px solid #e2e8f0;border-radius:3px;font-size:12px}',
                '#' + MODAL_ID + ' .b24c-m-link-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1e293b}',
                '#' + MODAL_ID + ' .b24c-m-btn-sm{padding:2px 7px !important;font-size:11px !important;flex-shrink:0}',
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
                '#' + LEFTBAR_TAB_ID + '{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:44px;cursor:pointer;color:#fff;transition:background .15s,color .15s;box-sizing:border-box;user-select:none}',
                '#' + LEFTBAR_TAB_ID + ':hover{background:rgba(255,255,255,0.14)}',
                '#' + LEFTBAR_TAB_ID + '.active{background:#fff;color:#14498a}',
                '#' + LEFTBAR_TAB_ID + ' svg{width:23px;height:23px;display:block}',
                '#' + LEFTBAR_BADGE_ID + '{position:absolute;top:5px;right:6px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#ef4444;color:#fff;font:700 10px/16px Arial,sans-serif;text-align:center;box-shadow:0 0 0 1.5px #14498a;display:none}',
                '#' + LEFTBAR_BADGE_ID + '.visible{display:inline-block}',
                '.b24c-dev-unread{background:linear-gradient(90deg,rgba(254,243,199,0.72),rgba(239,246,255,0.65)) !important;box-shadow:inset 3px 0 0 #ef4444 !important}',
                '.b24c-dev-icon-unread{position:relative !important;outline:2px solid #ef4444 !important;outline-offset:1px;border-radius:5px !important;box-shadow:0 0 8px rgba(239,68,68,0.55) !important;animation:b24c-pulse 1.8s ease-in-out infinite}',
                '.b24c-dev-msg-badge{display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:1px 6px;border-radius:10px;background:#ef4444;color:#fff;font:700 11px/15px Arial,sans-serif;cursor:pointer;vertical-align:middle;box-shadow:0 1px 3px rgba(0,0,0,0.2);text-decoration:none}',
                '.b24c-dev-msg-badge:hover{background:#dc2626}',
                '#' + CHATS_PAGE_ID + '{display:none;padding:10px 14px;box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;color:#0f172a;height:calc(100vh - 140px);max-height:calc(100vh - 110px);min-height:440px;flex-direction:column;gap:10px}',
                '#' + CHATS_PAGE_ID + '.visible{display:flex}',
                '#' + CHATS_PAGE_ID + ' *{box-sizing:border-box}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:#fff;border:1px solid #d5dce6;border-radius:6px;flex-shrink:0;flex-wrap:wrap}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-title{margin:0;font-size:17px;font-weight:700;display:flex;align-items:center;gap:8px}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-user{display:flex;align-items:center;gap:10px;font-size:12px;color:#475569}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-btn{background:#fff;color:#1e3a8a;border:1px solid #cbd5e1;border-radius:4px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-btn:hover{background:#eff6ff;border-color:#93c5fd}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-login{max-width:460px;background:#fff;border:1px solid #d5dce6;border-radius:6px;padding:18px;display:flex;flex-direction:column;gap:10px}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-layout{flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr;gap:10px}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-sidebar{background:#fff;border:1px solid #d5dce6;border-radius:6px;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-controls{padding:8px;border-bottom:1px solid #e2e8f0;display:flex;flex-direction:column;gap:6px;flex-shrink:0}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-search{width:100%;height:30px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:4px;font:12px Arial,sans-serif}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-tabs{display:flex;gap:6px}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-tab{flex:1;padding:4px 8px;font-size:11px;font-weight:600;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;color:#475569;cursor:pointer}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-tab.active{background:#1769f5;color:#fff;border-color:#1769f5}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-list{flex:1;min-height:0;overflow-y:auto}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-item{padding:9px 10px;border-bottom:1px solid #f1f5f9;cursor:pointer;display:flex;flex-direction:column;gap:3px;transition:background .12s}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-item:hover{background:#f8fafc}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-item.selected{background:#eff6ff;box-shadow:inset 3px 0 0 #1769f5}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-item.unread{background:#fffbeb}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-top{display:flex;align-items:center;justify-content:space-between;gap:6px}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-name{font-size:13px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-time{font-size:10px;color:#64748b;flex-shrink:0}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-bottom{display:flex;align-items:center;justify-content:space-between;gap:6px}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-preview{font-size:12px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#ef4444;color:#fff;font:700 11px/18px Arial,sans-serif;text-align:center;flex-shrink:0}',
                '#' + CHATS_PAGE_ID + ' .b24c-dialog-tags{display:flex;flex-wrap:wrap;gap:4px}',
                '#' + CHATS_PAGE_ID + ' .b24c-tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:#e0f2fe;color:#0369a1;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '#' + CHATS_PAGE_ID + ' .b24c-tag.group{background:#f1f5f9;color:#475569}',
                '#' + CHATS_PAGE_ID + ' .b24c-p-main{background:#fff;border:1px solid #d5dce6;border-radius:6px;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-head{padding:10px 14px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;background:#f8fafc;flex-shrink:0}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-title{font-size:15px;font-weight:700;color:#0f172a}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-sub{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px;font-size:12px}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-msgs{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:#fafcff}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-msgs .b24c-chat-msg{max-width:78%;padding:7px 10px;border-radius:6px;font-size:13px;align-self:flex-start;background:#eef2f7}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-msgs .b24c-chat-msg.mine{align-self:flex-end;background:#dbeafe}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-err{padding:5px 12px;background:#fef2f2;color:#b91c1c;border-top:1px solid #fecaca;font-size:12px;flex-shrink:0;display:none}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-form{padding:10px 12px;border-top:1px solid #e2e8f0;display:flex;gap:8px;align-items:flex-end;background:#fff;flex-shrink:0}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-input{flex:1;min-height:38px;max-height:110px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:4px;font:13px Arial,sans-serif;resize:vertical;color:#0f172a;background:#fff}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-send{height:38px;padding:0 16px;border:1px solid #1769f5;border-radius:4px;background:#1769f5;color:#fff;font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0}',
                '#' + CHATS_PAGE_ID + ' .b24c-thread-send:disabled{opacity:0.55;cursor:default}',
                '#' + CHATS_PAGE_ID + ' .b24c-empty-thread{margin:auto;text-align:center;color:#64748b;font-size:13px;padding:24px}',
                '@media(max-width:860px){#' + CHATS_PAGE_ID + ' .b24c-p-layout{grid-template-columns:1fr;grid-template-rows:240px 1fr}}',
                '@keyframes b24c-pulse{0%,100%{box-shadow:0 0 6px rgba(239,68,68,0.45)}50%{box-shadow:0 0 12px rgba(239,68,68,0.9)}}',
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

        function stopKeyPropagation(el) {
            ['keydown', 'keypress', 'keyup'].forEach(function (t) {
                el.addEventListener(t, function (e) { e.stopPropagation(); });
            });
        }

        function formatMsgTime(isoStr) {
            if (!isoStr) return '';
            try {
                var d = new Date(isoStr);
                if (isNaN(d.getTime())) return '';
                return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } catch (e) {
                return '';
            }
        }

        function renderBitrixLoginBlock(container, authObj, errMsg, onSuccess, onRenderError) {
            var currentAuth = authObj || { authenticated: false, oauthConfigured: false };

            var hint = document.createElement('div');
            hint.className = 'b24c-muted';
            hint.textContent = 'Войдите под своим аккаунтом Битрикс24, чтобы видеть переписку, непрочитанные чаты и отвечать от своего имени.';
            container.appendChild(hint);

            if (errMsg) {
                var errDiv = document.createElement('div');
                errDiv.className = 'b24c-error';
                errDiv.textContent = errMsg;
                container.appendChild(errDiv);
            }

            if (currentAuth && currentAuth.oauthConfigured) {
                var oauthBtn = document.createElement('button');
                oauthBtn.type = 'button';
                oauthBtn.className = 'b24c-inline-btn';
                oauthBtn.textContent = 'Войти через Битрикс24';
                oauthBtn.onclick = function () {
                    oauthBtn.disabled = true;
                    sendPluginAction('startOAuth', { origin: window.location.origin }, pendingChat)
                        .then(function (res) {
                            oauthBtn.disabled = false;
                            if (!res || !res.ok || !res.authorizeUrl) {
                                onRenderError((res && res.error) || 'Не удалось начать вход');
                                return;
                            }
                            var popup = window.open(res.authorizeUrl, 'b24contacts_oauth', 'width=540,height=660');
                            if (!popup) {
                                onRenderError('Браузер заблокировал всплывающее окно. Разрешите pop-up для этого сайта.');
                                return;
                            }
                            var checkTimer = setInterval(function () {
                                if (popup.closed) {
                                    clearInterval(checkTimer);
                                    sendPluginAction('getChatAuth', {}, pendingChat).then(function (authRes) {
                                        if (authRes && authRes.auth && authRes.auth.authenticated) {
                                            responseCache.clear();
                                            onSuccess(authRes.auth);
                                        }
                                    }).catch(function () {});
                                }
                            }, 500);
                        })
                        .catch(function (err) {
                            oauthBtn.disabled = false;
                            onRenderError(err && err.message);
                        });
                };
                container.appendChild(oauthBtn);
            } else {
                var noOAuthNote = document.createElement('div');
                noOAuthNote.className = 'b24c-muted';
                noOAuthNote.textContent = 'OAuth-вход не настроен администратором — можно войти по своему личному вебхуку Битрикс24 (права: user, im):';
                container.appendChild(noOAuthNote);
            }

            var altWrap = document.createElement('div');
            altWrap.className = 'b24c-chat-alt';
            var altToggle = document.createElement('button');
            altToggle.type = 'button';
            altToggle.className = 'b24c-chat-btn-link';
            altToggle.style.textAlign = 'left';
            altToggle.style.padding = '0';
            altToggle.textContent = (currentAuth && currentAuth.oauthConfigured)
                ? 'Или войти по личному вебхуку'
                : 'Указать личный вебхук';

            var hookForm = document.createElement('form');
            hookForm.className = 'b24c-chat-form';
            hookForm.style.display = (currentAuth && currentAuth.oauthConfigured) ? 'none' : 'flex';
            var hookInput = document.createElement('input');
            hookInput.type = 'password';
            hookInput.className = 'b24c-chat-input';
            hookInput.placeholder = 'https://.../rest/ID/токен/';
            hookInput.autocomplete = 'off';
            stopKeyPropagation(hookInput);
            var hookSave = document.createElement('button');
            hookSave.type = 'submit';
            hookSave.className = 'b24c-chat-send';
            hookSave.textContent = 'Войти';
            hookForm.appendChild(hookInput);
            hookForm.appendChild(hookSave);

            altToggle.onclick = function () {
                hookForm.style.display = hookForm.style.display === 'none' ? 'flex' : 'none';
            };
            hookForm.onsubmit = function (e) {
                e.preventDefault();
                var val = hookInput.value.trim();
                if (!val) return;
                hookSave.disabled = true;
                sendPluginAction('savePersonalWebhook', { webhookUrl: val }, pendingChat)
                    .then(function (res) {
                        hookSave.disabled = false;
                        if (!res || !res.ok || !res.auth || !res.auth.authenticated) {
                            onRenderError((res && res.error) || 'Не удалось проверить личный вебхук');
                            return;
                        }
                        responseCache.clear();
                        onSuccess(res.auth);
                    })
                    .catch(function (err) {
                        hookSave.disabled = false;
                        onRenderError(err && err.message);
                    });
            };

            altWrap.appendChild(altToggle);
            altWrap.appendChild(hookForm);
            container.appendChild(altWrap);
        }

        function scrollMsgsToBottom(msgsBox) {
            if (!msgsBox) return;
            var apply = function () {
                try { msgsBox.scrollTop = msgsBox.scrollHeight; } catch (e) {}
            };
            apply();
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(apply);
            }
            if (typeof setTimeout === 'function') {
                setTimeout(apply, 20);
            }
        }

        function renderMessagesInto(msgsBox, messages, emptyText, forceScrollBottom) {
            var hadRendered = Boolean(msgsBox.dataset && msgsBox.dataset.b24cHasRendered);
            var prevScrollTop = msgsBox.scrollTop || 0;
            var distFromBottom = (msgsBox.scrollHeight || 0) - prevScrollTop - (msgsBox.clientHeight || 0);
            var wasNearBottom = !hadRendered || distFromBottom <= 50;

            msgsBox.replaceChildren();
            if (!Array.isArray(messages) || messages.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'b24c-muted';
                empty.textContent = emptyText || 'Сообщений пока нет — напишите первое';
                msgsBox.appendChild(empty);
                return;
            }
            for (var i = 0; i < messages.length; i++) {
                var m = messages[i];
                var item = document.createElement('div');
                item.className = 'b24c-chat-msg' + (m.isMine ? ' mine' : '');

                var meta = document.createElement('div');
                meta.className = 'b24c-chat-meta';
                var author = document.createElement('span');
                author.textContent = m.isMine ? 'Вы' : (m.authorName || 'Сотрудник');
                var tm = document.createElement('span');
                tm.textContent = formatMsgTime(m.date);
                meta.appendChild(author);
                meta.appendChild(tm);

                var txt = document.createElement('div');
                txt.className = 'b24c-chat-text';
                txt.textContent = m.text || '';

                item.appendChild(meta);
                item.appendChild(txt);
                msgsBox.appendChild(item);
            }
            if (msgsBox.dataset) msgsBox.dataset.b24cHasRendered = '1';
            if (forceScrollBottom || wasNearBottom) {
                scrollMsgsToBottom(msgsBox);
            } else {
                try { msgsBox.scrollTop = prevScrollTop; } catch (e) {}
            }
        }

        function collectVisibleNodes() {
            var arr = [];
            if (typeof nodes !== 'undefined' && Array.isArray(nodes)) {
                for (var i = 0; i < nodes.length; i++) {
                    var n = nodes[i];
                    if (n && n._id && n.v !== false) {
                        arr.push({ id: String(n._id), name: typeof n.name === 'string' ? n.name : '' });
                    }
                }
            }
            return arr;
        }

        function updateLeftbarBadge() {
            var badge = document.getElementById(LEFTBAR_BADGE_ID);
            if (!badge) return;
            var total = Number(overviewState.unreadTotal) || 0;
            if (total > 0) {
                badge.textContent = total > 99 ? '99+' : String(total);
                badge.classList.add('visible');
            } else {
                badge.textContent = '';
                badge.classList.remove('visible');
            }
        }

        function findDeviceRowFromCheckbox(chk, root) {
            var cur = chk;
            var steps = 0;
            while (cur && cur.parentElement && cur.parentElement !== root && steps < 5) {
                var parent = cur.parentElement;
                if (typeof parent.querySelectorAll === 'function') {
                    var count = parent.querySelectorAll('.DeviceCheckbox, input[value^="devid_"], input[id^="devid_"]').length;
                    if (count > 1) break;
                }
                cur = parent;
                steps++;
                if (cur.tagName === 'TR') break;
            }
            return cur;
        }

        function highlightUnreadDevices() {
            var root = document.getElementById('xdevices') || document.getElementById('p1');
            if (!root || typeof root.querySelectorAll !== 'function') return;

            var checkboxes = root.querySelectorAll('.DeviceCheckbox, input[value^="devid_"], input[id^="devid_"]');
            var unreadMap = overviewState.unreadNodeIds || {};

            for (var i = 0; i < checkboxes.length; i++) {
                var chk = checkboxes[i];
                var raw = (chk.value && chk.value.indexOf('devid_') === 0)
                    ? chk.value
                    : (chk.id && chk.id.indexOf('devid_') === 0 ? chk.id : '');
                if (!raw) continue;
                var nodeId = raw.slice(6);
                var rowEl = findDeviceRowFromCheckbox(chk, root);
                if (!rowEl || rowEl === root) continue;

                var iconEl = typeof rowEl.querySelector === 'function'
                    ? rowEl.querySelector('.i32, .i24, .i28, .i16, [class*="Icon"], [class*="icon"]:not(.b24c-icon), img, svg')
                    : null;
                var oldBadge = typeof rowEl.querySelector === 'function'
                    ? rowEl.querySelector('.b24c-dev-msg-badge')
                    : null;
                var info = unreadMap[nodeId];

                if (info && info.count > 0) {
                    rowEl.classList.add('b24c-dev-unread');
                    if (iconEl) iconEl.classList.add('b24c-dev-icon-unread');
                    var tip = 'Новое сообщение в Битрикс24' + (info.title ? ' (' + info.title + ')' : '') + (info.preview ? ': ' + info.preview : '');
                    if (!oldBadge) {
                        oldBadge = document.createElement('span');
                        oldBadge.className = 'b24c-dev-msg-badge';
                        (function (dlgId) {
                            oldBadge.onclick = function (e) {
                                if (e && e.stopPropagation) e.stopPropagation();
                                if (e && e.preventDefault) e.preventDefault();
                                openChatsPage(dlgId);
                            };
                        })(info.dialogId);
                        if (iconEl && iconEl.parentElement && iconEl.parentElement !== rowEl) {
                            iconEl.parentElement.appendChild(oldBadge);
                        } else {
                            rowEl.appendChild(oldBadge);
                        }
                    }
                    oldBadge.textContent = '💬 ' + info.count;
                    oldBadge.title = tip;
                } else {
                    rowEl.classList.remove('b24c-dev-unread');
                    if (iconEl) iconEl.classList.remove('b24c-dev-icon-unread');
                    if (oldBadge) {
                        if (typeof oldBadge.remove === 'function') oldBadge.remove();
                        else if (oldBadge.parentNode && typeof oldBadge.parentNode.removeChild === 'function') oldBadge.parentNode.removeChild(oldBadge);
                    }
                }
            }
        }

        function clearDialogUnreadLocal(dialogId) {
            if (!dialogId) return;
            var changed = false;
            var dialogs = overviewState.dialogs || [];
            var total = 0;
            var dCount = 0;
            for (var i = 0; i < dialogs.length; i++) {
                var d = dialogs[i];
                if (String(d.dialogId) === String(dialogId) && (d.counter > 0 || d.unread)) {
                    d.counter = 0;
                    d.unread = false;
                    changed = true;
                }
                if (d.counter > 0) {
                    total += d.counter;
                    dCount++;
                }
            }
            var unreadNodes = overviewState.unreadNodeIds || {};
            var nKeys = Object.keys(unreadNodes);
            for (var k = 0; k < nKeys.length; k++) {
                if (String(unreadNodes[nKeys[k]].dialogId) === String(dialogId)) {
                    delete unreadNodes[nKeys[k]];
                    changed = true;
                }
            }
            if (changed) {
                overviewState.unreadTotal = dialogs.length ? total : Math.max(0, (overviewState.unreadTotal || 0) - 1);
                overviewState.unreadDialogsCount = dialogs.length ? dCount : Math.max(0, (overviewState.unreadDialogsCount || 0) - 1);
                updateLeftbarBadge();
                highlightUnreadDevices();
                if (chatsPageState.open) renderChatsPageSidebarList();
            }
        }

        function ensureLeftbarTab() {
            var bar = document.getElementById('page_leftbar');
            if (!bar) return null;
            var btn = document.getElementById(LEFTBAR_TAB_ID);
            if (!btn) {
                btn = document.createElement('div');
                btn.id = LEFTBAR_TAB_ID;
                btn.setAttribute('role', 'button');
                btn.setAttribute('tabindex', '0');
                btn.title = 'Чаты Битрикс24';
                var icon = createSvgIcon('chat');
                icon.setAttribute('class', '');
                btn.appendChild(icon);

                var badge = document.createElement('span');
                badge.id = LEFTBAR_BADGE_ID;
                btn.appendChild(badge);

                btn.onclick = function () { openChatsPage(); };
                btn.onkeydown = function (e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openChatsPage();
                    }
                };

                var anchor = null;
                var ch = bar.children || [];
                if (ch.length > 0) {
                    var last = ch[ch.length - 1];
                    if (last && typeof last.getAttribute === 'function' && !last.getAttribute('onclick') && (!last.children || last.children.length === 0)) {
                        anchor = last;
                    }
                }
                if (anchor) bar.insertBefore(btn, anchor);
                else bar.appendChild(btn);
            }
            if (chatsPageState.open) btn.classList.add('active');
            else btn.classList.remove('active');
            updateLeftbarBadge();
            return btn;
        }

        function fitChatsPageHeight() {
            var page = document.getElementById(CHATS_PAGE_ID);
            if (!page || !chatsPageState.open) return;
            if (typeof window.innerHeight === 'number' && typeof page.getBoundingClientRect === 'function') {
                var rect = page.getBoundingClientRect();
                var top = (rect && typeof rect.top === 'number' && rect.top > 0) ? rect.top : 110;
                var avail = Math.max(420, window.innerHeight - Math.round(top) - 18);
                page.style.height = avail + 'px';
                page.style.maxHeight = avail + 'px';
            }
        }

        function ensureChatsPageElement() {
            injectStyles();
            var col = document.getElementById('column_l');
            if (!col) return null;
            var page = document.getElementById(CHATS_PAGE_ID);
            if (!page) {
                page = document.createElement('div');
                page.id = CHATS_PAGE_ID;
                stopKeyPropagation(page);
                col.appendChild(page);
                if (typeof window.addEventListener === 'function' && !window._b24cResizeBound) {
                    window._b24cResizeBound = true;
                    window.addEventListener('resize', fitChatsPageHeight);
                }
            }
            return page;
        }

        function closeChatsPage() {
            chatsPageState.open = false;
            var page = document.getElementById(CHATS_PAGE_ID);
            if (page) page.classList.remove('visible');
            var btn = document.getElementById(LEFTBAR_TAB_ID);
            if (btn) btn.classList.remove('active');
            var bar = document.getElementById('page_leftbar');
            if (bar) {
                var items = bar.children || [];
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    if (item === btn || !item.dataset) continue;
                    if (item.dataset.b24cHadInlineBg) {
                        item.style.backgroundColor = '';
                        item.style.color = '';
                        delete item.dataset.b24cHadInlineBg;
                    }
                }
            }
        }

        function loadChatsPageThread(dialogId, silent) {
            if (!dialogId) return;
            chatsPageState.loadingThread = !silent;
            if (!silent) {
                chatsPageState.threadError = '';
                renderChatsPageThreadPane(true);
            }

            sendPluginAction('getChatMessages', { dialogId: dialogId, limit: 30, markRead: true }, pendingChat)
                .then(function (res) {
                    if (chatsPageState.selectedDialogId !== dialogId) return;
                    chatsPageState.loadingThread = false;
                    if (res && res.auth) overviewState.auth = res.auth;
                    if (res && res.authRequired) {
                        overviewState.authenticated = false;
                        renderChatsPageBody();
                        return;
                    }
                    if (!res || !res.ok) {
                        if (!silent) {
                            chatsPageState.threadError = (res && res.error) || 'Не удалось загрузить сообщения';
                            renderChatsPageThreadPane(false);
                        }
                        return;
                    }
                    chatsPageState.threadError = '';
                    chatsPageState.messages = Array.isArray(res.messages) ? res.messages : [];
                    clearDialogUnreadLocal(dialogId);
                    renderChatsPageThreadPane(!silent);
                })
                .catch(function (err) {
                    if (chatsPageState.selectedDialogId !== dialogId) return;
                    chatsPageState.loadingThread = false;
                    if (!silent) {
                        chatsPageState.threadError = err && err.message ? err.message : 'Ошибка загрузки переписки';
                        renderChatsPageThreadPane(false);
                    }
                });
        }

        function selectDialogOnPage(dialogId) {
            chatsPageState.selectedDialogId = String(dialogId || '');
            chatsPageState.messages = [];
            chatsPageState.threadError = '';
            clearDialogUnreadLocal(chatsPageState.selectedDialogId);
            renderChatsPageSidebarList();
            loadChatsPageThread(chatsPageState.selectedDialogId, false);
        }

        function getSelectedDialogObj() {
            var id = chatsPageState.selectedDialogId;
            if (!id) return null;
            var dialogs = overviewState.dialogs || [];
            for (var i = 0; i < dialogs.length; i++) {
                if (String(dialogs[i].dialogId) === String(id)) return dialogs[i];
            }
            return null;
        }

        function renderChatsPageSidebarList() {
            var page = document.getElementById(CHATS_PAGE_ID);
            if (!page) return;
            var listEl = page.querySelector('.b24c-dialog-list');
            var tabs = page.querySelectorAll('.b24c-p-tab');
            if (!listEl) return;

            var allDialogs = overviewState.dialogs || [];
            var unreadCount = 0;
            for (var c = 0; c < allDialogs.length; c++) {
                if (allDialogs[c].counter > 0 || allDialogs[c].unread) unreadCount++;
            }
            if (tabs.length >= 2) {
                tabs[0].textContent = 'Все (' + allDialogs.length + ')';
                tabs[1].textContent = 'Непрочитанные (' + unreadCount + ')';
                tabs[0].classList.toggle('active', chatsPageState.filterMode !== 'unread');
                tabs[1].classList.toggle('active', chatsPageState.filterMode === 'unread');
            }

            var q = (chatsPageState.searchQuery || '').trim().toLowerCase().replace(/ё/g, 'е');
            listEl.replaceChildren();
            var shown = 0;

            for (var i = 0; i < allDialogs.length; i++) {
                var d = allDialogs[i];
                if (chatsPageState.filterMode === 'unread' && !(d.counter > 0 || d.unread)) continue;
                var nodesText = Array.isArray(d.linkedNodes)
                    ? d.linkedNodes.map(function (ln) { return ln.nodeName || ln.nodeId; }).join(' ')
                    : '';
                if (q) {
                    var hay = (d.title + ' ' + nodesText + ' ' + ((d.lastMessage && d.lastMessage.text) || '')).toLowerCase().replace(/ё/g, 'е');
                    if (hay.indexOf(q) === -1) continue;
                }
                shown++;

                var item = document.createElement('div');
                item.className = 'b24c-dialog-item'
                    + (String(d.dialogId) === String(chatsPageState.selectedDialogId) ? ' selected' : '')
                    + (d.counter > 0 ? ' unread' : '');
                (function (dlgId) {
                    item.onclick = function () { selectDialogOnPage(dlgId); };
                })(d.dialogId);

                var top = document.createElement('div');
                top.className = 'b24c-dialog-top';
                var nameSpan = document.createElement('span');
                nameSpan.className = 'b24c-dialog-name';
                nameSpan.textContent = d.title || ('Диалог ' + d.dialogId);
                var timeSpan = document.createElement('span');
                timeSpan.className = 'b24c-dialog-time';
                timeSpan.textContent = formatMsgTime(d.lastMessage && d.lastMessage.date);
                top.appendChild(nameSpan);
                top.appendChild(timeSpan);
                item.appendChild(top);

                if ((Array.isArray(d.linkedNodes) && d.linkedNodes.length > 0) || d.type !== 'user') {
                    var tags = document.createElement('div');
                    tags.className = 'b24c-dialog-tags';
                    if (d.type !== 'user') {
                        var gTag = document.createElement('span');
                        gTag.className = 'b24c-tag group';
                        gTag.textContent = 'Групповой чат';
                        tags.appendChild(gTag);
                    }
                    if (Array.isArray(d.linkedNodes) && d.linkedNodes.length > 0) {
                        var pcTag = document.createElement('span');
                        pcTag.className = 'b24c-tag';
                        pcTag.textContent = d.linkedNodes.length === 1
                            ? ('ПК: ' + (d.linkedNodes[0].nodeName || d.linkedNodes[0].nodeId))
                            : ('ПК: ' + d.linkedNodes.length + ' шт.');
                        tags.appendChild(pcTag);
                    }
                    item.appendChild(tags);
                }

                var bottom = document.createElement('div');
                bottom.className = 'b24c-dialog-bottom';
                var prev = document.createElement('span');
                prev.className = 'b24c-dialog-preview';
                prev.textContent = (d.lastMessage && d.lastMessage.text) || 'Нет сообщений';
                bottom.appendChild(prev);
                if (d.counter > 0) {
                    var cnt = document.createElement('span');
                    cnt.className = 'b24c-dialog-badge';
                    cnt.textContent = d.counter > 99 ? '99+' : String(d.counter);
                    bottom.appendChild(cnt);
                }
                item.appendChild(bottom);

                listEl.appendChild(item);
            }

            if (shown === 0) {
                var empty = document.createElement('div');
                empty.className = 'b24c-muted';
                empty.style.padding = '16px';
                empty.textContent = allDialogs.length === 0
                    ? 'Список диалогов пока пуст'
                    : 'Подходящие чаты не найдены';
                listEl.appendChild(empty);
            }
        }

        function renderChatsPageThreadPane(forceScrollBottom) {
            var page = document.getElementById(CHATS_PAGE_ID);
            if (!page) return;
            var mainPane = page.querySelector('.b24c-p-main');
            if (!mainPane) return;

            var dlg = getSelectedDialogObj();

            if (!dlg && !chatsPageState.selectedDialogId) {
                mainPane.dataset.dialogId = '';
                mainPane.replaceChildren();
                var placeholder = document.createElement('div');
                placeholder.className = 'b24c-empty-thread';
                placeholder.textContent = 'Выберите чат слева, чтобы прочитать сообщения и ответить.';
                mainPane.appendChild(placeholder);
                return;
            }

            var activeDialogId = dlg ? String(dlg.dialogId) : String(chatsPageState.selectedDialogId);

            function syncThreadMessages(msgsBox, errBanner) {
                if (errBanner) {
                    if (chatsPageState.threadError) {
                        errBanner.textContent = chatsPageState.threadError;
                        errBanner.style.display = 'block';
                    } else {
                        errBanner.textContent = '';
                        errBanner.style.display = 'none';
                    }
                }
                if (!msgsBox) return;
                if (chatsPageState.loadingThread && chatsPageState.messages.length === 0) {
                    msgsBox.replaceChildren();
                    var loadEl = document.createElement('div');
                    loadEl.className = 'b24c-muted';
                    loadEl.textContent = 'Загрузка сообщений...';
                    msgsBox.appendChild(loadEl);
                    return;
                }
                renderMessagesInto(msgsBox, chatsPageState.messages, 'Сообщений пока нет — напишите первое', Boolean(forceScrollBottom));
            }

            // Preserve the input form, typed draft, and focus when refreshing messages in the same dialog
            if (mainPane.dataset && mainPane.dataset.dialogId === activeDialogId) {
                var existingMsgs = typeof mainPane.querySelector === 'function' ? mainPane.querySelector('.b24c-thread-msgs') : null;
                var existingErr = typeof mainPane.querySelector === 'function' ? mainPane.querySelector('.b24c-thread-err') : null;
                if (existingMsgs) {
                    syncThreadMessages(existingMsgs, existingErr);
                    return;
                }
            }

            if (mainPane.dataset) mainPane.dataset.dialogId = activeDialogId;
            mainPane.replaceChildren();

            var head = document.createElement('div');
            head.className = 'b24c-thread-head';
            var headLeft = document.createElement('div');
            var title = document.createElement('div');
            title.className = 'b24c-thread-title';
            title.textContent = (dlg && dlg.title) || ('Диалог #' + activeDialogId);
            headLeft.appendChild(title);

            var sub = document.createElement('div');
            sub.className = 'b24c-thread-sub';
            if (dlg && Array.isArray(dlg.phones) && dlg.phones.length > 0) {
                dlg.phones.forEach(function (ph) {
                    if (ph && isSafeTelHref(ph.href)) {
                        var telA = document.createElement('a');
                        telA.className = 'b24c-link';
                        telA.href = ph.href;
                        telA.textContent = ph.display;
                        sub.appendChild(telA);
                    }
                });
            }
            if (dlg && Array.isArray(dlg.linkedNodes) && dlg.linkedNodes.length > 0) {
                dlg.linkedNodes.forEach(function (ln) {
                    var devBtn = document.createElement('button');
                    devBtn.type = 'button';
                    devBtn.className = 'b24c-p-btn';
                    devBtn.textContent = '🖥 ' + (ln.nodeName || ln.nodeId);
                    devBtn.title = 'Открыть компьютер в MeshCentral';
                    devBtn.onclick = function () {
                        closeChatsPage();
                        if (typeof gotoDevice === 'function') gotoDevice(ln.nodeId, 10);
                    };
                    sub.appendChild(devBtn);
                });
            }
            if (sub.children.length > 0) headLeft.appendChild(sub);

            var headRight = document.createElement('div');
            headRight.style.display = 'flex';
            headRight.style.gap = '6px';
            if (dlg && isSafeHttpUrl(dlg.chatUrl)) {
                var openB24 = document.createElement('a');
                openB24.className = 'b24c-p-btn';
                openB24.href = dlg.chatUrl;
                openB24.target = '_blank';
                openB24.rel = 'noopener noreferrer';
                openB24.textContent = 'Открыть в Битрикс24';
                headRight.appendChild(openB24);
            }
            var reloadBtn = document.createElement('button');
            reloadBtn.type = 'button';
            reloadBtn.className = 'b24c-p-btn';
            reloadBtn.textContent = '↻';
            reloadBtn.title = 'Обновить переписку';
            reloadBtn.onclick = function () { loadChatsPageThread(activeDialogId, false); };
            headRight.appendChild(reloadBtn);

            head.appendChild(headLeft);
            head.appendChild(headRight);

            var msgsBox = document.createElement('div');
            msgsBox.className = 'b24c-thread-msgs';

            var errBanner = document.createElement('div');
            errBanner.className = 'b24c-thread-err';

            var sendForm = document.createElement('form');
            sendForm.className = 'b24c-thread-form';
            var textarea = document.createElement('textarea');
            textarea.className = 'b24c-thread-input';
            textarea.placeholder = 'Напишите сообщение (Enter — отправить, Shift+Enter — перенос строки)...';
            textarea.maxLength = 4000;
            stopKeyPropagation(textarea);

            var sendBtn = document.createElement('button');
            sendBtn.type = 'submit';
            sendBtn.className = 'b24c-thread-send';
            sendBtn.textContent = 'Отправить';

            var sending = false;
            function submitCurrentMessage() {
                if (sending) return;
                var text = textarea.value.trim();
                if (!text) return;
                sending = true;
                sendBtn.disabled = true;
                textarea.disabled = true;
                chatsPageState.threadError = '';
                errBanner.style.display = 'none';

                sendPluginAction('sendChatMessage', { dialogId: activeDialogId, message: text, limit: 30 }, pendingChat)
                    .then(function (res) {
                        sending = false;
                        sendBtn.disabled = false;
                        textarea.disabled = false;
                        if (res && res.authRequired) {
                            overviewState.authenticated = false;
                            renderChatsPageBody();
                            return;
                        }
                        if (!res || !res.ok) {
                            chatsPageState.threadError = (res && res.error) || 'Не удалось отправить сообщение';
                            errBanner.textContent = chatsPageState.threadError;
                            errBanner.style.display = 'block';
                            return;
                        }
                        textarea.value = '';
                        chatsPageState.threadError = '';
                        chatsPageState.messages = Array.isArray(res.messages) ? res.messages : [];
                        clearDialogUnreadLocal(activeDialogId);
                        syncThreadMessages(msgsBox, errBanner);
                        scrollMsgsToBottom(msgsBox);
                        try { textarea.focus(); } catch (e) {}
                        refreshChatOverview(true);
                    })
                    .catch(function (err) {
                        sending = false;
                        sendBtn.disabled = false;
                        textarea.disabled = false;
                        chatsPageState.threadError = err && err.message ? err.message : 'Ошибка отправки';
                        errBanner.textContent = chatsPageState.threadError;
                        errBanner.style.display = 'block';
                    });
            }

            textarea.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitCurrentMessage();
                }
            });

            sendForm.onsubmit = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                submitCurrentMessage();
            };

            sendForm.appendChild(textarea);
            sendForm.appendChild(sendBtn);

            // Attach to DOM BEFORE rendering messages so scrollHeight is real and scrolls to newest
            mainPane.appendChild(head);
            mainPane.appendChild(msgsBox);
            mainPane.appendChild(errBanner);
            mainPane.appendChild(sendForm);

            syncThreadMessages(msgsBox, errBanner);
        }

        function renderChatsPageBody() {
            var page = ensureChatsPageElement();
            if (!page) return;
            page.replaceChildren();

            var header = document.createElement('div');
            header.className = 'b24c-p-head';
            var title = document.createElement('h2');
            title.className = 'b24c-p-title';
            title.textContent = 'Чаты Битрикс24';

            var userBar = document.createElement('div');
            userBar.className = 'b24c-p-user';
            if (overviewState.authenticated && overviewState.auth) {
                var who = document.createElement('span');
                who.textContent = overviewState.auth.b24UserName || 'Битрикс24';
                userBar.appendChild(who);

                var syncBtn = document.createElement('button');
                syncBtn.type = 'button';
                syncBtn.className = 'b24c-p-btn';
                syncBtn.textContent = '↻ Обновить';
                syncBtn.onclick = function () {
                    refreshChatOverview(true);
                    if (chatsPageState.selectedDialogId) {
                        loadChatsPageThread(chatsPageState.selectedDialogId, false);
                    }
                };
                userBar.appendChild(syncBtn);

                var logoutBtn = document.createElement('button');
                logoutBtn.type = 'button';
                logoutBtn.className = 'b24c-p-btn';
                logoutBtn.textContent = 'Выйти';
                logoutBtn.onclick = function () {
                    sendPluginAction('logoutChat', {}, pendingChat).then(function (res) {
                        overviewState.authenticated = false;
                        overviewState.auth = (res && res.auth) || { authenticated: false, oauthConfigured: overviewState.auth && overviewState.auth.oauthConfigured };
                        overviewState.dialogs = [];
                        overviewState.unreadNodeIds = {};
                        overviewState.unreadTotal = 0;
                        overviewState.unreadDialogsCount = 0;
                        chatsPageState.selectedDialogId = '';
                        chatsPageState.messages = [];
                        updateLeftbarBadge();
                        highlightUnreadDevices();
                        responseCache.clear();
                        renderChatsPageBody();
                    }).catch(function () {});
                };
                userBar.appendChild(logoutBtn);
            }

            header.appendChild(title);
            header.appendChild(userBar);
            page.appendChild(header);

            if (!overviewState.authenticated) {
                var loginCard = document.createElement('div');
                loginCard.className = 'b24c-p-login';
                renderBitrixLoginBlock(
                    loginCard,
                    overviewState.auth || { authenticated: false, oauthConfigured: false },
                    chatsPageState.threadError,
                    function (newAuth) {
                        overviewState.authenticated = true;
                        overviewState.auth = newAuth;
                        chatsPageState.threadError = '';
                        refreshChatOverview(true);
                    },
                    function (errText) {
                        chatsPageState.threadError = errText || '';
                        renderChatsPageBody();
                    }
                );
                page.appendChild(loginCard);
                return;
            }

            var layout = document.createElement('div');
            layout.className = 'b24c-p-layout';

            var sidebar = document.createElement('div');
            sidebar.className = 'b24c-p-sidebar';

            var controls = document.createElement('div');
            controls.className = 'b24c-p-controls';
            var searchInp = document.createElement('input');
            searchInp.type = 'text';
            searchInp.className = 'b24c-p-search';
            searchInp.placeholder = 'Поиск чата, сотрудника или ПК...';
            searchInp.value = chatsPageState.searchQuery || '';
            stopKeyPropagation(searchInp);
            searchInp.oninput = function () {
                chatsPageState.searchQuery = searchInp.value;
                renderChatsPageSidebarList();
            };

            var tabs = document.createElement('div');
            tabs.className = 'b24c-p-tabs';
            var tabAll = document.createElement('button');
            tabAll.type = 'button';
            tabAll.className = 'b24c-p-tab';
            tabAll.textContent = 'Все';
            tabAll.onclick = function () {
                chatsPageState.filterMode = 'all';
                renderChatsPageSidebarList();
            };
            var tabUnread = document.createElement('button');
            tabUnread.type = 'button';
            tabUnread.className = 'b24c-p-tab';
            tabUnread.textContent = 'Непрочитанные';
            tabUnread.onclick = function () {
                chatsPageState.filterMode = 'unread';
                renderChatsPageSidebarList();
            };
            tabs.appendChild(tabAll);
            tabs.appendChild(tabUnread);

            controls.appendChild(searchInp);
            controls.appendChild(tabs);

            var dialogList = document.createElement('div');
            dialogList.className = 'b24c-dialog-list';

            sidebar.appendChild(controls);
            sidebar.appendChild(dialogList);

            var mainPane = document.createElement('div');
            mainPane.className = 'b24c-p-main';

            layout.appendChild(sidebar);
            layout.appendChild(mainPane);
            page.appendChild(layout);

            renderChatsPageSidebarList();
            renderChatsPageThreadPane();
        }

        function openChatsPage(targetDialogId) {
            var page = ensureChatsPageElement();
            if (!page) return;
            var col = document.getElementById('column_l');
            if (col) {
                var children = col.children || [];
                for (var i = 0; i < children.length; i++) {
                    var child = children[i];
                    if (child && child !== page && child.style) {
                        child.style.display = 'none';
                    }
                }
            }
            if (typeof window.xxcurrentView !== 'undefined') window.xxcurrentView = null;
            else if (typeof xxcurrentView !== 'undefined') { try { xxcurrentView = null; } catch (e) {} }

            var bar = document.getElementById('page_leftbar');
            var btn = ensureLeftbarTab();
            if (bar) {
                var items = bar.children || [];
                for (var b = 0; b < items.length; b++) {
                    var item = items[b];
                    if (item === btn || !item.style) continue;
                    item.dataset.b24cHadInlineBg = '1';
                    item.style.backgroundColor = 'transparent';
                    item.style.color = '#ffffff';
                }
            }
            if (btn) btn.classList.add('active');

            chatsPageState.open = true;
            if (targetDialogId) {
                chatsPageState.selectedDialogId = String(targetDialogId);
            }
            page.classList.add('visible');
            fitChatsPageHeight();
            renderChatsPageBody();
            if (targetDialogId && overviewState.authenticated) {
                selectDialogOnPage(targetDialogId);
            }
            refreshChatOverview(true);
        }

        function refreshChatOverview(includeDialogs) {
            if (overviewState.inFlight) return Promise.resolve();
            overviewState.inFlight = true;
            var wantDialogs = Boolean(includeDialogs || chatsPageState.open);
            return sendPluginAction('getChatOverview', {
                includeDialogs: wantDialogs,
                nodes: collectVisibleNodes()
            }, pendingChat)
                .then(function (res) {
                    overviewState.inFlight = false;
                    overviewState.lastFetchedAt = Date.now();
                    if (!res) return;
                    if (res.auth) overviewState.auth = res.auth;
                    if (res.authRequired) {
                        overviewState.authenticated = false;
                        overviewState.unreadTotal = 0;
                        overviewState.unreadNodeIds = {};
                        updateLeftbarBadge();
                        highlightUnreadDevices();
                        if (chatsPageState.open) renderChatsPageBody();
                        return;
                    }
                    if (!res.ok) return;

                    var wasAuth = overviewState.authenticated;
                    overviewState.authenticated = Boolean(res.authenticated);
                    overviewState.unreadTotal = Number(res.unreadTotal) || 0;
                    overviewState.unreadDialogsCount = Number(res.unreadDialogsCount) || 0;
                    overviewState.unreadNodeIds = (res.unreadNodeIds && typeof res.unreadNodeIds === 'object') ? res.unreadNodeIds : {};
                    overviewState.nodeToB24 = (res.nodeToB24 && typeof res.nodeToB24 === 'object') ? res.nodeToB24 : {};
                    if (wantDialogs && Array.isArray(res.dialogs)) {
                        overviewState.dialogs = res.dialogs;
                    }

                    updateLeftbarBadge();
                    highlightUnreadDevices();

                    if (chatsPageState.open) {
                        if (wasAuth !== overviewState.authenticated || !document.querySelector('#' + CHATS_PAGE_ID + ' .b24c-dialog-list')) {
                            renderChatsPageBody();
                        } else {
                            renderChatsPageSidebarList();
                        }
                        if (overviewState.authenticated && chatsPageState.selectedDialogId) {
                            loadChatsPageThread(chatsPageState.selectedDialogId, true);
                        }
                    }
                })
                .catch(function () {
                    overviewState.inFlight = false;
                });
        }

        function mountMiniChat(container, node, profile, initialAuth) {
            container.replaceChildren();
            var box = document.createElement('div');
            box.className = 'b24c-chat-box';
            container.appendChild(box);

            var dialogId = String(profile.id || '');
            var currentAuth = initialAuth || { authenticated: false, oauthConfigured: false };
            activeChatContext = { node: node, dialogId: dialogId, refreshFn: null };

            function renderLoginView(errMsg) {
                if (chatPollTimer) {
                    clearInterval(chatPollTimer);
                    chatPollTimer = null;
                }
                box.replaceChildren();

                var head = document.createElement('div');
                head.className = 'b24c-chat-head';
                var title = document.createElement('span');
                title.className = 'b24c-chat-me';
                title.textContent = 'Мини-чат Битрикс24';
                head.appendChild(title);
                box.appendChild(head);

                renderBitrixLoginBlock(
                    box,
                    currentAuth,
                    errMsg,
                    function (newAuth) {
                        currentAuth = newAuth;
                        overviewState.authenticated = true;
                        overviewState.auth = newAuth;
                        renderChatView();
                        refreshChatOverview(false);
                    },
                    function (errText) {
                        renderLoginView(errText);
                    }
                );
            }

            function renderChatView() {
                box.replaceChildren();

                var head = document.createElement('div');
                head.className = 'b24c-chat-head';
                var meLabel = document.createElement('span');
                meLabel.className = 'b24c-chat-me';
                meLabel.textContent = 'Чат · ' + (currentAuth.b24UserName || 'Битрикс24');

                var btns = document.createElement('div');
                btns.className = 'b24c-chat-head-btns';

                var syncBtn = document.createElement('button');
                syncBtn.type = 'button';
                syncBtn.className = 'b24c-chat-btn-link';
                syncBtn.title = 'Обновить сообщения';
                syncBtn.textContent = '↻';

                var logoutBtn = document.createElement('button');
                logoutBtn.type = 'button';
                logoutBtn.className = 'b24c-chat-btn-link';
                logoutBtn.textContent = 'Выйти';
                logoutBtn.onclick = function () {
                    sendPluginAction('logoutChat', {}, pendingChat)
                        .then(function (res) {
                            currentAuth = (res && res.auth) || { authenticated: false, oauthConfigured: currentAuth.oauthConfigured };
                            overviewState.authenticated = false;
                            overviewState.unreadTotal = 0;
                            overviewState.unreadNodeIds = {};
                            updateLeftbarBadge();
                            highlightUnreadDevices();
                            responseCache.clear();
                            renderLoginView();
                        })
                        .catch(function () { renderLoginView(); });
                };

                btns.appendChild(syncBtn);
                btns.appendChild(logoutBtn);
                head.appendChild(meLabel);
                head.appendChild(btns);

                var msgsBox = document.createElement('div');
                msgsBox.className = 'b24c-chat-msgs';
                var loadingTxt = document.createElement('div');
                loadingTxt.className = 'b24c-muted';
                loadingTxt.textContent = 'Загрузка сообщений...';
                msgsBox.appendChild(loadingTxt);

                var sendForm = document.createElement('form');
                sendForm.className = 'b24c-chat-form';
                var msgInput = document.createElement('input');
                msgInput.type = 'text';
                msgInput.className = 'b24c-chat-input';
                msgInput.placeholder = 'Сообщение (до 4000 симв.)...';
                msgInput.maxLength = 4000;
                stopKeyPropagation(msgInput);
                var sendBtn = document.createElement('button');
                sendBtn.type = 'submit';
                sendBtn.className = 'b24c-chat-send';
                sendBtn.textContent = 'Отправить';
                sendForm.appendChild(msgInput);
                sendForm.appendChild(sendBtn);

                var statusLine = document.createElement('div');
                statusLine.className = 'b24c-error';
                statusLine.style.display = 'none';

                box.appendChild(head);
                box.appendChild(msgsBox);
                box.appendChild(sendForm);
                box.appendChild(statusLine);

                function loadMessages(silent) {
                    if (!silent) statusLine.style.display = 'none';
                    sendPluginAction('getChatMessages', { nodeId: node._id || '', dialogId: dialogId, limit: 4, markRead: true }, pendingChat)
                        .then(function (res) {
                            if (!box.parentNode) return;
                            if (res && res.auth) currentAuth = res.auth;
                            if (res && res.authRequired) {
                                renderLoginView(res.error || 'Требуется повторный вход в Битрикс24');
                                return;
                            }
                            if (!res || !res.ok) {
                                if (!silent) {
                                    statusLine.textContent = (res && res.error) || 'Не удалось загрузить чат';
                                    statusLine.style.display = 'block';
                                }
                                return;
                            }
                            statusLine.style.display = 'none';
                            clearDialogUnreadLocal(dialogId);
                            renderMessagesInto(msgsBox, res.messages, null, !silent);
                        })
                        .catch(function (err) {
                            if (!silent && box.parentNode) {
                                statusLine.textContent = err && err.message ? err.message : 'Ошибка загрузки чата';
                                statusLine.style.display = 'block';
                            }
                        });
                }

                activeChatContext.refreshFn = function () { loadMessages(true); };
                syncBtn.onclick = function () { loadMessages(false); };

                sendForm.onsubmit = function (e) {
                    e.preventDefault();
                    var text = msgInput.value.trim();
                    if (!text) return;
                    sendBtn.disabled = true;
                    msgInput.disabled = true;
                    statusLine.style.display = 'none';

                    sendPluginAction('sendChatMessage', { nodeId: node._id || '', dialogId: dialogId, message: text, limit: 4 }, pendingChat)
                        .then(function (res) {
                            sendBtn.disabled = false;
                            msgInput.disabled = false;
                            if (res && res.auth) currentAuth = res.auth;
                            if (res && res.authRequired) {
                                renderLoginView(res.error || 'Требуется повторный вход в Битрикс24');
                                return;
                            }
                            if (!res || !res.ok) {
                                statusLine.textContent = (res && res.error) || 'Ошибка отправки';
                                statusLine.style.display = 'block';
                                return;
                            }
                            msgInput.value = '';
                            clearDialogUnreadLocal(dialogId);
                            renderMessagesInto(msgsBox, res.messages, null, true);
                            msgInput.focus();
                        })
                        .catch(function (err) {
                            sendBtn.disabled = false;
                            msgInput.disabled = false;
                            statusLine.textContent = err && err.message ? err.message : 'Ошибка отправки';
                            statusLine.style.display = 'block';
                        });
                };

                loadMessages(false);

                if (chatPollTimer) clearInterval(chatPollTimer);
                chatPollTimer = setInterval(function () {
                    if (!box.parentNode || !isSummaryVisible()) {
                        clearInterval(chatPollTimer);
                        chatPollTimer = null;
                        return;
                    }
                    loadMessages(true);
                }, 15000);
            }

            if (currentAuth && currentAuth.authenticated) {
                renderChatView();
            } else {
                renderLoginView();
            }
        }

        function renderResult(node, data) {
            var card = ensureCardElement(node);
            if (!card) return;
            setRefreshBusy(card, false);

            var body = card.querySelector('.b24c-body');
            body.replaceChildren();

            if (!data || data.ok === false) {
                if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
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
                if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
                var emptyRow = document.createElement('div');
                emptyRow.className = 'b24c-empty-row';
                var emptyEl = document.createElement('div');
                emptyEl.className = data.missingManualUser ? 'b24c-error' : 'b24c-muted';
                emptyEl.textContent = (data.missingManualUser && data.error)
                    ? data.error
                    : 'Связанный профиль в Битрикс24 не найден';
                emptyRow.appendChild(emptyEl);

                if (isCurrentUserAdmin() && node && node._id) {
                    var manualBtn = document.createElement('button');
                    manualBtn.type = 'button';
                    manualBtn.className = 'b24c-inline-btn secondary';
                    manualBtn.textContent = data.missingManualUser ? 'Изменить привязку' : 'Привязать вручную';
                    manualBtn.onclick = function () { openSettingsModal({ focusLinkSearch: true }); };
                    emptyRow.appendChild(manualBtn);
                }

                body.appendChild(emptyRow);
                return;
            }

            var grid = document.createElement('div');
            grid.className = 'b24c-grid';
            var infoCol = document.createElement('div');
            infoCol.className = 'b24c-col-info';
            var chatCol = document.createElement('div');
            chatCol.className = 'b24c-col-chat';

            if (data.profile.displayName) {
                var profEl = document.createElement('div');
                profEl.className = 'b24c-profile';
                profEl.textContent = data.profile.displayName;
                if (data.manualLinked) {
                    var badge = document.createElement('span');
                    badge.className = 'b24c-badge';
                    badge.textContent = 'ручная привязка';
                    profEl.appendChild(badge);
                }
                infoCol.appendChild(profEl);
            }

            var phones = Array.isArray(data.phones) ? data.phones : [];
            if (phones.length === 0) {
                var noPhones = document.createElement('div');
                noPhones.className = 'b24c-muted';
                noPhones.textContent = 'Профиль найден, но номера телефонов не указаны';
                infoCol.appendChild(noPhones);
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

                infoCol.appendChild(list);
            }

            var hasChat = isSafeHttpUrl(data.profile.chatUrl);
            var hasProfile = isSafeHttpUrl(data.profile.profileUrl);
            if (hasChat || hasProfile) {
                var linksBar = document.createElement('div');
                linksBar.className = 'b24c-links';
                if (hasChat) linksBar.appendChild(createActionLink(data.profile.chatUrl, 'Открыть чат', 'chat'));
                if (hasProfile) linksBar.appendChild(createActionLink(data.profile.profileUrl, 'Профиль', 'user'));
                infoCol.appendChild(linksBar);
            }

            grid.appendChild(infoCol);
            if (data.profile.id) {
                grid.appendChild(chatCol);
                body.appendChild(grid);
                mountMiniChat(chatCol, node, data.profile, data.chatAuth);
            } else {
                body.appendChild(infoCol);
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

        function openSettingsModal(opts) {
            injectStyles();
            if (document.getElementById(MODAL_ID)) return;

            var activeNode = (window.currentNode && window.currentNode._id)
                ? { _id: String(window.currentNode._id), name: String(window.currentNode.name || '') }
                : null;
            var cachedUsersList = [];
            var currentManualLinks = {};
            var manualDeleteButtons = [];

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

            var manualCard = document.createElement('section');
            manualCard.className = 'b24c-m-card';
            var manualTitle = document.createElement('label');
            manualTitle.textContent = activeNode
                ? 'Ручная привязка этого компьютера к пользователю Битрикс24'
                : 'Ручные привязки компьютеров к Битрикс24';
            manualCard.appendChild(manualTitle);

            var manualCurrentNote = null;
            var linkSearchInput = null;
            var linkSelect = null;
            var bindBtn = null;
            var unbindBtn = null;

            if (activeNode) {
                manualCurrentNote = document.createElement('p');
                manualCurrentNote.className = 'b24c-m-note';
                manualCurrentNote.textContent = 'ПК: ' + (activeNode.name || activeNode._id) + ' — автоподбор по имени';
                manualCard.appendChild(manualCurrentNote);

                var searchLabel = document.createElement('label');
                searchLabel.textContent = 'Поиск пользователя Битрикс24';
                linkSearchInput = document.createElement('input');
                linkSearchInput.type = 'text';
                linkSearchInput.placeholder = 'Адрес, ФИО, телефон или ID...';
                linkSearchInput.autocomplete = 'off';
                linkSearchInput.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') e.preventDefault();
                });
                searchLabel.appendChild(linkSearchInput);
                manualCard.appendChild(searchLabel);

                linkSelect = document.createElement('select');
                linkSelect.className = 'b24c-m-select';
                linkSelect.size = 6;
                manualCard.appendChild(linkSelect);

                var btnRow = document.createElement('div');
                btnRow.className = 'b24c-m-btn-row';
                bindBtn = document.createElement('button');
                bindBtn.type = 'button';
                bindBtn.className = 'b24c-m-primary';
                bindBtn.textContent = 'Привязать к этому ПК';
                unbindBtn = document.createElement('button');
                unbindBtn.type = 'button';
                unbindBtn.textContent = 'Сбросить (автоподбор)';
                unbindBtn.disabled = true;
                btnRow.appendChild(bindBtn);
                btnRow.appendChild(unbindBtn);
                manualCard.appendChild(btnRow);
            } else {
                var openFromPcNote = document.createElement('p');
                openFromPcNote.className = 'b24c-m-note';
                openFromPcNote.textContent = 'Чтобы привязать конкретный компьютер, откройте его вкладку «Сводка» и нажмите ⚙ или «Привязать вручную».';
                manualCard.appendChild(openFromPcNote);
            }

            var manualListWrap = document.createElement('div');
            manualListWrap.className = 'b24c-m-links-list';
            manualListWrap.style.display = 'none';
            manualCard.appendChild(manualListWrap);

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

            var oauthCard = document.createElement('section');
            oauthCard.className = 'b24c-m-card';

            var oauthTitle = document.createElement('label');
            oauthTitle.textContent = 'Авторизация сотрудников в мини-чате (OAuth 2.0 Битрикс24)';
            var oauthHint = document.createElement('p');
            oauthHint.className = 'b24c-m-note';
            oauthHint.textContent = 'В Битрикс24 (Разработчикам → Другое → Локальное приложение, права: user, im) укажите Redirect URI: ' + (window.location ? window.location.origin : '') + '/plugin/b24contacts/oauth/callback';

            var clientIdLabel = document.createElement('label');
            clientIdLabel.textContent = 'OAuth Client ID (код приложения)';
            var clientIdInput = document.createElement('input');
            clientIdInput.type = 'text';
            clientIdInput.name = 'oauthClientId';
            clientIdInput.placeholder = 'local.xxxxxxxxxx.xxxxxxxx';
            clientIdInput.autocomplete = 'off';
            clientIdLabel.appendChild(clientIdInput);

            var clientSecretLabel = document.createElement('label');
            clientSecretLabel.textContent = 'OAuth Client Secret (ключ приложения)';
            var clientSecretInput = document.createElement('input');
            clientSecretInput.type = 'password';
            clientSecretInput.name = 'oauthClientSecret';
            clientSecretInput.placeholder = 'Оставьте пустым, чтобы не менять';
            clientSecretInput.autocomplete = 'new-password';
            clientSecretLabel.appendChild(clientSecretInput);

            var oauthNote = document.createElement('p');
            oauthNote.className = 'b24c-m-note';
            oauthNote.textContent = 'OAuth-приложение не настроено (пользователи могут входить по личному вебхуку).';

            oauthCard.appendChild(oauthTitle);
            oauthCard.appendChild(oauthHint);
            oauthCard.appendChild(clientIdLabel);
            oauthCard.appendChild(clientSecretLabel);
            oauthCard.appendChild(oauthNote);

            if (activeNode) {
                body.appendChild(manualCard);
                body.appendChild(connCard);
                body.appendChild(oauthCard);
                body.appendChild(testCard);
            } else {
                body.appendChild(connCard);
                body.appendChild(oauthCard);
                body.appendChild(testCard);
                body.appendChild(manualCard);
            }

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

            function renderUsersSelect() {
                if (!linkSelect) return;
                var prevVal = linkSelect.value;
                var linkedId = (activeNode && currentManualLinks[activeNode._id])
                    ? String(currentManualLinks[activeNode._id].b24UserId || '')
                    : '';
                var q = linkSearchInput ? linkSearchInput.value.trim().toLowerCase().replace(/ё/g, 'е') : '';
                linkSelect.replaceChildren();

                var filtered = [];
                for (var i = 0; i < cachedUsersList.length; i++) {
                    var u = cachedUsersList[i];
                    if (!u || !u.id) continue;
                    var phonesStr = Array.isArray(u.phones) && u.phones.length ? u.phones.join(', ') : '';
                    if (q) {
                        var hay = (u.displayName + ' ' + phonesStr + ' ' + u.id).toLowerCase().replace(/ё/g, 'е');
                        if (hay.indexOf(q) === -1) continue;
                    }
                    filtered.push(u);
                }

                if (filtered.length === 0) {
                    var emptyOpt = document.createElement('option');
                    emptyOpt.disabled = true;
                    emptyOpt.textContent = cachedUsersList.length === 0
                        ? 'Справочник пуст — сначала сохраните вебхук или обновите кеш'
                        : 'По запросу «' + q + '» пользователи не найдены';
                    linkSelect.appendChild(emptyOpt);
                    return;
                }

                var targetSelect = prevVal || linkedId;
                for (var j = 0; j < filtered.length; j++) {
                    var item = filtered[j];
                    var opt = document.createElement('option');
                    opt.value = String(item.id);
                    var phonesLabel = Array.isArray(item.phones) && item.phones.length
                        ? (' — ' + item.phones.join(', '))
                        : '';
                    opt.textContent = item.displayName + phonesLabel + ' (ID ' + item.id + ')';
                    if (targetSelect && opt.value === targetSelect) {
                        opt.selected = true;
                    }
                    linkSelect.appendChild(opt);
                }
            }

            function saveManualLinkChange(nodeIdToSave, nodeNameToSave, b24UserIdToSave, clearFlag) {
                setBusy(true);
                status.textContent = clearFlag ? 'Сброс ручной привязки...' : 'Сохранение ручной привязки...';
                sendPluginAction('setManualLink', {
                    nodeId: nodeIdToSave,
                    nodeName: nodeNameToSave || '',
                    b24UserId: clearFlag ? '' : String(b24UserIdToSave || ''),
                    clearManualLink: Boolean(clearFlag)
                }, pendingSettings)
                    .then(function (msg) {
                        setBusy(false);
                        if (!msg || !msg.ok) {
                            status.textContent = 'Ошибка: ' + ((msg && msg.error) || 'не удалось сохранить привязку');
                            return;
                        }
                        applyState(msg);
                        configRevision++;
                        responseCache.clear();
                        if (window.currentNode) loadContactsForNode(window.currentNode, true);
                        status.textContent = clearFlag ? 'Ручная привязка сброшена (включён автоподбор).' : 'Ручная привязка сохранена.';
                    })
                    .catch(function (err) {
                        setBusy(false);
                        status.textContent = 'Ошибка: ' + err.message;
                    });
            }

            function renderManualLinksList() {
                manualListWrap.replaceChildren();
                manualDeleteButtons = [];
                var keys = Object.keys(currentManualLinks || {});
                if (keys.length === 0) {
                    manualListWrap.style.display = 'none';
                    return;
                }
                manualListWrap.style.display = 'flex';
                var head = document.createElement('div');
                head.className = 'b24c-m-note';
                head.style.margin = '0 0 2px';
                head.textContent = 'Все ручные привязки (' + keys.length + '):';
                manualListWrap.appendChild(head);

                keys.forEach(function (nId) {
                    var info = currentManualLinks[nId];
                    if (!info) return;
                    var row = document.createElement('div');
                    row.className = 'b24c-m-link-item';
                    var text = document.createElement('span');
                    text.className = 'b24c-m-link-text';
                    var pcLabel = info.nodeName || nId;
                    var b24Label = info.b24UserName ? (info.b24UserName + ' (ID ' + info.b24UserId + ')') : ('ID ' + info.b24UserId);
                    text.textContent = pcLabel + ' → ' + b24Label;
                    text.title = pcLabel + ' (' + nId + ') → ' + b24Label;
                    var delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'b24c-m-btn-sm';
                    delBtn.textContent = 'Удалить';
                    delBtn.onclick = function () {
                        saveManualLinkChange(nId, info.nodeName || '', '', true);
                    };
                    manualDeleteButtons.push(delBtn);
                    row.appendChild(text);
                    row.appendChild(delBtn);
                    manualListWrap.appendChild(row);
                });
            }

            function applyState(msg) {
                if (!msg) return;
                sub.textContent = formatStatusLine(msg);
                currentWebhookNote.textContent = msg.hasWebhook
                    ? ('Текущий вебхук: ' + msg.maskedWebhookUrl + ' (оставьте поле пустым, чтобы не менять)')
                    : 'Текущий вебхук: не настроен';
                if (msg.oauthClientId != null) clientIdInput.value = String(msg.oauthClientId);
                oauthNote.textContent = msg.oauthConfigured
                    ? 'OAuth-вход через Битрикс24 настроен (ключ сохранён; оставьте поле ключа пустым, чтобы не менять).'
                    : 'OAuth-приложение не настроено (пользователи могут входить по личному вебхуку).';
                if (msg.cacheTtlMinutes != null) ttlField.inp.value = String(msg.cacheTtlMinutes);
                if (msg.minMatchScore != null) scoreField.inp.value = String(msg.minMatchScore);
                if (msg.requestTimeoutMs != null) timeoutField.inp.value = String(msg.requestTimeoutMs);
                if (typeof msg.rejectUnauthorized === 'boolean') sslInput.checked = msg.rejectUnauthorized;
                if (Array.isArray(msg.bitrixUsers)) cachedUsersList = msg.bitrixUsers;
                if (msg.manualLinks && typeof msg.manualLinks === 'object') currentManualLinks = msg.manualLinks;

                if (activeNode && manualCurrentNote) {
                    var linkInfo = currentManualLinks[activeNode._id];
                    if (linkInfo && linkInfo.b24UserId) {
                        var userLabel = linkInfo.b24UserName
                            ? (linkInfo.b24UserName + ' (ID ' + linkInfo.b24UserId + ')')
                            : ('ID ' + linkInfo.b24UserId);
                        manualCurrentNote.textContent = 'ПК: ' + (activeNode.name || activeNode._id) + ' — привязан вручную: ' + userLabel;
                        if (unbindBtn) unbindBtn.disabled = false;
                    } else {
                        manualCurrentNote.textContent = 'ПК: ' + (activeNode.name || activeNode._id) + ' — автоподбор по имени';
                        if (unbindBtn) unbindBtn.disabled = true;
                    }
                    renderUsersSelect();
                }
                renderManualLinksList();
            }

            function setBusy(busy) {
                saveBtn.disabled = !!busy;
                refreshNowBtn.disabled = !!busy;
                testBtn.disabled = !!busy;
                if (bindBtn) bindBtn.disabled = !!busy;
                if (unbindBtn) {
                    var hasCurrentLink = Boolean(activeNode && currentManualLinks && currentManualLinks[activeNode._id]);
                    unbindBtn.disabled = !!busy || !hasCurrentLink;
                }
                for (var b = 0; b < manualDeleteButtons.length; b++) {
                    manualDeleteButtons[b].disabled = !!busy;
                }
            }

            if (linkSearchInput) {
                linkSearchInput.oninput = function () { renderUsersSelect(); };
            }
            if (linkSelect) {
                linkSelect.ondblclick = function () {
                    if (bindBtn && !bindBtn.disabled) bindBtn.click();
                };
            }
            if (bindBtn && activeNode && linkSelect) {
                bindBtn.onclick = function () {
                    var chosenId = linkSelect.value;
                    if (!chosenId) {
                        status.textContent = 'Выберите пользователя Битрикс24 из списка.';
                        return;
                    }
                    saveManualLinkChange(activeNode._id, activeNode.name, chosenId, false);
                };
            }
            if (unbindBtn && activeNode) {
                unbindBtn.onclick = function () {
                    saveManualLinkChange(activeNode._id, activeNode.name, '', true);
                };
            }

            closeBtn.onclick = function () { overlay.remove(); };
            overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
            if (opts && opts.focusLinkSearch && linkSearchInput) {
                setTimeout(function () { try { linkSearchInput.focus(); } catch (e) {} }, 30);
            }

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
                        oauthClientId: clientIdInput.value.trim(),
                        oauthClientSecret: clientSecretInput.value.trim(),
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
                        clientSecretInput.value = '';
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
                injectStyles();
                ensureAccountLink();
                ensureLeftbarTab();
                highlightUnreadDevices();
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

            var leftBar = document.getElementById('page_leftbar');
            if (leftBar && !leftBar._b24cClickBound && typeof leftBar.addEventListener === 'function') {
                leftBar._b24cClickBound = true;
                leftBar.addEventListener('click', function (e) {
                    var btn = document.getElementById(LEFTBAR_TAB_ID);
                    if (!btn) return;
                    if (e.target === btn || (btn.contains && btn.contains(e.target))) return;
                    if (chatsPageState.open) closeChatsPage();
                });
            }

            var devRoot = document.getElementById('xdevices') || document.getElementById('p1');
            if (devRoot && typeof MutationObserver === 'function' && !devRoot._b24cDevObserver) {
                var devScheduled = false;
                var devObs = new MutationObserver(function () {
                    if (devScheduled) return;
                    devScheduled = true;
                    setTimeout(function () {
                        devScheduled = false;
                        highlightUnreadDevices();
                    }, 50);
                });
                devObs.observe(devRoot, { childList: true, subtree: true });
                devRoot._b24cDevObserver = devObs;
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
            goPageStart: function () {
                closeChatsPage();
            },
            onContactsResult: function (message) {
                if (!message || typeof message !== 'object') return;
                if (message.chatAuth) {
                    overviewState.authenticated = Boolean(message.chatAuth.authenticated);
                    overviewState.auth = message.chatAuth;
                }
                var reqId = message.requestId;
                if (reqId && pendingContacts.has(reqId)) {
                    var entry = pendingContacts.get(reqId);
                    pendingContacts.delete(reqId);
                    entry.resolve(message);
                }
            },
            onSettingsResult: function (message) {
                if (!message || typeof message !== 'object') return;
                if (message.linkSaved || message.saved || message.refreshed) {
                    setTimeout(function () { refreshChatOverview(chatsPageState.open); }, 50);
                }
                var reqId = message.requestId;
                if (reqId && pendingSettings.has(reqId)) {
                    var entry = pendingSettings.get(reqId);
                    pendingSettings.delete(reqId);
                    entry.resolve(message);
                }
            },
            onChatResult: function (message) {
                if (!message || typeof message !== 'object') return;
                var reqId = message.requestId;
                if (reqId && pendingChat.has(reqId)) {
                    var entry = pendingChat.get(reqId);
                    pendingChat.delete(reqId);
                    entry.resolve(message);
                }
            },
            openSettings: openSettingsModal,
            openChats: openChatsPage,
            refreshOverview: refreshChatOverview,
            refresh: function () {
                if (window.currentNode) {
                    loadContactsForNode(window.currentNode, true);
                }
                refreshChatOverview(chatsPageState.open);
            }
        };

        window.B24ContactsPlugin.inject();
        setInterval(function () {
            if (window.B24ContactsPlugin) window.B24ContactsPlugin.inject();
        }, 1500);

        if (typeof setTimeout === 'function') {
            setTimeout(function () {
                refreshChatOverview(false);
            }, 350);
        }
        if (unreadPollTimer) clearInterval(unreadPollTimer);
        unreadPollTimer = setInterval(function () {
            if (typeof document !== 'undefined' && document.hidden) return;
            var now = Date.now();
            var interval = chatsPageState.open ? 8000 : 12000;
            if ((now - (overviewState.lastFetchedAt || 0)) >= (interval - 500)) {
                refreshChatOverview(chatsPageState.open);
            }
        }, 4000);
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && !window._b24cVisBound) {
            window._b24cVisBound = true;
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden) {
                    refreshChatOverview(chatsPageState.open);
                }
            });
        }
    };

    obj.onDeviceRefreshEnd = function () {
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.onDeviceRefreshEnd === 'function') {
            window.B24ContactsPlugin.onDeviceRefreshEnd();
        }
    };

    obj.goPageStart = function (pageNum) {
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.goPageStart === 'function') {
            window.B24ContactsPlugin.goPageStart(pageNum);
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

    obj.onChatResult = function (server, message) {
        var payload = (message && typeof message === 'object') ? message : server;
        if (window.B24ContactsPlugin && typeof window.B24ContactsPlugin.onChatResult === 'function') {
            window.B24ContactsPlugin.onChatResult(payload);
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
