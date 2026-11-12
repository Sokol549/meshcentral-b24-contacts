'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const pluginFactory = require('../b24contacts');
const manifest = require('../config.json');

function createMockParent(config, datapath, extra) {
    const server = Object.assign({
        config: config || { settings: { plugins: { enabled: true, b24contacts: {} } } },
        datapath: datapath || '',
        users: {},
        webserver: { users: {} }
    }, extra || {});
    return {
        parent: server,
        meshServer: server,
        registeredPermissions: null,
        registerPermissions: function (name, defs) {
            this.registeredPermissions = { name: name, defs: defs };
        },
        checkPluginPermission: function () { return true; }
    };
}

function makeDomShim() {
    function makeElement(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            id: '',
            className: '',
            textContent: '',
            href: '',
            title: '',
            type: '',
            name: '',
            value: '',
            checked: false,
            disabled: false,
            style: {},
            dataset: {},
            scrollTop: 0,
            clientHeight: 200,
            get scrollHeight() { return this.children.length * 60; },
            children: [],
            parentNode: null,
            attributes: {},
            setAttribute: function (k, v) {
                this.attributes[k] = String(v);
                if (k === 'id') this.id = String(v);
                if (k === 'class') this.className = String(v);
            },
            getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
            addEventListener: function () {},
            get parentElement() { return this.parentNode; },
            get firstChild() { return this.children[0] || null; },
            get nextSibling() {
                if (!this.parentNode) return null;
                const idx = this.parentNode.children.indexOf(this);
                return idx >= 0 ? (this.parentNode.children[idx + 1] || null) : null;
            },
            contains: function (target) {
                if (!target) return false;
                if (target === this) return true;
                for (const ch of this.children) {
                    if (ch.contains && ch.contains(target)) return true;
                }
                return false;
            },
            classList: {
                add: function (...names) {
                    const set = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
                    for (const n of names) if (n) set.add(n);
                    el.className = Array.from(set).join(' ');
                },
                remove: function (...names) {
                    const drop = new Set(names);
                    el.className = String(el.className || '').split(/\s+/).filter((c) => c && !drop.has(c)).join(' ');
                },
                contains: function (name) {
                    return String(el.className || '').split(/\s+/).includes(name);
                },
                toggle: function (name, force) {
                    const has = this.contains(name);
                    const next = force !== undefined ? Boolean(force) : !has;
                    if (next) this.add(name);
                    else this.remove(name);
                    return next;
                }
            },
            appendChild: function (child) {
                child.parentNode = this;
                this.children.push(child);
                return child;
            },
            insertBefore: function (child, refNode) {
                if (child.parentNode) child.remove();
                child.parentNode = this;
                if (!refNode) {
                    this.children.push(child);
                    return child;
                }
                const idx = this.children.indexOf(refNode);
                if (idx === -1) this.children.push(child);
                else this.children.splice(idx, 0, child);
                return child;
            },
            replaceChildren: function () {
                this.children = [];
            },
            removeChild: function (child) {
                this.children = this.children.filter((c) => c !== child);
                if (child && child.parentNode === this) child.parentNode = null;
                return child;
            },
            remove: function () {
                if (this.parentNode) {
                    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
                    this.parentNode = null;
                }
            },
            querySelectorAll: function (sel) {
                if (sel === '#p2AccountActions > p.mL') {
                    const p2a = findById(this, 'p2AccountActions');
                    if (p2a) {
                        const hit = p2a.children.find((c) => c.tagName === 'P' && c.className === 'mL');
                        return hit ? [hit] : [];
                    }
                    return [];
                }
                const matchesPart = (node, part) => {
                    part = part.trim();
                    if (!part) return false;
                    if (part.includes(' ')) {
                        const tokens = part.split(/\s+/).filter(Boolean);
                        if (tokens.length === 2 && tokens[0].startsWith('#')) {
                            const anc = findById(this, tokens[0].slice(1));
                            if (!anc || !anc.contains(node) || anc === node) return false;
                            part = tokens[1];
                        }
                    }
                    if (part.startsWith('#')) return node.id === part.slice(1);
                    if (part.startsWith('.')) return node.className.split(/\s+/).includes(part.slice(1));
                    if (part === '[value^="devid_"]') return typeof node.value === 'string' && node.value.startsWith('devid_');
                    if (part === '[id^="devid_"]') return typeof node.id === 'string' && node.id.startsWith('devid_');
                    if (part.startsWith('[class*="Icon"]')) return node.className.includes('Icon');
                    if (part.startsWith('[class*="icon"]')) return node.className.includes('icon') && !node.className.split(/\s+/).includes('b24c-icon');
                    if (!part.startsWith('[') && !part.includes(':')) return node.tagName.toLowerCase() === part.toLowerCase();
                    return false;
                };
                const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
                const out = [];
                const stack = [...this.children];
                while (stack.length) {
                    const node = stack.shift();
                    if (parts.some((p) => matchesPart(node, p))) out.push(node);
                    stack.push(...node.children);
                }
                return out;
            },
            querySelector: function (sel) {
                return this.querySelectorAll(sel)[0] || null;
            }
        };
        return el;
    }

    function findById(root, id) {
        if (!root) return null;
        if (root.id === id) return root;
        for (const ch of root.children || []) {
            const hit = findById(ch, id);
            if (hit) return hit;
        }
        return null;
    }

    const head = makeElement('head');
    const body = makeElement('body');
    const p10 = makeElement('div');
    p10.id = 'p10';
    p10.style.display = '';
    const p10info = makeElement('div');
    p10info.id = 'p10info';
    const zabbixBtn = makeElement('button');
    zabbixBtn.id = 'zabbix-open';
    const summaryTable = makeElement('table');
    const powerChart = makeElement('div');
    powerChart.id = 'p10html2';
    p10info.appendChild(zabbixBtn);
    p10info.appendChild(summaryTable);
    p10info.appendChild(powerChart);
    p10.appendChild(p10info);

    const p2AccountActions = makeElement('div');
    p2AccountActions.id = 'p2AccountActions';
    const p2List = makeElement('p');
    p2List.className = 'mL';
    p2AccountActions.appendChild(p2List);

    body.appendChild(p10);
    body.appendChild(p2AccountActions);

    return { head, body, p10, p10info, p2AccountActions, p2List, makeElement, findById };
}

function testManifest() {
    assert.equal(manifest.shortName, 'b24contacts');
    assert.match(manifest.shortName, /^[a-zA-Z0-9]+$/);
    const plugin = pluginFactory(createMockParent());
    assert.equal(
        plugin._internal.buildUserGetUrl('https://bitrix.kzvs.org/rest/23828/tok123/profile.json'),
        'https://bitrix.kzvs.org/rest/23828/tok123/user.get.json'
    );
    assert.equal(
        plugin._internal.buildUserGetUrl('https://bitrix.kzvs.org/rest/23828/tok123/'),
        'https://bitrix.kzvs.org/rest/23828/tok123/user.get.json'
    );
    assert.equal(typeof manifest.name, 'string');
    assert.equal(typeof manifest.version, 'string');
    assert.equal(typeof manifest.description, 'string');
    assert.equal(typeof manifest.hasAdminPanel, 'boolean');
    assert.equal(typeof manifest.homepage, 'string');
    assert.equal(typeof manifest.changelogUrl, 'string');
    assert.equal(typeof manifest.configUrl, 'string');
    assert.equal(typeof manifest.downloadUrl, 'string');
    assert.equal(typeof manifest.meshCentralCompat, 'string');
    assert.equal(manifest.repository.type, 'git');
    assert.equal(typeof manifest.repository.url, 'string');
}

