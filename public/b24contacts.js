(function () {
    'use strict';

    if (window.B24ContactsPlugin) return;

    var CARD_ID = 'b24-contacts-card';
    var STYLE_ID = 'b24-contacts-style';
    var FRONTEND_CACHE_TTL_MS = 5 * 60 * 1000;
    var WS_TIMEOUT_MS = 6000;

    var pendingRequests = new Map();
    var responseCache = new Map();
    var currentLookupKey = '';
    var requestSeq = 0;

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '#' + CARD_ID + '{clear:both;margin:10px 0 12px;padding:11px 14px;border:1px solid #d5dce6;border-radius:6px;background:rgba(248,250,252,0.92);color:#1e293b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;box-sizing:border-box;max-width:680px}',
            '#' + CARD_ID + ' .b24c-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}',
            '#' + CARD_ID + ' .b24c-title{margin:0;font-size:13px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px}',
            '#' + CARD_ID + ' .b24c-refresh{background:transparent;border:1px solid #cbd5e1;border-radius:4px;color:#475569;cursor:pointer;font-size:12px;line-height:1;padding:3px 7px}',
            '#' + CARD_ID + ' .b24c-refresh:hover{background:#e2e8f0;color:#0f172a}',
            '#' + CARD_ID + ' .b24c-refresh:disabled{opacity:0.5;cursor:default}',
            '#' + CARD_ID + ' .b24c-loader-wrap{display:flex;align-items:center;gap:8px;color:#64748b;padding:2px 0}',
            '#' + CARD_ID + ' .b24c-spinner{width:14px;height:14px;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:b24c-spin 0.8s linear infinite;flex-shrink:0}',
            '#' + CARD_ID + ' .b24c-profile{font-size:12px;color:#475569;margin-bottom:6px;word-break:break-word}',
            '#' + CARD_ID + ' .b24c-phones{display:flex;flex-direction:column;gap:6px}',
            '#' + CARD_ID + ' .b24c-phone-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
            '#' + CARD_ID + ' .b24c-icon{width:15px;height:15px;flex-shrink:0;color:#2563eb}',
            '#' + CARD_ID + ' .b24c-label{color:#64748b;font-size:12px;min-width:74px}',
            '#' + CARD_ID + ' .b24c-link{color:#1d4ed8;font-weight:600;text-decoration:none}',
            '#' + CARD_ID + ' .b24c-link:hover{text-decoration:underline}',
            '#' + CARD_ID + ' .b24c-muted{color:#6b7280;font-size:12px}',
            '#' + CARD_ID + ' .b24c-error{color:#b91c1c;font-size:12px}',
            '@keyframes b24c-spin{to{transform:rotate(360deg)}}'
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
        } else {
            var path = document.createElementNS(ns, 'path');
            path.setAttribute('d', 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z');
            svg.appendChild(path);
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

            var refreshBtn = document.createElement('button');
            refreshBtn.type = 'button';
            refreshBtn.className = 'b24c-refresh';
            refreshBtn.title = 'Обновить контакты';
            refreshBtn.textContent = '↻';
            refreshBtn.onclick = function () {
                if (window.currentNode) {
                    loadContactsForNode(window.currentNode, true);
                }
            };

            header.appendChild(title);
            header.appendChild(refreshBtn);

            var body = document.createElement('div');
            body.className = 'b24c-body';

            card.appendChild(header);
            card.appendChild(body);
            container.appendChild(card);
        }

        if (node) {
            card.dataset.nodeId = node._id || '';
            card.dataset.nodeName = node.name || '';
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

    function renderResult(node, data) {
        var card = ensureCardElement(node);
        if (!card) return;
        setRefreshBusy(card, false);

        var body = card.querySelector('.b24c-body');
        body.replaceChildren();

        if (!data || data.ok === false) {
            var errEl = document.createElement('div');
            errEl.className = 'b24c-error';
            errEl.textContent = (data && data.error) ? data.error : 'Не удалось загрузить контакты Битрикс24';
            body.appendChild(errEl);
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
            return;
        }

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

    function requestViaHttp(nodeName) {
        if (typeof fetch !== 'function') {
            return Promise.reject(new Error('HTTP-запрос недоступен в этом браузере'));
        }
        var url = 'plugin/b24contacts/api/contacts?nodeName=' + encodeURIComponent(nodeName);
        return fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        }).then(function (res) {
            return res.json().then(function (json) {
                if (!res.ok && (!json || !json.error)) {
                    throw new Error('HTTP ' + res.status);
                }
                return json;
            });
        });
    }

    function requestViaWebSocket(node, requestId) {
        return new Promise(function (resolve, reject) {
            if (typeof meshserver === 'undefined' || !meshserver || typeof meshserver.send !== 'function') {
                return reject(new Error('WebSocket MeshCentral недоступен'));
            }

            var timer = setTimeout(function () {
                pendingRequests.delete(requestId);
                reject(new Error('Таймаут ответа WebSocket плагина'));
            }, WS_TIMEOUT_MS);

            pendingRequests.set(requestId, {
                resolve: function (msg) {
                    clearTimeout(timer);
                    resolve(msg);
                },
                reject: function (err) {
                    clearTimeout(timer);
                    reject(err);
                }
            });

            try {
                meshserver.send({
                    action: 'plugin',
                    plugin: 'b24contacts',
                    pluginaction: 'getContacts',
                    requestId: requestId,
                    nodeId: node._id || '',
                    nodeName: node.name || ''
                });
            } catch (err) {
                clearTimeout(timer);
                pendingRequests.delete(requestId);
                reject(err);
            }
        });
    }

    async function fetchContacts(node) {
        var requestId = 'b24c_' + Date.now() + '_' + (++requestSeq);
        try {
            return await requestViaWebSocket(node, requestId);
        } catch (wsErr) {
            return await requestViaHttp(node.name || '');
        }
    }

    function loadContactsForNode(node, forceRefresh) {
        if (!node || !node._id) return;
        if (!isSummaryVisible()) return;
        if (!getTargetContainer()) return;

        var nodeName = typeof node.name === 'string' ? node.name : '';
        var key = node._id + '|' + nodeName;
        var existingCard = document.getElementById(CARD_ID);

        if (!forceRefresh && existingCard && existingCard.dataset.nodeId === (node._id || '') && existingCard.dataset.nodeName === nodeName) {
            return;
        }

        if (!forceRefresh && responseCache.has(key)) {
            var cached = responseCache.get(key);
            if ((Date.now() - cached.ts) < FRONTEND_CACHE_TTL_MS) {
                currentLookupKey = key;
                renderResult(node, cached.data);
                return;
            }
            responseCache.delete(key);
        }

        currentLookupKey = key;
        renderLoading(node);

        fetchContacts(node)
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

    function handleRefresh() {
        try {
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
                    if (!card || card.dataset.nodeId !== (window.currentNode._id || '') || card.dataset.nodeName !== activeName) {
                        handleRefresh();
                    }
                }, 80);
            });
            observer.observe(p10, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
            p10._b24ContactsObserver = observer;
        }
    }

    window.B24ContactsPlugin = {
        onDeviceRefreshEnd: function () {
            setupObservers();
            handleRefresh();
        },
        onContactsResult: function (message) {
            if (!message || typeof message !== 'object') return;
            var reqId = message.requestId;
            if (reqId && pendingRequests.has(reqId)) {
                var entry = pendingRequests.get(reqId);
                pendingRequests.delete(reqId);
                entry.resolve(message);
            }
        },
        refresh: function () {
            if (window.currentNode) {
                loadContactsForNode(window.currentNode, true);
            }
        }
    };

    setupObservers();
    handleRefresh();
})();
