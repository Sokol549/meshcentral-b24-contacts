'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
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

function testManifest() {
    assert.equal(manifest.shortName, 'b24contacts');
    assert.match(manifest.shortName, /^[a-zA-Z0-9]+$/);
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

    // Mirror MeshCentral pluginHandler.prepExports()
    let code = 'var obj = {};\n';
    code += 'obj.' + manifest.shortName + ' = {};\n';
    for (const fnName of plugin.exports) {
        assert.equal(typeof plugin[fnName], 'function');
        code += 'obj.' + manifest.shortName + '.' + fnName + ' = ' + plugin[fnName].toString() + ';\n';
    }
    code += 'return obj;';

    // Ensure generated code compiles cleanly in browser-like sandbox (no Node closure leaks)
    const compiled = new Function(code);
    const createdNodes = [];
    const sandbox = {
        document: {
            getElementById: () => null,
            createElement: (tag) => ({ tagName: tag }),
            head: { appendChild: (el) => createdNodes.push(el) }
        },
        window: {}
    };
    const exported = vm.runInNewContext('(' + compiled.toString() + ')()', sandbox);
    exported.b24contacts.onWebUIStartupEnd();
    assert.equal(createdNodes.length, 1);
    assert.equal(createdNodes[0].id, 'b24contacts-loader');
    assert.equal(createdNodes[0].src, 'plugin/b24contacts/b24contacts.js');
    exported.b24contacts.onDeviceRefreshEnd();
    exported.b24contacts.onContactsResult({}, { ok: true });
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
            PERSONAL_MOBILE: '+79185556677'
        })
    ];

    // Exact prompt sample
    const m1 = findBestContactMatch('ст.Калининская ул.Советская, д.38 - касса ИБ', b24Users, 0.55);
    assert.equal(m1.matched, true);
    assert.equal(m1.profile.id, '101');
    assert.equal(m1.profile.phones.length, 2);
    assert.equal(m1.profile.phones[0].href, 'tel:+78616321000');
    assert.equal(m1.profile.phones[1].href, 'tel:+79181112233');

    // Split LAST_NAME + NAME, glued prefix + building letter
    const m2 = findBestContactMatch('г.Краснодар ул.Красная, д.176А - касса 2', b24Users, 0.55);
    assert.equal(m2.matched, true);
    assert.equal(m2.profile.id, '102');
    assert.equal(m2.profile.phones[0].href, 'tel:88612223344');

    // ё/е normalization + glued prefix
    const m3 = findBestContactMatch('п.Афипский ул.Березовая, д.5 - рмк 1', b24Users, 0.55);
    assert.equal(m3.matched, true);
    assert.equal(m3.profile.id, '103');

    // House number mismatch on same street/city MUST NOT false-match
    const mWrongHouse = findBestContactMatch('ст.Калининская ул.Советская, д.99 - касса ИБ', b24Users, 0.55);
    assert.equal(mWrongHouse.matched, false);

    // City-only overlap MUST NOT false-match
    const mWrongStreet = findBestContactMatch('г.Краснодар ул.Северная, д.500 - касса', b24Users, 0.55);
    assert.equal(mWrongStreet.matched, false);

    // Generic PC name MUST NOT match
    const mGeneric = findBestContactMatch('SERVER-DC01', b24Users, 0.55);
    assert.equal(mGeneric.matched, false);

    // Additional real-world pharmacy formats (no spaces after comma, hyphenated cities, building corps, abbreviations)
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

    const os = require('os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-b24-test-'));
    const pluginsDir = path.join(tmpRoot, 'plugins', 'b24contacts');
    fs.mkdirSync(path.join(pluginsDir, 'public'), { recursive: true });
    fs.copyFileSync(pluginHandlerPath, path.join(tmpRoot, 'pluginHandler.js'));
    fs.writeFileSync(path.join(tmpRoot, 'common.js'), 'module.exports = { isAlphaNumeric: (v) => /^[a-z0-9]+$/i.test(String(v || "")) };');
    fs.copyFileSync(path.join(__dirname, '..', 'b24contacts.js'), path.join(pluginsDir, 'b24contacts.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'config.json'), path.join(pluginsDir, 'config.json'));
    fs.copyFileSync(path.join(__dirname, '..', 'public', 'b24contacts.js'), path.join(pluginsDir, 'public', 'b24contacts.js'));

    // Disk config fallback test (when server.config didn't pass b24contacts directly)
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

        // Verify pluginHandler.prepExports() produces valid JS
        const builderSrc = ph.prepExports();
        const builderFn = new Function('return ' + builderSrc);
        const clientHandler = builderFn()();
        assert.equal(typeof clientHandler.b24contacts.onWebUIStartupEnd, 'function');
        assert.equal(typeof clientHandler.b24contacts.onDeviceRefreshEnd, 'function');
        assert.equal(typeof clientHandler.b24contacts.onContactsResult, 'function');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

async function testBitrixPaginationAndResilience() {
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

    try {
        const webhookUrl = 'http://127.0.0.1:' + port + '/rest/1/secret_token_xyz/';
        const mockParent = createMockParent({
            settings: {
                plugins: {
                    enabled: true,
                    b24contacts: {
                        webhookUrl: webhookUrl,
                        cacheTtlMinutes: 60,
                        pageDelayMs: 0
                    }
                }
            }
        });

        const plugin = pluginFactory(mockParent);
        assert.equal(plugin._internal.maskWebhookUrl(webhookUrl), 'http://127.0.0.1:' + port + '/rest/1/***/');

        const ok = await plugin._internal.refreshCache('test');
        assert.equal(ok, true);
        assert.equal(receivedBodies.length, 2);
        assert.deepEqual(receivedBodies[0].FILTER, { ACTIVE: true });
        assert.equal(receivedBodies[0].start, 0);
        assert.equal(receivedBodies[1].start, 2);
        assert.equal(plugin._internal.getCacheState().users.length, 3);

        // Test serveraction authorization and match response
        let unauthSent = false;
        plugin.serveraction({ pluginaction: 'getContacts', nodeName: 'ст.Калининская ул.Советская, д.38' }, { send: () => { unauthSent = true; } });
        assert.equal(unauthSent, false);

        const wsReply = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'req-1', nodeId: 'node//1', nodeName: 'ст.Динская ул.Красная, д.44 - касса ИБ' },
                { user: { _id: 'user//admin', siteadmin: 0 }, send: resolve }
            );
        });
        assert.equal(wsReply.action, 'plugin');
        assert.equal(wsReply.plugin, 'b24contacts');
        assert.equal(wsReply.method, 'onContactsResult');
        assert.equal(wsReply.requestId, 'req-1');
        assert.equal(wsReply.ok, true);
        assert.equal(wsReply.matched, true);
        assert.equal(wsReply.profile.id, '3');
        assert.equal(wsReply.phones.length, 2);

        // Simulate Bitrix24 API failure: stale cache must be preserved without throwing
        failMode = true;
        const okAfterFail = await plugin._internal.refreshCache('test-fail');
        assert.equal(okAfterFail, false);
        assert.equal(plugin._internal.getCacheState().users.length, 3);

        const wsReplyWithStaleCache = await new Promise((resolve) => {
            plugin.serveraction(
                { pluginaction: 'getContacts', requestId: 'req-2', nodeId: 'node//2', nodeName: 'ст.Калининская ул.Советская, д.38 - касса ИБ' },
                { user: { _id: 'user//admin', siteadmin: 0 }, send: resolve }
            );
        });
        assert.equal(wsReplyWithStaleCache.matched, true);
        assert.equal(wsReplyWithStaleCache.profile.id, '1');

        // Test Express HTTP route registration & auth check
        const routes = {};
        const mockApp = {
            _router: { stack: [] },
            get: function (p, handler) {
                routes[p] = handler;
                this._router.stack.push({ route: { path: p } });
            }
        };
        plugin.hook_setupHttpHandlers({ app: mockApp });
        assert.equal(typeof routes['/plugin/b24contacts/b24contacts.js'], 'function');
        assert.equal(typeof routes['/plugin/b24contacts/api/contacts'], 'function');

        let status401 = null;
        let body401 = null;
        await routes['/plugin/b24contacts/api/contacts'](
            { query: { nodeName: 'test' }, headers: {} },
            {
                setHeader: () => {},
                status: (s) => ({ json: (b) => { status401 = s; body401 = b; } })
            }
        );
        assert.equal(status401, 401);
        assert.equal(body401.ok, false);

        let status200 = null;
        let body200 = null;
        mockParent.parent.users['user//1'] = { _id: 'user//1' };
        await routes['/plugin/b24contacts/api/contacts'](
            { query: { nodeName: 'ст.Калининская ул.Советская, д.38 - касса ИБ' }, session: { userid: 'user//1' }, headers: {} },
            {
                setHeader: () => {},
                status: (s) => ({ json: (b) => { status200 = s; body200 = b; } })
            }
        );
        assert.equal(status200, 200);
        assert.equal(body200.matched, true);
        assert.equal(body200.profile.id, '1');

        plugin.server_shutdown();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function testInvalidConfigResilience() {
    const plugin = pluginFactory(createMockParent({
        settings: {
            plugins: {
                enabled: true,
                b24contacts: { webhookUrl: 'not-a-valid-url' }
            }
        }
    }));

    plugin.server_startup();
    const ok = await plugin._internal.refreshCache('invalid-url');
    assert.equal(ok, false);

    const reply = await new Promise((resolve) => {
        plugin.serveraction(
            { pluginaction: 'getContacts', requestId: 'req-bad', nodeName: 'ст.Калининская ул.Советская, д.38' },
            { user: { _id: 'user//1' }, send: resolve }
        );
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.matched, false);
    assert.ok(reply.error);
    plugin.server_shutdown();
}

async function testFrontendDomInjection() {
    const clientCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'b24contacts.js'), 'utf8');

    function makeElement(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            id: '',
            className: '',
            textContent: '',
            href: '',
            title: '',
            type: '',
            disabled: false,
            style: {},
            dataset: {},
            children: [],
            parentNode: null,
            attributes: {},
            setAttribute: function (k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); },
            addEventListener: function () {},
            appendChild: function (child) {
                child.parentNode = this;
                this.children.push(child);
                return child;
            },
            replaceChildren: function () {
                this.children = [];
            },
            remove: function () {
                if (this.parentNode) {
                    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
                    this.parentNode = null;
                }
            },
            querySelector: function (sel) {
                const cls = sel.startsWith('.') ? sel.slice(1) : null;
                const stack = [...this.children];
                while (stack.length) {
                    const node = stack.shift();
                    if (cls && node.className === cls) return node;
                    if (!cls && node.tagName.toLowerCase() === sel.toLowerCase()) return node;
                    stack.push(...node.children);
                }
                return null;
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
    const p10 = makeElement('div');
    p10.id = 'p10';
    p10.style.display = '';
    const p10info = makeElement('div');
    p10info.id = 'p10info';
    p10.appendChild(p10info);

    const sentMessages = [];
    const windowObj = {
        currentNode: { _id: 'node//1', name: 'ст.Калининская ул.Советская, д.38 - касса ИБ' }
    };

    const sandbox = {
        window: windowObj,
        document: {
            head: head,
            createElement: makeElement,
            createElementNS: (_ns, tag) => makeElement(tag),
            getElementById: (id) => findById(head, id) || findById(p10, id)
        },
        meshserver: {
            send: (msg) => sentMessages.push(msg)
        },
        setTimeout,
        clearTimeout,
        Map
    };
    sandbox.window.document = sandbox.document;
    sandbox.window.meshserver = sandbox.meshserver;

    vm.runInNewContext(clientCode, sandbox);

    // Loader immediately renders spinner and sends WS getContacts
    const card = findById(p10, 'b24-contacts-card');
    assert.ok(card, 'Card should be mounted in #p10info');
    assert.ok(card.querySelector('.b24c-spinner'), 'Spinner should render while loading');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].pluginaction, 'getContacts');

    // Deliver matched reply with XSS payload in displayName
    sandbox.window.B24ContactsPlugin.onContactsResult({
        requestId: sentMessages[0].requestId,
        ok: true,
        matched: true,
        profile: {
            id: '101',
            displayName: '<img src=x onerror=alert(1)> ВА | Калининская, ул. Советская 38 - ЮБ'
        },
        phones: [
            { type: 'work', label: 'Рабочий', display: '+7 (86163) 21-0-00', href: 'tel:+78616321000' },
            { type: 'mobile', label: 'Мобильный', display: '+7 918 111-22-33', href: 'tel:+79181112233' }
        ]
    });

    await new Promise((r) => setTimeout(r, 10));
    const prof = card.querySelector('.b24c-profile');
    assert.ok(prof);
    assert.equal(prof.children.length, 0, 'XSS string must remain plain textContent, not parsed HTML');
    assert.ok(prof.textContent.includes('<img src=x onerror=alert(1)>'));

    const links = [];
    const stack = [...card.children];
    while (stack.length) {
        const n = stack.shift();
        if (n.tagName === 'A') links.push(n);
        stack.push(...n.children);
    }
    assert.equal(links.length, 2);
    assert.equal(links[0].href, 'tel:+78616321000');
    assert.equal(links[1].href, 'tel:+79181112233');

    // Switch to unmatched device
    windowObj.currentNode = { _id: 'node//2', name: 'Неизвестный ПК' };
    sandbox.window.B24ContactsPlugin.onDeviceRefreshEnd();
    assert.equal(sentMessages.length, 2);
    sandbox.window.B24ContactsPlugin.onContactsResult({
        requestId: sentMessages[1].requestId,
        ok: true,
        matched: false,
        profile: null,
        phones: []
    });
    await new Promise((r) => setTimeout(r, 10));
    const muted = card.querySelector('.b24c-muted');
    assert.ok(muted);
    assert.equal(muted.textContent, 'Связанный профиль в Битрикс24 не найден');
}

async function main() {
    testManifest();
    testPrepExportsCompatibility();
    testMatchingLogic();
    testRealMeshCentralPluginHandler();
    await testBitrixPaginationAndResilience();
    await testInvalidConfigResilience();
    await testFrontendDomInjection();
    console.log('All b24contacts tests passed!');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