function testPrepExportsCompatibility() {
    const plugin = pluginFactory(createMockParent());
    assert.ok(Array.isArray(plugin.exports));
    assert.ok(plugin.exports.includes('openSettings'));
    assert.ok(plugin.exports.includes('onSettingsResult'));

    let code = 'var obj = {};\n';
    code += 'obj.' + manifest.shortName + ' = {};\n';
    for (const fnName of plugin.exports) {
        assert.equal(typeof plugin[fnName], 'function');
        code += 'obj.' + manifest.shortName + '.' + fnName + ' = ' + plugin[fnName].toString() + ';\n';
    }
    code += 'return obj;';

    const compiled = new Function(code);
    const dom = makeDomShim();
    const sentMessages = [];
    const windowObj = {
        userinfo: { _id: 'user//admin', siteadmin: -1 },
        currentNode: null
    };
    const sandbox = {
        document: {
            head: dom.head,
            body: dom.body,
            createElement: dom.makeElement,
            createElementNS: (_ns, tag) => dom.makeElement(tag),
            getElementById: (id) => dom.findById(dom.head, id) || dom.findById(dom.body, id),
            querySelector: (sel) => dom.body.querySelector(sel)
        },
        window: windowObj,
        meshserver: { send: (m) => sentMessages.push(m) },
        setTimeout,
        clearTimeout,
        setInterval: () => ({ unref: () => {} }),
        clearInterval: () => {},
        Map
    };
    sandbox.window.document = sandbox.document;
    sandbox.window.meshserver = sandbox.meshserver;

    const exported = vm.runInNewContext('(' + compiled.toString() + ')()', sandbox);
    exported.b24contacts.onWebUIStartupEnd();

    // Verify account settings link was injected into #p2AccountActions > p.mL
    const settingsLinkWrap = dom.findById(dom.p2AccountActions, 'plugin_b24contactsSettings');
    assert.ok(settingsLinkWrap, 'Settings link should be injected under My Account -> Account Actions');
    assert.equal(settingsLinkWrap.children[0].textContent, 'Настройка Битрикс24 (Контакты)');

    // Verify opening settings modal works via exported openSettings()
    exported.b24contacts.openSettings();
    const modal = dom.findById(dom.body, 'b24c-settings-overlay');
    assert.ok(modal, 'Settings modal should open');
    assert.equal(sentMessages[0].pluginaction, 'getSettings');
}

function testMatchingLogic() {
    const plugin = pluginFactory(createMockParent());
    const { normalizeAndTokenize, normalizeBitrixUser, findBestContactMatch } = plugin._internal;

    assert.deepEqual(
        normalizeAndTokenize('ст.Калининская ул.Советская, д.38 - касса ИБ'),
        ['калининская', 'советская', '38']
    );
    assert.deepEqual(
        normalizeAndTokenize('ВА | Калининская, ул. Советская 38 - ЮБ'),
        ['калининская', 'советская', '38']
    );

    const b24Users = [
        normalizeBitrixUser({
            ID: '101',
            ACTIVE: true,
            NAME: 'ВА | Калининская, ул. Советская 38 - ЮБ',
            LAST_NAME: '',
            SECOND_NAME: '',
            WORK_PHONE: '+7 (86163) 21-0-00',
            PERSONAL_MOBILE: '+7 918 111-22-33'
        }),
        normalizeBitrixUser({
            ID: '102',
            ACTIVE: true,
            LAST_NAME: 'ЮБ | Краснодар',
            NAME: 'ул. Красная 176А',
            SECOND_NAME: '',
            WORK_PHONE: '8-861-222-33-44',
            PERSONAL_MOBILE: ''
        }),
        normalizeBitrixUser({
            ID: '103',
            ACTIVE: true,
            NAME: 'ВА | пгт. Афипский, ул. Берёзовая 5 - ИБ',
            WORK_PHONE: '',
            PERSONAL_MOBILE: '',
            PERSONAL_PHONE: '+79185556677',
            UF_PHONE_INNER: '105'
        })
    ];

    const m1 = findBestContactMatch('ст.Калининская ул.Советская, д.38 - касса ИБ', b24Users, 0.55);
    assert.equal(m1.matched, true);
    assert.equal(m1.profile.id, '101');
    assert.equal(m1.profile.phones.length, 2);
    assert.equal(m1.profile.phones[0].href, 'tel:+78616321000');
    assert.equal(m1.profile.phones[1].href, 'tel:+79181112233');

    const m2 = findBestContactMatch('г.Краснодар ул.Красная, д.176А - касса 2', b24Users, 0.55);
    assert.equal(m2.matched, true);
    assert.equal(m2.profile.id, '102');
    assert.equal(m2.profile.phones[0].href, 'tel:88612223344');

    const m3 = findBestContactMatch('п.Афипский ул.Березовая, д.5 - рмк 1', b24Users, 0.55);
    assert.equal(m3.matched, true);
    assert.equal(m3.profile.id, '103');
    assert.equal(m3.profile.phones.length, 2);
    assert.equal(m3.profile.phones[0].href, 'tel:+79185556677');
    assert.equal(m3.profile.phones[1].href, 'tel:105');

    assert.equal(findBestContactMatch('ст.Калининская ул.Советская, д.99 - касса ИБ', b24Users, 0.55).matched, false);
    assert.equal(findBestContactMatch('г.Краснодар ул.Северная, д.500 - касса', b24Users, 0.55).matched, false);
    assert.equal(findBestContactMatch('SERVER-DC01', b24Users, 0.55).matched, false);

    const extraUsers = [
        normalizeBitrixUser({ ID: '201', NAME: 'ВА | Славянск-на-Кубани, Красная 12/1 - ЮБ', WORK_PHONE: '+7 86146 4-12-34' }),
        normalizeBitrixUser({ ID: '202', NAME: 'ЮБ | хутор Коржи, ул. Мира 5а', PERSONAL_MOBILE: '+7 918 222-11-00' }),
        normalizeBitrixUser({ ID: '203', NAME: 'ВА | Новотитаровская, Ленина 102 к.2 - ЮБ', WORK_PHONE: '1022' }),
        normalizeBitrixUser({ ID: '204', NAME: 'ВА | Абинск, пр-т Комсомольский 78', WORK_PHONE: '+7 (86150) 5-10-20' })
    ];

    assert.equal(findBestContactMatch('г.Славянск-на-Кубани,ул.Красная,д.12/1 - касса 1 ИБ', extraUsers, 0.55).profile.id, '201');
    assert.equal(findBestContactMatch('х.Коржи ул.Мира, д.5А - касса', extraUsers, 0.55).profile.id, '202');
    assert.equal(findBestContactMatch('ст.Новотитаровская ул.Ленина, д.102, корп.2', extraUsers, 0.55).profile.id, '203');
    assert.equal(findBestContactMatch('г.Абинск, просп.Комсомольский, д.78', extraUsers, 0.55).profile.id, '204');
}

function testRealMeshCentralPluginHandler() {
    const pluginHandlerPath = path.join(__dirname, '..', '..', 'pluginHandler.temp.js');
    if (!fs.existsSync(pluginHandlerPath)) return;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-test-'));
    const pluginsDir = path.join(tmpRoot, 'plugins', 'b24contacts');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.copyFileSync(pluginHandlerPath, path.join(tmpRoot, 'pluginHandler.js'));
    fs.writeFileSync(path.join(tmpRoot, 'common.js'), 'module.exports = { isAlphaNumeric: (v) => /^[a-z0-9]+$/i.test(String(v || "")) };');
    fs.copyFileSync(path.join(__dirname, '..', 'b24contacts.js'), path.join(pluginsDir, 'b24contacts.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'config.json'), path.join(pluginsDir, 'config.json'));

    fs.writeFileSync(path.join(tmpRoot, 'config.json'), JSON.stringify({
        settings: {
            plugins: {
                enabled: true,
                list: ['b24contacts'],
                b24contacts: {
                    webhookUrl: 'https://example.bitrix24.ru/rest/1/disk_token_123/'
                }
            }
        }
    }));

    try {
        const { pluginHandler } = require(path.join(tmpRoot, 'pluginHandler.js'));
        const mockServer = {
            path: path,
            datapath: tmpRoot,
            config: {
                settings: {
                    plugins: {
                        enabled: true,
                        list: ['b24contacts']
                    }
                }
            },
            db: {
                getPluginPermissions: (_name, cb) => cb(null, [])
            }
        };

        const ph = pluginHandler(mockServer);
        assert.ok(ph.plugins.b24contacts, 'Plugin should load via MeshCentral pluginHandler loadList');
        const loadedCfg = ph.plugins.b24contacts._internal.loadSettings(mockServer);
        assert.equal(loadedCfg.webhookUrl, 'https://example.bitrix24.ru/rest/1/disk_token_123/');

        const builderSrc = ph.prepExports();
        const builderFn = new Function('return ' + builderSrc);
        const clientHandler = builderFn()();
        assert.equal(typeof clientHandler.b24contacts.onWebUIStartupEnd, 'function');
        assert.equal(typeof clientHandler.b24contacts.onDeviceRefreshEnd, 'function');
        assert.equal(typeof clientHandler.b24contacts.onContactsResult, 'function');
        assert.equal(typeof clientHandler.b24contacts.onSettingsResult, 'function');
        assert.equal(typeof clientHandler.b24contacts.openSettings, 'function');
        assert.equal(typeof clientHandler.b24contacts.goPageStart, 'function');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

async function testBitrixPaginationSettingsAndResilience() {
    let failMode = false;
    const receivedBodies = [];

    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || !req.url.endsWith('/rest/1/secret_token_xyz/user.get.json')) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'NOT_FOUND' }));
            return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            if (failMode) {
                res.statusCode = 503;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' }));
                return;
            }
            const parsed = JSON.parse(body || '{}');
            receivedBodies.push(parsed);
            res.setHeader('Content-Type', 'application/json');
            if ((parsed.start || 0) === 0) {
                res.end(JSON.stringify({
                    result: [
                        { ID: '1', ACTIVE: true, NAME: 'ВА | Калининская, ул. Советская 38 - ЮБ', WORK_PHONE: '+7 (86163) 21-1-11', PERSONAL_MOBILE: '' },
                        { ID: '2', ACTIVE: true, NAME: 'ВА | Тимашевск, ул. Ленина 12 - ЮБ', WORK_PHONE: '', PERSONAL_MOBILE: '+7 918 000-00-02' }
                    ],
                    total: 3,
                    next: 2
                }));
            } else {
                res.end(JSON.stringify({
                    result: [
                        { ID: '3', ACTIVE: true, NAME: 'ВА | Динская, ул. Красная 44 - ЮБ', WORK_PHONE: '+7 86162 55-55-5', PERSONAL_MOBILE: '+7 918 333-44-55' }
                    ],
                    total: 3
                }));
            }
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const tmpDatapath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-cfg-'));

    try {
        const webhookUrl = 'http://127.0.0.1:' + port + '/rest/1/secret_token_xyz/';
        const mockParent = createMockParent({
            settings: { plugins: { enabled: true } }
        }, tmpDatapath);

        const plugin = pluginFactory(mockParent);

        // Before settings saved: needsConfig should be true
        const unconfiguredReply = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'req-0', nodeId: 'node//1', nodeName: 'ст.Калининская ул.Советская, д.38' },
                { user: { _id: 'user//u1', siteadmin: 0 }, send: resolve }
            );
        });
        assert.equal(unconfiguredReply.ok, false);
        assert.equal(unconfiguredReply.needsConfig, true);

        // Non-admin cannot save settings
        const deniedSave = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'saveSettings', requestId: 'req-deny', settings: { webhookUrl } },
                { user: { _id: 'user//u1', siteadmin: 0 }, send: resolve }
            );
        });
        assert.equal(deniedSave.ok, false);

        // Admin saves settings via UI action -> persists to disk and populates Bitrix24 cache immediately
        const saveReply = await new Promise((resolve) => {
            plugin.serveraction(
                {
                    pluginaction: 'saveSettings',
                    requestId: 'req-save',
                    settings: { webhookUrl, cacheTtlMinutes: 60, minMatchScore: 0.55 }
                },
                { user: { _id: 'user//admin', siteadmin: -1 }, send: resolve }
            );
        });
        assert.equal(saveReply.saved, true);
        assert.equal(saveReply.ok, true);
        assert.equal(saveReply.cacheSize, 3);
        assert.equal(saveReply.hasWebhook, true);
        assert.ok(!saveReply.maskedWebhookUrl.includes('secret_token_xyz'));
        assert.ok(fs.existsSync(path.join(tmpDatapath, 'b24contacts-settings.json')));
        assert.equal(receivedBodies.length, 2);

        // Admin testMatch action
        const testReply = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'testMatch', requestId: 'req-test', nodeName: 'ст.Динская ул.Красная, д.44 - касса ИБ' },
                { user: { _id: 'user//admin', siteadmin: -1 }, send: resolve }
            );
        });
        assert.equal(testReply.testResult.matched, true);
        assert.equal(testReply.testResult.profile.id, '3');

        // Normal user getContacts works now
        const wsReply = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'req-1', nodeId: 'node//1', nodeName: 'ст.Динская ул.Красная, д.44 - касса ИБ' },
                { user: { _id: 'user//u1', siteadmin: 0 }, send: resolve }
            );
        });
        assert.equal(wsReply.matched, true);
        assert.equal(wsReply.phones.length, 2);
        assert.equal(wsReply.profile.profileUrl, 'http://127.0.0.1:' + port + '/company/personal/user/3/');
        assert.equal(wsReply.profile.chatUrl, 'http://127.0.0.1:' + port + '/online/?IM_DIALOG=3');
        assert.ok(!wsReply.profile.profileUrl.includes('secret_token_xyz'));

        // Simulate Bitrix24 API failure: stale cache preserved
        failMode = true;
        const okAfterFail = await plugin._internal.refreshCache('test-fail');
        assert.equal(okAfterFail, false);
        assert.equal(plugin._internal.getCacheState().users.length, 3);

        plugin.server_shutdown();
    } finally {
        fs.rmSync(tmpDatapath, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
}

async function testFrontendInlineUi() {
    const plugin = pluginFactory(createMockParent());
    const dom = makeDomShim();
    const sentMessages = [];
    const windowObj = {
        userinfo: { _id: 'user//admin', siteadmin: -1 },
        currentNode: { _id: 'node//1', name: 'ст.Калининская ул.Советская, д.38 - касса ИБ' }
    };

    const sandbox = {
        window: windowObj,
        document: {
            head: dom.head,
            body: dom.body,
            createElement: dom.makeElement,
            createElementNS: (_ns, tag) => dom.makeElement(tag),
            getElementById: (id) => dom.findById(dom.head, id) || dom.findById(dom.body, id),
            querySelector: (sel) => dom.body.querySelector(sel)
        },
        meshserver: { send: (msg) => sentMessages.push(msg) },
        setTimeout,
        clearTimeout,
        setInterval: () => ({ unref: () => {} }),
        clearInterval: () => {},
        Map
    };
    sandbox.window.document = sandbox.document;
    sandbox.window.meshserver = sandbox.meshserver;

    vm.runInNewContext('(' + plugin.onWebUIStartupEnd.toString() + ')()', sandbox);

    const card = dom.findById(dom.p10, 'b24-contacts-card');
    assert.ok(card, 'Card should be mounted in #p10info');
    assert.equal(dom.p10info.children[0].id, 'zabbix-open');
    assert.equal(dom.p10info.children[1].id, 'b24-contacts-card', 'Card should appear right before Summary table, not at bottom');
    assert.equal(dom.p10info.children[2].tagName, 'TABLE');
    assert.ok(card.querySelector('.b24c-spinner'), 'Spinner should render while loading');
    assert.ok(card.querySelector('.b24c-cfg-btn'), 'Admin settings gear button should render in card');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].pluginaction, 'getContacts');

    // Deliver matched reply with XSS payload + authenticated chatAuth
    sandbox.window.B24ContactsPlugin.onContactsResult({
        requestId: sentMessages[0].requestId,
        ok: true,
        matched: true,
        chatAuth: {
            authenticated: true,
            mode: 'oauth',
            b24UserId: '77',
            b24UserName: 'Иван Соколов',
            oauthConfigured: true
        },
        profile: {
            id: '101',
            displayName: '<img src=x onerror=alert(1)> ВА | Калининская, ул. Советская 38 - ЮБ',
            chatUrl: 'https://bitrix.kzvs.org/online/?IM_DIALOG=101',
            profileUrl: 'https://bitrix.kzvs.org/company/personal/user/101/'
        },
        phones: [
            { type: 'work', label: 'Рабочий', display: '+7 (86163) 21-0-00', href: 'tel:+78616321000' },
            { type: 'mobile', label: 'Мобильный', display: '+7 918 111-22-33', href: 'tel:+79181112233' }
        ]
    });

    await new Promise((r) => setTimeout(r, 10));
    const prof = card.querySelector('.b24c-profile');
    assert.ok(prof);
    assert.equal(prof.children.length, 0);
    assert.ok(prof.textContent.includes('<img src=x onerror=alert(1)>'));

    // Verify mini-chat column was mounted and requested getChatMessages
    const chatBox = card.querySelector('.b24c-chat-box');
    assert.ok(chatBox, 'Mini-chat box should render next to phones');
    const chatReq = sentMessages.find((m) => m.pluginaction === 'getChatMessages');
    assert.ok(chatReq, 'Authenticated user should immediately fetch last 4 messages');
    assert.equal(chatReq.dialogId, '101');
    assert.equal(chatReq.limit, 4);

    sandbox.window.B24ContactsPlugin.onChatResult({
        requestId: chatReq.requestId,
        ok: true,
        dialogId: '101',
        messages: [
            { id: 1, authorId: '101', authorName: 'Аптека', isMine: false, date: '2026-11-12T08:00:00Z', text: 'Касса не печатает' },
            { id: 2, authorId: '77', authorName: 'Иван Соколов', isMine: true, date: '2026-11-12T08:05:00Z', text: 'Подключаюсь' }
        ]
    });
    await new Promise((r) => setTimeout(r, 10));
    const renderedMsgs = [];
    const mStack = [...chatBox.children];
    while (mStack.length) {
        const n = mStack.shift();
        if (n.className && n.className.split(/\s+/).includes('b24c-chat-msg')) renderedMsgs.push(n);
        mStack.push(...n.children);
    }
    assert.equal(renderedMsgs.length, 2);
    assert.ok(renderedMsgs[1].className.includes('mine'));

    const links = [];
    const stack = [...card.children];
    while (stack.length) {
        const n = stack.shift();
        if (n.tagName === 'A') links.push(n);
        stack.push(...n.children);
    }
    const hrefs = links.map((l) => l.href);
    assert.equal(hrefs.length, 4);
    assert.ok(hrefs.includes('tel:+78616321000'));
    assert.ok(hrefs.includes('tel:+79181112233'));
    assert.ok(hrefs.includes('https://bitrix.kzvs.org/online/?IM_DIALOG=101'));
    assert.ok(hrefs.includes('https://bitrix.kzvs.org/company/personal/user/101/'));

    // Switch to needsConfig response -> shows setup button for admin
    windowObj.currentNode = { _id: 'node//2', name: 'ПК 2' };
    sandbox.window.B24ContactsPlugin.onDeviceRefreshEnd();
    const getContacts2 = sentMessages.filter((m) => m.pluginaction === 'getContacts')[1];
    sandbox.window.B24ContactsPlugin.onContactsResult({
        requestId: getContacts2.requestId,
        ok: false,
        needsConfig: true,
        matched: false,
        error: 'Вебхук Битрикс24 не настроен'
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(card.querySelector('.b24c-inline-btn'), 'Inline configure button should appear when needsConfig is true');

    // Switch to unmatched device
    windowObj.currentNode = { _id: 'node//3', name: 'Неизвестный ПК' };
    sandbox.window.B24ContactsPlugin.onDeviceRefreshEnd();
    const getContacts3 = sentMessages.filter((m) => m.pluginaction === 'getContacts')[2];
    sandbox.window.B24ContactsPlugin.onContactsResult({
        requestId: getContacts3.requestId,
        ok: true,
        matched: false,
        profile: null,
        phones: []
    });
    await new Promise((r) => setTimeout(r, 10));
    const muted = card.querySelector('.b24c-muted');
    assert.ok(muted);
    assert.equal(muted.textContent, 'Связанный профиль в Битрикс24 не найден');
    const manualBtn = card.querySelector('.b24c-inline-btn');
    assert.ok(manualBtn, 'Manual link button should appear when unmatched for admin');
    assert.equal(manualBtn.textContent, 'Привязать вручную');

    // Manual-linked device shows badge
    windowObj.currentNode = { _id: 'node//4', name: 'Совсем другое имя ПК' };
    sandbox.window.B24ContactsPlugin.onDeviceRefreshEnd();
    const getContacts4 = sentMessages.filter((m) => m.pluginaction === 'getContacts')[3];
    sandbox.window.B24ContactsPlugin.onContactsResult({
        requestId: getContacts4.requestId,
        ok: true,
        matched: true,
        manualLinked: true,
        profile: { id: '202', displayName: 'Аптека №15 - Manual' },
        phones: [{ type: 'work', label: 'Рабочий', display: '89990001122', href: 'tel:+79990001122' }],
        chatAuth: { authenticated: false, oauthConfigured: false }
    });
    await new Promise((r) => setTimeout(r, 10));
    const badge = card.querySelector('.b24c-badge');
    assert.ok(badge, 'Manual link badge should be rendered');
    assert.equal(badge.textContent, 'ручная привязка');
}

async function testPerUserOAuthAndMiniChat() {
    const messagesDb = [
        { id: 10, author_id: 3, date: '2026-11-12T08:00:00+03:00', text: '[B]Доброе утро[/B]' },
        { id: 11, author_id: 77, date: '2026-11-12T08:01:00+03:00', text: 'Проверяю кассу' }
    ];
    let currentAccessToken = 'tok_v1';

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token/') {
                const form = new URLSearchParams(raw);
                assert.equal(form.get('client_id'), 'local.app.1');
                assert.equal(form.get('client_secret'), 'sec_123');
                if (form.get('grant_type') === 'authorization_code') {
                    assert.equal(form.get('code'), 'auth_code_1');
                    res.end(JSON.stringify({ access_token: 'tok_v1', refresh_token: 'ref_1', expires_in: 3600 }));
                } else {
                    assert.equal(form.get('refresh_token'), 'ref_1');
                    currentAccessToken = 'tok_v2';
                    res.end(JSON.stringify({ access_token: 'tok_v2', refresh_token: 'ref_2', expires_in: 3600 }));
                }
                return;
            }
            const parsed = JSON.parse(raw || '{}');
            if (req.url === '/rest/user.current.json') {
                assert.equal(parsed.auth, currentAccessToken);
                res.end(JSON.stringify({ result: { ID: '77', NAME: 'Иван', LAST_NAME: 'Соколов' } }));
                return;
            }
            if (req.url === '/rest/im.dialog.messages.get.json') {
                if (parsed.auth === 'tok_expired') {
                    res.statusCode = 401;
                    res.end(JSON.stringify({ error: 'expired_token', error_description: 'Token expired' }));
                    return;
                }
                assert.equal(parsed.auth, currentAccessToken);
                assert.equal(parsed.DIALOG_ID, '3');
                res.end(JSON.stringify({
                    result: {
                        messages: messagesDb.slice(-4).reverse(),
                        users: [{ id: 3, name: 'Аптека Динская' }, { id: 77, name: 'Иван Соколов' }]
                    }
                }));
                return;
            }
            if (req.url === '/rest/im.message.add.json') {
                if (parsed.auth === 'tok_expired') {
                    res.statusCode = 401;
                    res.end(JSON.stringify({ error: 'expired_token', error_description: 'Token expired' }));
                    return;
                }
                assert.equal(parsed.auth, currentAccessToken);
                assert.equal(parsed.DIALOG_ID, '3');
                messagesDb.push({ id: messagesDb.length + 20, author_id: 77, date: '2026-11-12T08:02:00+03:00', text: parsed.MESSAGE });
                res.end(JSON.stringify({ result: 999 }));
                return;
            }
            if (req.url === '/rest/im.dialog.read.json') {
                res.end(JSON.stringify({ result: true }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'UNKNOWN' }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const tmpDatapath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-chat-'));

    try {
        const base = 'http://127.0.0.1:' + port;
        const plugin = pluginFactory(createMockParent({
            settings: {
                plugins: {
                    enabled: true,
                    b24contacts: {
                        portalUrl: base,
                        oauthClientId: 'local.app.1',
                        oauthClientSecret: 'sec_123'
                    }
                }
            }
        }, tmpDatapath));

        const u1 = { user: { _id: 'user//u1', siteadmin: 0 }, send: () => {} };
        const u2 = { user: { _id: 'user//u2', siteadmin: 0 }, send: () => {} };

        // User 1 starts OAuth
        const startRes = await new Promise((resolve) => {
            plugin.serveraction({ pluginaction: 'startOAuth', requestId: 'c1', origin: 'https://mc.kzvs.pro' }, { user: u1.user, send: resolve });
        });
        assert.equal(startRes.ok, true);
        const authUrl = new URL(startRes.authorizeUrl);
        assert.equal(authUrl.pathname, '/oauth/authorize/');
        const state = authUrl.searchParams.get('state');

        // OAuth callback saves encrypted token only for u1
        const cb = await plugin._internal.completeOAuthCallback('auth_code_1', state);
        assert.equal(cb.userId, 'user//u1');
        assert.equal(cb.auth.authenticated, true);
        assert.equal(cb.auth.b24UserName, 'Иван Соколов');

        // User 2 MUST remain unauthenticated
        const u2Auth = await new Promise((resolve) => {
            plugin.serveraction({ pluginaction: 'getChatAuth', requestId: 'c2' }, { user: u2.user, send: resolve });
        });
        assert.equal(u2Auth.auth.authenticated, false);

        // User 1 fetches messages (strips BB-code, sorted chronologically)
        const msgs1 = await new Promise((resolve) => {
            plugin.serveraction({ pluginaction: 'getChatMessages', requestId: 'c3', dialogId: '3', limit: 4 }, { user: u1.user, send: resolve });
        });
        assert.equal(msgs1.ok, true);
        assert.equal(msgs1.messages.length, 2);
        assert.equal(msgs1.messages[0].text, 'Доброе утро');
        assert.equal(msgs1.messages[0].isMine, false);
        assert.equal(msgs1.messages[1].isMine, true);

        // Simulate expired accessToken -> plugin refreshes token automatically using refresh_token
        const stored = plugin._internal.readUserChatAuth({ datapath: tmpDatapath }, 'user//u1');
        stored.accessToken = 'tok_expired';
        plugin._internal.writeUserChatAuth({ datapath: tmpDatapath }, 'user//u1', stored);

        const sent = await new Promise((resolve) => {
            plugin.serveraction({ pluginaction: 'sendChatMessage', requestId: 'c4', dialogId: '3', message: 'Готово!' }, { user: u1.user, send: resolve });
        });
        assert.equal(sent.ok, true);
        assert.equal(sent.sent, true);
        assert.equal(sent.messages[sent.messages.length - 1].text, 'Готово!');

        // Logout clears u1 session
        const out = await new Promise((resolve) => {
            plugin.serveraction({ pluginaction: 'logoutChat', requestId: 'c5' }, { user: u1.user, send: resolve });
        });
        assert.equal(out.auth.authenticated, false);
    } finally {
        fs.rmSync(tmpDatapath, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
}

async function testOAuthServerDomainAndRoutePromotion() {
    const tmpDatapath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-routes-'));
    try {
        const plugin = pluginFactory(createMockParent({
            settings: {
                plugins: {
                    enabled: true,
                    b24contacts: {
                        portalUrl: 'https://bitrix.kzvs.org',
                        oauthClientId: 'local.app.1',
                        oauthClientSecret: 'sec_123'
                    }
                }
            }
        }, tmpDatapath));

        // 1. Validate Bitrix OAuth server_domain allowlist (cloud OAuth vs portal host vs evil host)
        assert.equal(
            plugin._internal.resolveOAuthTokenOrigin('oauth.bitrix24.tech', 'https://bitrix.kzvs.org'),
            'https://oauth.bitrix24.tech'
        );
        assert.equal(
            plugin._internal.resolveOAuthTokenOrigin('oauth.bitrix.info', 'https://bitrix.kzvs.org'),
            'https://oauth.bitrix.info'
        );
        assert.equal(
            plugin._internal.resolveOAuthTokenOrigin('bitrix.kzvs.org', 'https://bitrix.kzvs.org'),
            'https://bitrix.kzvs.org'
        );
        assert.equal(
            plugin._internal.resolveOAuthTokenOrigin('', 'https://bitrix.kzvs.org'),
            'https://bitrix.kzvs.org'
        );
        assert.throws(
            () => plugin._internal.resolveOAuthTokenOrigin('evil.example.com', 'https://bitrix.kzvs.org'),
            /Недопустимый OAuth-сервер/
        );
        await assert.rejects(
            () => plugin._internal.completeOAuthCallback('code_x', (() => {
                plugin._internal.oauthStates.set('st_evil', {
                    userId: 'user//u1',
                    redirectUri: 'https://mc.kzvs.pro/plugin/b24contacts/oauth/callback',
                    createdAt: Date.now()
                });
                return 'st_evil';
            })(), 'evil.example.com'),
            /Недопустимый OAuth-сервер/
        );
        assert.equal(
            plugin._internal.resolveRestEndpoint('https://bitrix.kzvs.org/rest/', 'https://bitrix.kzvs.org'),
            'https://bitrix.kzvs.org/rest'
        );

        // 2. Express 4 mock app (with legacy _b24ContactsRoutesRegistered=true from older version & query/expressInit at 0..1)
        const createMockExpress = (initialStack, useExpress5Router) => {
            const routes = {};
            const routerObj = { stack: initialStack.slice() };
            const app = {
                _b24ContactsRoutesRegistered: true, // simulate stale flag from v1.2.0
                routes,
                get(routePath, handler) {
                    routes[routePath] = handler;
                    routerObj.stack.push({ route: { path: routePath }, handle: handler });
                }
            };
            if (useExpress5Router) {
                app.router = routerObj;
            } else {
                app._router = routerObj;
            }
            return app;
        };

        const express4App = createMockExpress([
            { name: 'query' },
            { name: 'expressInit' },
            { route: { path: '/plugin/b24contacts/api/contacts' } }, // stale v1.2.0 layer
            { name: 'catchAll404' }
        ], false);
        assert.equal(plugin._internal.registerRoutes(express4App), true);
        const e4Paths = express4App._router.stack.map((l) => (l.route ? l.route.path : l.name));
        assert.deepEqual(e4Paths, [
            'query',
            'expressInit',
            '/plugin/b24contacts/api/contacts',
            '/plugin/b24contacts/oauth/callback',
            '/*/plugin/b24contacts/oauth/callback',
            'catchAll404'
        ]);

        // 3. Express 5 mock app (no query/expressInit middleware at indices 0..1; app.router instead of app._router)
        const express5App = createMockExpress([
            { name: 'domainHandler' },
            { name: 'catchAll404' }
        ], true);
        assert.equal(plugin._internal.registerRoutes(express5App), true);
        const e5Paths = express5App.router.stack.map((l) => (l.route ? l.route.path : l.name));
        assert.deepEqual(e5Paths, [
            '/plugin/b24contacts/api/contacts',
            '/plugin/b24contacts/oauth/callback',
            '/*/plugin/b24contacts/oauth/callback',
            'domainHandler',
            'catchAll404'
        ]);

        // Re-running registerRoutes at same ROUTES_VERSION must not duplicate layers
        assert.equal(plugin._internal.registerRoutes(express5App), true);
        assert.equal(express5App.router.stack.length, 5);
    } finally {
        fs.rmSync(tmpDatapath, { recursive: true, force: true });
    }
}

async function testManualDeviceBinding() {
    const mockUsers = [
        {
            ID: '10',
            NAME: 'Аптека',
            LAST_NAME: 'Краснодар Красная 5',
            WORK_PHONE: '88612223344',
            ACTIVE: true
        },
        {
            ID: '20',
            NAME: 'Склад',
            LAST_NAME: 'Логистика',
            PERSONAL_MOBILE: '89180009988',
            ACTIVE: true
        }
    ];

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: mockUsers, total: mockUsers.length }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const tmpDatapath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-bind-'));

    try {
        const base = 'http://127.0.0.1:' + port;
        const admin = { _id: 'user//admin', siteadmin: 0xFFFFFFFF };
        const normalUser = { _id: 'user//op', siteadmin: 0 };
        const plugin = pluginFactory(createMockParent({
            settings: {
                plugins: {
                    enabled: true,
                    b24contacts: {
                        webhookUrl: base + '/rest/1/tok/'
                    }
                }
            }
        }, tmpDatapath));

        await plugin._internal.refreshCache('test-init');

        // Unmatched PC before manual link
        const before = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'b1', nodeId: 'node//custom1', nodeName: 'SRV-UNKNOWN-99' },
                { user: normalUser, send: resolve }
            );
        });
        assert.equal(before.ok, true);
        assert.equal(before.matched, false);

        // Non-admin cannot setManualLink
        const forbidden = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'setManualLink', requestId: 'b2', nodeId: 'node//custom1', b24UserId: '20' },
                { user: normalUser, send: resolve }
            );
        });
        assert.equal(forbidden.ok, false);

        // Admin links node//custom1 -> user 20
        const linked = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'setManualLink', requestId: 'b3', nodeId: 'node//custom1', nodeName: 'SRV-UNKNOWN-99', b24UserId: '20' },
                { user: admin, send: resolve }
            );
        });
        assert.equal(linked.ok, true);
        assert.equal(linked.linkSaved, true);
        assert.equal(linked.manualLinks['node//custom1'].b24UserId, '20');
        assert.equal(linked.manualLinks['node//custom1'].b24UserName, 'Логистика Склад');
        assert.equal(linked.bitrixUsers.length, 2);

        // Now getContacts resolves user 20 via manual link despite completely unrelated PC name
        const after = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'b4', nodeId: 'node//custom1', nodeName: 'SRV-UNKNOWN-99' },
                { user: normalUser, send: resolve }
            );
        });
        assert.equal(after.ok, true);
        assert.equal(after.matched, true);
        assert.equal(after.manualLinked, true);
        assert.equal(after.profile.id, '20');
        assert.equal(after.phones[0].href, 'tel:89180009988');

        // General saveSettings MUST preserve manualLinks
        const saved = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'saveSettings', requestId: 'b5', settings: { cacheTtlMinutes: 60 } },
                { user: admin, send: resolve }
            );
        });
        assert.equal(saved.saved, true);
        assert.equal(saved.manualLinks['node//custom1'].b24UserId, '20');

        // Clear manual link -> falls back to unmatched auto-match
        const cleared = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'setManualLink', requestId: 'b6', nodeId: 'node//custom1', clearManualLink: true },
                { user: admin, send: resolve }
            );
        });
        assert.equal(cleared.ok, true);
        assert.equal(cleared.cleared, true);
        assert.equal(cleared.manualLinks['node//custom1'], undefined);

        const afterClear = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'b7', nodeId: 'node//custom1', nodeName: 'SRV-UNKNOWN-99' },
                { user: normalUser, send: resolve }
            );
        });
        assert.equal(afterClear.matched, false);
        assert.equal(afterClear.manualLinked, false);
    } finally {
        fs.rmSync(tmpDatapath, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
}

async function testLeftbarChatsTabAndUnreadHighlighting() {
    const mockUsers = [
        { ID: '101', ACTIVE: true, NAME: 'ВА | Калининская ул. Советская 38 - ЮБ', WORK_PHONE: '+78616321000' }
    ];
    let unreadCounts = { '101': 2, '202': 1, 'chat55': 3 };
    const threadMsgs = [
        { id: 495, author_id: 101, date: '2026-11-12T09:50:00+03:00', text: 'Старое сообщение 1' },
        { id: 496, author_id: 77, date: '2026-11-12T09:52:00+03:00', text: 'Старое сообщение 2' },
        { id: 497, author_id: 101, date: '2026-11-12T09:55:00+03:00', text: 'Старое сообщение 3' },
        { id: 498, author_id: 101, date: '2026-11-12T09:58:00+03:00', text: 'Старое сообщение 4' },
        { id: 501, author_id: 101, date: '2026-11-12T10:01:00+03:00', text: 'Не печатает чек' }
    ];
    const readCalls = [];

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url.endsWith('/user.get.json')) {
                res.end(JSON.stringify({ result: mockUsers, total: 1 }));
                return;
            }
            if (req.url.endsWith('/user.current.json')) {
                res.end(JSON.stringify({ result: { ID: '77', NAME: 'Иван', LAST_NAME: 'Соколов' } }));
                return;
            }
            const parsed = JSON.parse(raw || '{}');
            if (req.url.endsWith('/im.recent.list.json')) {
                res.end(JSON.stringify({
                    result: {
                        items: [
                            {
                                id: '101',
                                type: 'user',
                                title: 'ВА | Калининская ул. Советская 38 - ЮБ',
                                counter: unreadCounts['101'] || 0,
                                message: { id: 501, date: '2026-11-12T10:01:00+03:00', text: 'Не печатает чек' }
                            },
                            {
                                id: '202',
                                type: 'user',
                                title: 'Иван Петров',
                                counter: unreadCounts['202'] || 0,
                                message: { id: 502, date: '2026-11-12T10:02:00+03:00', text: 'Привет, зайди в офис' }
                            },
                            {
                                id: 'chat55',
                                type: 'chat',
                                chat_id: 55,
                                title: 'Общий чат ИТ',
                                counter: unreadCounts['chat55'] || 0,
                                message: { id: 503, date: '2026-11-12T10:03:00+03:00', text: 'Обновление ночью' }
                            }
                        ]
                    }
                }));
                return;
            }
            if (req.url.endsWith('/im.dialog.messages.get.json')) {
                res.end(JSON.stringify({
                    result: {
                        messages: threadMsgs.slice().reverse(),
                        users: [{ id: 101, name: 'ВА | Калининская ул. Советская 38 - ЮБ' }, { id: 77, name: 'Иван Соколов' }]
                    }
                }));
                return;
            }
            if (req.url.endsWith('/im.message.add.json')) {
                threadMsgs.push({
                    id: 502 + threadMsgs.length,
                    author_id: 77,
                    date: '2026-11-12T10:05:00+03:00',
                    text: parsed.MESSAGE
                });
                res.end(JSON.stringify({ result: 502 + threadMsgs.length }));
                return;
            }
            if (req.url.endsWith('/im.dialog.read.json')) {
                readCalls.push(parsed.DIALOG_ID);
                unreadCounts[String(parsed.DIALOG_ID)] = 0;
                res.end(JSON.stringify({ result: true }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'UNKNOWN' }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const tmpDatapath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-leftbar-'));

    try {
        const base = 'http://127.0.0.1:' + port;
        const plugin = pluginFactory(createMockParent({
            settings: {
                plugins: {
                    enabled: true,
                    b24contacts: {
                        webhookUrl: base + '/rest/1/tok/',
                        portalUrl: base
                    }
                }
            }
        }, tmpDatapath));

        await plugin._internal.refreshCache('test-leftbar');
        const userObj = { _id: 'user//op1', siteadmin: 0 };

        // Sign in operator via personal webhook
        const authRes = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'savePersonalWebhook', requestId: 'lb0', webhookUrl: base + '/rest/77/op_tok/' },
                { user: userObj, send: resolve }
            );
        });
        assert.equal(authRes.ok, true);

        const clientNodes = [
            { id: 'node//kalin', name: 'ст.Калининская ул.Советская, д.38 - касса ИБ' },
            { id: 'node//unmatched', name: 'Сервер резервный без Битрикса' }
        ];

        // Server overview returns ALL dialogs, but unreadNodeIds ONLY for synced PCs
        const overview1 = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getChatOverview', requestId: 'lb1', includeDialogs: true, nodes: clientNodes },
                { user: userObj, send: resolve }
            );
        });
        assert.equal(overview1.ok, true);
        assert.equal(overview1.unreadTotal, 6);
        assert.equal(overview1.dialogs.length, 3);
        assert.ok(overview1.unreadNodeIds['node//kalin'], 'Synced PC should be marked unread');
        assert.equal(overview1.unreadNodeIds['node//kalin'].count, 2);
        assert.equal(overview1.unreadNodeIds['node//unmatched'], undefined, 'Unsynced PC must NOT be highlighted');

        // Frontend VM DOM verification for #page_leftbar, #xdevices highlighting & chats page
        const dom = makeDomShim();
        const pageLeftbar = dom.makeElement('div');
        pageLeftbar.id = 'page_leftbar';
        const nativeNavBtn = dom.makeElement('div');
        nativeNavBtn.setAttribute('onclick', 'go(1)');
        const spacer = dom.makeElement('div');
        pageLeftbar.appendChild(nativeNavBtn);
        pageLeftbar.appendChild(spacer);

        const columnL = dom.makeElement('div');
        columnL.id = 'column_l';
        const p1 = dom.makeElement('div');
        p1.id = 'p1';
        const xdevices = dom.makeElement('div');
        xdevices.id = 'xdevices';

        const makeDeviceRow = (id, title) => {
            const row = dom.makeElement('div');
            row.className = 'listItem';
            const chk = dom.makeElement('input');
            chk.className = 'DeviceCheckbox';
            chk.value = 'devid_' + id;
            const icon = dom.makeElement('div');
            icon.className = 'i32';
            const nameSpan = dom.makeElement('span');
            nameSpan.textContent = title;
            row.appendChild(chk);
            row.appendChild(icon);
            row.appendChild(nameSpan);
            return { row, icon };
        };
        const kalinRow = makeDeviceRow('node//kalin', 'ст.Калининская ул.Советская, д.38');
        const unmatchedRow = makeDeviceRow('node//unmatched', 'Сервер резервный');
        xdevices.appendChild(kalinRow.row);
        xdevices.appendChild(unmatchedRow.row);
        p1.appendChild(xdevices);
        columnL.appendChild(p1);
        dom.body.appendChild(pageLeftbar);
        dom.body.appendChild(columnL);

        const sandbox = {
            window: {
                userinfo: userObj,
                currentNode: null,
                location: { origin: 'https://mc.kzvs.pro' }
            },
            document: {
                head: dom.head,
                body: dom.body,
                hidden: false,
                addEventListener: () => {},
                getElementById: (id) => dom.findById(dom.head, id) || dom.findById(dom.body, id),
                querySelector: (sel) => dom.body.querySelector(sel),
                querySelectorAll: (sel) => dom.body.querySelectorAll(sel),
                createElement: (tag) => dom.makeElement(tag),
                createElementNS: (_ns, tag) => dom.makeElement(tag)
            },
            nodes: clientNodes.map((n) => ({ _id: n.id, name: n.name })),
            xxcurrentView: 1,
            meshserver: {
                send: (msg) => {
                    plugin.serveraction(msg, {
                        user: userObj,
                        send: (reply) => {
                            if (reply.method === 'onChatResult') {
                                sandbox.window.B24ContactsPlugin.onChatResult(reply);
                            }
                        }
                    });
                }
            },
            setTimeout,
            clearTimeout,
            setInterval: () => ({ unref: () => {} }),
            clearInterval: () => {},
            Map
        };
        sandbox.window.document = sandbox.document;
        sandbox.window.meshserver = sandbox.meshserver;

        vm.runInNewContext('(' + plugin.onWebUIStartupEnd.toString() + ')()', sandbox);

        const leftTab = dom.findById(pageLeftbar, 'b24c-leftbar-tab');
        assert.ok(leftTab, 'Leftbar tab button should be injected into #page_leftbar');
        assert.equal(pageLeftbar.children[1], leftTab, 'Leftbar tab should be placed before trailing spacer');

        await sandbox.window.B24ContactsPlugin.refreshOverview(true);

        const leftBadge = dom.findById(pageLeftbar, 'b24c-leftbar-badge');
        assert.equal(leftBadge.textContent, '6');
        assert.ok(leftBadge.classList.contains('visible'));
        assert.ok(kalinRow.row.classList.contains('b24c-dev-unread'), 'Synced PC row should be highlighted');
        assert.ok(kalinRow.icon.classList.contains('b24c-dev-icon-unread'), 'Synced PC icon should be highlighted');
        assert.equal(kalinRow.row.querySelector('.b24c-dev-msg-badge').textContent, '💬 2');
        assert.ok(!unmatchedRow.row.classList.contains('b24c-dev-unread'), 'Unsynced PC row must NOT be highlighted');
        assert.equal(unmatchedRow.row.querySelector('.b24c-dev-msg-badge'), null);

        // Open chats tab and open dialog 101 -> automatically marks read on Bitrix24 & clears highlight
        sandbox.window.B24ContactsPlugin.openChats('101');
        await new Promise((r) => setTimeout(r, 30));

        const chatsPage = dom.findById(columnL, 'b24c-chats-page');
        assert.ok(chatsPage.classList.contains('visible'));
        assert.equal(p1.style.display, 'none');
        assert.equal(chatsPage.querySelectorAll('.b24c-dialog-item').length, 3, 'Chats tab must display all Bitrix24 chats');
        assert.ok(readCalls.includes('101'), 'Opening chat must automatically call im.dialog.read');
        assert.equal(leftBadge.textContent, '4', 'Leftbar unread badge should decrease after reading dialog 101');
        assert.ok(!kalinRow.row.classList.contains('b24c-dev-unread'), 'PC highlight should clear after reading dialog 101');

        // Verify thread scrolled to newest message (bottom), NOT stuck at 0 (oldest)
        const msgsBox = chatsPage.querySelector('.b24c-thread-msgs');
        assert.equal(msgsBox.scrollTop, msgsBox.scrollHeight, 'Thread should auto-scroll to newest messages at bottom');

        // Type draft & simulate background refresh -> textarea DOM element & draft MUST be preserved
        const textarea = chatsPage.querySelector('.b24c-thread-input');
        const sendForm = chatsPage.querySelector('.b24c-thread-form');
        assert.ok(textarea && sendForm);
        textarea.value = 'Иду проверять фискальник';
        await sandbox.window.B24ContactsPlugin.refreshOverview(true);
        assert.equal(chatsPage.querySelector('.b24c-thread-input'), textarea, 'Textarea must NOT be recreated during background refresh');
        assert.equal(textarea.value, 'Иду проверять фискальник', 'Typed draft must survive background refresh');

        // Send reply via form submit -> appends message, clears draft, stays scrolled to bottom
        sendForm.onsubmit({ preventDefault: () => {} });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(textarea.value, '', 'Textarea should clear after sending reply');
        assert.ok(threadMsgs.some((m) => m.text === 'Иду проверять фискальник'), 'Reply must be sent to Bitrix24');
        assert.equal(msgsBox.scrollTop, msgsBox.scrollHeight, 'Thread should stay scrolled to newest message after sending');

        // Switching back via MeshCentral goPageStart hides chats page
        sandbox.window.B24ContactsPlugin.goPageStart(1);
        assert.ok(!chatsPage.classList.contains('visible'));
        assert.ok(!leftTab.classList.contains('active'));
    } finally {
        fs.rmSync(tmpDatapath, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
}

async function main() {
    testManifest();
    testPrepExportsCompatibility();
    testMatchingLogic();
    testRealMeshCentralPluginHandler();
    await testBitrixPaginationSettingsAndResilience();
    await testFrontendInlineUi();
    await testPerUserOAuthAndMiniChat();
    await testOAuthServerDomainAndRoutePromotion();
    await testManualDeviceBinding();
    await testLeftbarChatsTabAndUnreadHighlighting();
    console.log('All b24contacts tests passed!');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
