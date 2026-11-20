'use strict';
/* Tests de routage wakeDevin / devin-hub — tout est mocké, aucun envoi réel.
 * L'extension compilée (out/extension.js) est chargée dans une VM avec des
 * stubs pour 'vscode', 'fs', sqlite et les imports locaux de panel. */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const EXT_DIR = path.join(__dirname, '..');
const EXT_JS = path.join(EXT_DIR, 'out', 'extension.js');
const HUB_EXT = path.join(EXT_DIR, 'agent-bridge', 'devin-hub.js');
const HUB_AGENT = path.join(EXT_DIR, '..', '..', '.agent', 'agent-bridge', 'devin-hub.js');

// Encodage indépendant : TextOrScopeItem{field1 text} = tag(0x0A) + varint(len) + data
function itemField1(text) {
    const data = Buffer.from(text, 'utf8');
    const len = [];
    let n = data.length;
    while (n > 0x7f) { len.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    len.push(n);
    return Buffer.concat([Buffer.from([0x0a]), Buffer.from(len), data]);
}

function loadExtension(env = {}) {
    const calls = [];
    const vscode = {
        commands: {
            executeCommand: async (cmd, arg) => {
                calls.push({ cmd, arg });
                if (env.execHandler) { return env.execHandler(cmd, arg); }
                return undefined;
            },
            registerCommand: () => ({ dispose() {} }),
            getCommands: async () => []
        },
        window: {
            showInformationMessage: async (m) => { calls.push({ toast: m }); return undefined; },
            showErrorMessage: (m) => { calls.push({ errToast: m }); },
            showWarningMessage: async () => undefined,
            registerWebviewViewProvider: () => ({ dispose() {} }),
            createStatusBarItem: () => ({ text: '', tooltip: '', command: undefined, show() {}, hide() {}, dispose() {} }),
            StatusBarAlignment: { Left: 1, Right: 2 }
        },
        env: {
            language: 'en',
            clipboard: { writeText: async (t) => { calls.push({ clipboard: t }); } }
        },
        workspace: {
            workspaceFolders: env.workspaceRoot ? [{ uri: { fsPath: env.workspaceRoot } }] : [],   // pas de root → commsLog no-op
            workspaceFile: env.workspaceFile ? { fsPath: env.workspaceFile } : undefined,
            onDidChangeWorkspaceFolders: env.onDidChangeWorkspaceFolders || (() => ({ dispose() {} })),
            getConfiguration: () => ({ get: (key, fallback) => key === 'enabledAgents' ? (env.enabledAgents || {}) : fallback ?? false })
        },
        extensions: { getExtension: () => undefined },
        StatusBarAlignment: { Left: 1, Right: 2 },
        Uri: {
            joinPath: (...p) => ({ fsPath: p.join('/') }),
            parse: (s) => ({ toString: () => s })
        }
    };
    const fakeFs = {
        existsSync: env.existsSync || (() => false),
        readdirSync: env.readdirSync || (() => { throw new Error('no cascade dir'); }),
        statSync: env.statSync || (() => { throw new Error('no stat'); }),
        mkdirSync: () => {},
        appendFileSync: () => {},
        writeFileSync: () => {},
        readFileSync: fs.readFileSync
    };
    const realRequire = Module.createRequire(EXT_JS);
    const req = (id) => {
        if (id === 'vscode') { return vscode; }
        if (id === 'fs') { return fakeFs; }
        if (id === 'child_process') { return { ...realRequire('child_process'), ...(env.childProcess || {}) }; }
        if (id === 'node:sqlite' || id.includes('better-sqlite3')) { throw new Error('no sqlite in tests'); }
        if (id === './panel/OrchestratorPanel') { return { OrchestratorPanel: class { } }; }
        if (id === './panel/panelHtml') { return { getPanelHtml: () => '' }; }
        if (id === './panel/messages') { return { handlePanelMessage: () => { } }; }
        if (id === './data/client') { return { OrchestratorWS: class { on() { } connect() { } send() { } dispose() { } } }; }
        return realRequire(id);
    };
    const mod = { exports: {} };
    const sandbox = {
        require: req, module: mod, exports: mod.exports,
        __dirname: path.dirname(EXT_JS), __filename: EXT_JS,
        process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(EXT_JS, 'utf8'), sandbox, { filename: EXT_JS });
    return { api: mod.exports, vscode, calls };
}

function acpState(focusedSessionId, sessions) {
    return { reduxStore: { acp: { focusedSessionId, sessions } } };
}
const ACP_ID = 'acp/devin-cli/bino-test';
const acpHandler = (state) => (cmd) => cmd === 'workbench.action.getAcpState' ? state : undefined;

const wakeCmds = (calls) => calls.filter((c) => c.cmd === 'devin.sendChatActionMessage').map((c) => JSON.parse(c.arg));

test('a) session ACP focalisée et connue -> explainAndFixProblem, TextOrScopeItem brut', async () => {
    const { api, calls } = loadExtension({
        execHandler: acpHandler(acpState(ACP_ID, [{ sessionId: ACP_ID, providerId: 'devin-cli' }]))
    });
    const text = 'BINOME-RESTORE — été ✓ ' + 'x'.repeat(200); // unicode + len>127
    const r = await api.wakeDevin(text, ACP_ID);
    assert.strictEqual(r, 'sent');
    // Uniquement getAcpState puis sendChatActionMessage — jamais de toast/clipboard
    assert.deepStrictEqual(calls.map((c) => c.cmd || Object.keys(c)[0]),
        ['workbench.action.getAcpState', 'devin.sendChatActionMessage']);
    const action = JSON.parse(calls[1].arg);
    assert.strictEqual(action.actionType, 'explainAndFixProblem');
    const decoded = Buffer.from(action.payload[0], 'base64');
    assert.ok(decoded.equals(itemField1(text)), 'payload doit être UN TextOrScopeItem brut (field1 utf8)');
    assert.strictEqual(action.payload.length, 1);
});

test('b) ACP : état absent / session inconnue / provider mismatch -> skipped sans focus', async () => {
    const cases = [
        undefined,                                                                          // état absent
        acpState(ACP_ID, []),                                                               // session inconnue
        acpState(ACP_ID, [{ sessionId: ACP_ID, providerId: 'cascade' }])                    // provider mismatch
    ];
    for (const state of cases) {
        const { api, calls } = loadExtension({ execHandler: acpHandler(state) });
        const r = await api.wakeDevin('hello', ACP_ID);
        assert.strictEqual(r, 'skipped', JSON.stringify(state));
        assert.deepStrictEqual(calls.map((c) => c.cmd || Object.keys(c)[0]), ['workbench.action.getAcpState']);
    }
});

test('b2) ACP : focus ailleurs -> tentative vscode.open puis re-vérif', async () => {
    // Le focus ne migre pas -> skipped après tentative d'ouverture de l'onglet
    let ctx = loadExtension({ execHandler: acpHandler(acpState('acp/devin-cli/other', [{ sessionId: ACP_ID, providerId: 'devin-cli' }])) });
    assert.strictEqual(await ctx.api.wakeDevin('hello', ACP_ID), 'skipped');
    assert.deepStrictEqual(ctx.calls.map((c) => c.cmd || Object.keys(c)[0]),
        ['workbench.action.getAcpState', 'vscode.open', 'workbench.action.getAcpState']);
    // Le focus migre vers la cible après vscode.open -> envoi
    const sessions = [{ sessionId: ACP_ID, providerId: 'devin-cli' }];
    let calls2 = 0;
    ctx = loadExtension({
        execHandler: (cmd) => {
            if (cmd === 'workbench.action.getAcpState') {
                return acpState(++calls2 === 1 ? 'acp/devin-cli/other' : ACP_ID, sessions);
            }
        }
    });
    assert.strictEqual(await ctx.api.wakeDevin('hello', ACP_ID), 'sent');
    assert.deepStrictEqual(ctx.calls.map((c) => c.cmd || Object.keys(c)[0]),
        ['workbench.action.getAcpState', 'vscode.open', 'workbench.action.getAcpState', 'devin.sendChatActionMessage']);
});

test('c) getAcpState ou sendChatActionMessage lève -> failed, aucun fallback', async () => {
    let env = {
        execHandler: (cmd) => {
            if (cmd === 'workbench.action.getAcpState') { throw new Error('acp state down'); }
            return undefined;
        }
    };
    let ctx = loadExtension(env);
    assert.strictEqual(await ctx.api.wakeDevin('hi', ACP_ID), 'failed');
    assert.strictEqual(ctx.calls.filter((c) => c.toast !== undefined || c.clipboard !== undefined).length, 0);

    env = {
        execHandler: (cmd) => {
            if (cmd === 'workbench.action.getAcpState') {
                return acpState(ACP_ID, [{ sessionId: ACP_ID, providerId: 'devin-cli' }]);
            }
            if (cmd === 'devin.sendChatActionMessage') { throw new Error('send refused'); }
            return undefined;
        }
    };
    ctx = loadExtension(env);
    assert.strictEqual(await ctx.api.wakeDevin('hi', ACP_ID), 'failed');
    assert.strictEqual(ctx.calls.filter((c) => c.toast !== undefined || c.clipboard !== undefined).length, 0);
    assert.strictEqual(wakeCmds(ctx.calls).length, 1);
});

test('d) uuid classique : setCascadeId puis sendCascadeInput ; uuid inconnu -> skipped', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { api, calls } = loadExtension({
        existsSync: (p) => String(p).endsWith(`${uuid}.pb`)
    });
    const r = await api.wakeDevin('hello classic', uuid);
    assert.strictEqual(r, 'sent');
    const actions = wakeCmds(calls).map((a) => a.actionType);
    assert.deepStrictEqual(actions, ['setCascadeId', 'sendCascadeInput']);
    // sendCascadeInput = SendCascadeInputRequest{items:[TextOrScopeItem]} (wrappé)
    const wrapped = Buffer.from(wakeCmds(calls)[1].payload[0], 'base64');
    const inner = itemField1('hello classic');
    const expected = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
    assert.ok(wrapped.equals(expected));

    const stale = loadExtension({ existsSync: () => false });
    assert.strictEqual(await stale.api.wakeDevin('hi', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 'skipped');
    assert.strictEqual(stale.calls.length, 0);
});

test('ACP binôme: la découverte est limitée au workspace demandeur', () => {
    const { api } = loadExtension({ workspaceRoot: 'C:/workspace' });
    assert.strictEqual(api.matchesWorkspace('C:/workspace'), true);
    assert.strictEqual(api.matchesWorkspace('C:/other-workspace'), false);
    assert.strictEqual(api.matchesWorkspace(''), false);
});

test('ACP binôme: découverte ne retourne que les sessions ACP activées', async () => {
    const sessions = [
        { sessionId: 'acp/hermes/one', providerId: 'hermes' },
        { sessionId: 'acp/opencode/one', providerId: 'opencode' },
        { sessionId: 'acp/disabled/one', providerId: 'gemini' }
    ];
    const { api } = loadExtension({
        enabledAgents: { hermes: true, opencode: false, gemini: false },
        execHandler: acpHandler(acpState('acp/hermes/one', sessions))
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await api.listAcpSessions())), [
        { sessionId: 'acp/hermes/one', providerId: 'hermes', focused: true }
    ]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await api.listAcpSessions('hermes'))), [
        { sessionId: 'acp/hermes/one', providerId: 'hermes', focused: true }
    ]);
});

test('startup: le watchdog se lance avec workspaceFile même sans workspaceFolders', async () => {
    const spawns = [];
    const childProcess = {
        spawn: (...args) => {
            spawns.push(args);
            const { EventEmitter } = require('node:events');
            const proc = new EventEmitter();
            proc.pid = 4242;
            proc.killed = false;
            proc.kill = () => { proc.killed = true; proc.emit('close', 0); return true; };
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.stdout.on = proc.stdout.addListener.bind(proc.stdout);
            proc.stderr.on = proc.stderr.addListener.bind(proc.stderr);
            return proc;
        }
    };
    const { api } = loadExtension({
        workspaceRoot: '',
        workspaceFile: 'C:/workspace/hephaistos2-kit.code-workspace',
        existsSync: (p) => String(p).replace(/\\/g, '/').endsWith('C:/workspace/.agent/skills/reactive-orchestrator/watchdog.ps1'),
        childProcess
    });
    await api.activate({
        extensionPath: 'C:/extension',
        extensionUri: { fsPath: 'C:/extension' },
        subscriptions: []
    });
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0][1].slice(-4), ['-WorkspaceRoot', 'C:/workspace', '-IntervalSeconds', '30']);
});

test('ACP binôme: un provider tiers non mappé est refusé sans API ciblée', async () => {
    const target = 'acp/gemini/session-one';
    const { api, calls } = loadExtension({
        enabledAgents: { gemini: true },
        workspaceRoot: 'C:/workspace',
        execHandler: acpHandler(acpState(target, [{ sessionId: target, providerId: 'gemini' }]))
    });
    api.__setAcpInjectorForTests(null);
    assert.strictEqual(await api.wakeAcpAgent('hello gemini', target, 'gemini'), 'skipped');
    assert.deepStrictEqual(calls.map((c) => c.cmd || Object.keys(c)[0]), [
        'workbench.action.getAcpState'
    ]);
    assert.strictEqual(wakeCmds(calls).length, 0);
    assert.strictEqual(calls.some((c) => c.cmd === 'vscode.open'), false);
});

test('ACP binôme: provider mappé -> injection stdio exacte, jamais le chat Devin', async () => {
    const target = 'acp/opencode/session-one';
    const injected = [];
    const { api, calls } = loadExtension({
        enabledAgents: { opencode: true },
        workspaceRoot: 'C:/workspace',
        execHandler: acpHandler(acpState('acp/devin-cli/other', [{ sessionId: target, providerId: 'opencode' }]))
    });
    api.__setAcpInjectorForTests({
        providerCommand: (id) => (id === 'opencode' ? { cmd: 'opencode.exe', args: ['acp'] } : null),
        inject: async (opts) => { injected.push(opts); return { sent: true, via: 'acp-stdio', delivered: true }; }
    });
    assert.strictEqual(await api.wakeAcpAgent('join request', target, 'opencode'), 'sent');
    assert.strictEqual(injected.length, 1);
    assert.strictEqual(injected[0].sessionId, target);
    assert.strictEqual(injected[0].providerId, 'opencode');
    assert.strictEqual(injected[0].cwd, 'C:/workspace');
    assert.strictEqual(injected[0].text, 'join request');
    // Jamais de commande Devin chat ni de tentative de focus pour un tiers.
    assert.strictEqual(wakeCmds(calls).length, 0);
    assert.strictEqual(calls.some((c) => c.cmd === 'vscode.open'), false);
});

test('ACP binôme: échec de l’injecteur -> failed sans fallback', async () => {
    const target = 'acp/opencode/session-one';
    const { api, calls } = loadExtension({
        enabledAgents: { opencode: true },
        workspaceRoot: 'C:/workspace',
        execHandler: acpHandler(acpState(target, [{ sessionId: target, providerId: 'opencode' }]))
    });
    api.__setAcpInjectorForTests({
        providerCommand: () => ({ cmd: 'opencode.exe', args: ['acp'] }),
        inject: async () => { throw new Error('session not found'); }
    });
    assert.strictEqual(await api.wakeAcpAgent('hello', target, 'opencode'), 'failed');
    assert.strictEqual(wakeCmds(calls).length, 0);
    assert.strictEqual(calls.some((c) => c.cmd === 'vscode.open'), false);
    assert.strictEqual(calls.some((c) => c.clipboard !== undefined || c.toast !== undefined), false);
});

test('ACP binôme: session absente, provider désactivé ou mismatch -> skipped sans focus ni fallback', async () => {
    const target = 'acp/kilo/session-one';
    const cases = [
        { enabledAgents: { kilo: false }, sessions: [{ sessionId: target, providerId: 'kilo' }] },
        { enabledAgents: { kilo: true }, sessions: [{ sessionId: target, providerId: 'hermes' }] },
        { enabledAgents: { kilo: true }, sessions: [] }
    ];
    for (const item of cases) {
        const { api, calls } = loadExtension({
            enabledAgents: item.enabledAgents,
            execHandler: acpHandler(acpState(target, item.sessions))
        });
        assert.strictEqual(await api.wakeAcpAgent('hello', target, 'kilo'), 'skipped');
        assert.ok(!calls.some((c) => c.cmd === 'vscode.open'));
        assert.strictEqual(wakeCmds(calls).length, 0);
        assert.strictEqual(calls.some((c) => c.clipboard !== undefined || c.toast !== undefined), false);
    }
});

test('ACP binôme: provider tiers non mappé non focalisé -> skipped sans tentative de focus Devin', async () => {
    const target = 'acp/nim/session-two';
    let reads = 0;
    const { api, calls } = loadExtension({
        enabledAgents: { nim: true },
        workspaceRoot: 'C:/workspace',
        execHandler: (cmd) => {
            if (cmd === 'workbench.action.getAcpState') {
                reads++;
                return acpState('acp/nim/other', [{ sessionId: target, providerId: 'nim' }]);
            }
        }
    });
    api.__setAcpInjectorForTests(null);
    assert.strictEqual(await api.wakeAcpAgent('hello', target, 'nim'), 'skipped');
    assert.strictEqual(reads, 1);
    assert.strictEqual(calls.some((c) => c.cmd === 'vscode.open'), false);
    assert.strictEqual(wakeCmds(calls).length, 0);
});

/* ===== devin-hub.js (les deux copies) ===== */

function loadHub(file, { resolverId, onSend } = {}) {
    const realRequire = Module.createRequire(file);
    const created = [];
    class FakeWS {
        constructor(url) { this.url = url; this.sent = []; this.handlers = {}; created.push(this); setImmediate(() => this.handlers.open && this.handlers.open()); }
        on(ev, cb) { this.handlers[ev] = cb; return this; }
        send(d) { const msg = JSON.parse(d); this.sent.push(msg); if (onSend) setImmediate(() => onSend(this, msg)); }
        close() { }
    }
    const req = (id) => {
        if (id === 'child_process') {
            return { execFileSync: () => { if (!resolverId) { throw new Error('resolver fail'); } return resolverId + '\n'; } };
        }
        if (id === 'fs') {
            return { readdirSync: () => { throw new Error('no pb dir'); }, statSync: () => { throw new Error('no stat'); }, readFileSync: fs.readFileSync };
        }
        if (id === './comms') { throw new Error('no comms'); }
        if (id === 'ws' || /(^|[\\/])ws$/.test(id)) { return FakeWS; }
        return realRequire(id);
    };
    const mod = { exports: {} };
    req.main = { id: 'other' }; // require.main !== module → CLI court-circuité
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        require: req, module: mod, exports: mod.exports,
        __dirname: path.dirname(file), __filename: file,
        process, console, Buffer, setTimeout, clearTimeout, setImmediate
    }, { filename: file });
    return { api: mod.exports, created };
}

for (const [name, file] of [['extension', HUB_EXT], ['.agent', HUB_AGENT]]) {
    test(`e) devin-hub (${name}) : cible explicite prime, fallback actif, rejet sans cible`, async () => {
        let h = loadHub(file, { resolverId: 'uuid-other' });
        let res = await h.api.sendToDevin('wake', 'acp/devin-cli/live');
        assert.strictEqual(res.cascadeId, 'acp/devin-cli/live');
        assert.strictEqual(h.created[0].sent[0].cascadeId, 'acp/devin-cli/live');

        h = loadHub(file, { resolverId: 'uuid-other' });
        res = await h.api.sendToDevin('wake', null);
        assert.strictEqual(res.cascadeId, 'uuid-other');

        h = loadHub(file, { resolverId: null });
        await assert.rejects(h.api.sendToDevin('wake', null), /Aucune session Devin cible/);
        assert.strictEqual(h.created.length, 0);
    });

    test(`f) devin-hub (${name}) : ACP list/send exige le provider et la session explicites`, async () => {
        const h = loadHub(file, {
            onSend: (ws, msg) => {
                if (msg.command === 'list_acp_sessions') {
                    ws.handlers.message(JSON.stringify({
                        type: 'acp_sessions_result', requestId: msg.requestId,
                        sessions: [{ sessionId: 'acp/hermes/one', providerId: 'hermes', focused: false }]
                    }));
                }
                if (msg.command === 'wake_acp_agent') {
                    ws.handlers.message(JSON.stringify({
                        type: 'acp_wake_result', requestId: msg.requestId, status: 'sent'
                    }));
                }
            }
        });
        const sessions = await h.api.listAcpSessions('hermes', 7477, 'C:/workspace');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(sessions)), [{ sessionId: 'acp/hermes/one', providerId: 'hermes', focused: false }]);
        assert.strictEqual(h.created[0].sent[0].providerId, 'hermes');
        assert.strictEqual(h.created[0].sent[0].workspaceRoot, 'C:/workspace');
        const result = await h.api.sendToAcpAgent('join request', 'acp/hermes/one', 'hermes', 7477, 'C:/workspace');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { status: 'sent', sessionId: 'acp/hermes/one', providerId: 'hermes' });
        assert.strictEqual(h.created[1].sent[0].sessionId, 'acp/hermes/one');
        assert.strictEqual(h.created[1].sent[0].providerId, 'hermes');
        await assert.rejects(h.api.sendToAcpAgent('no target', null, 'hermes', 7477, 'C:/workspace'), /explicit/);
        assert.strictEqual(h.created.length, 2);
    });
}

/* ===== Tests #375 et #376 : Comms layout bounding & corrélation taskId ===== */

test('#375: Comms layout - bornage de la hauteur persistée et valeurs par défaut', () => {
    const panelJsPath = path.join(__dirname, '..', 'media', 'panel.js');
    const panelJs = fs.readFileSync(panelJsPath, 'utf8');
    assert.ok(panelJs.includes('DEFAULT_COMMS_HEIGHT = 220'));
    assert.ok(panelJs.includes('MAX_COMMS_HEIGHT = 420'));
    assert.ok(panelJs.includes('MIN_COMMS_HEIGHT = 80'));

    const sandbox = { window: { innerHeight: 800 } };
    vm.runInNewContext(
        panelJs.slice(panelJs.indexOf('const DEFAULT_COMMS_HEIGHT'), panelJs.indexOf('window.clampCommsHeight = clampCommsHeight;')) +
        'window.clamp = clampCommsHeight;',
        sandbox
    );
    const clamp = sandbox.window.clamp;

    // Hauteur par défaut si absent / non numérique
    assert.strictEqual(clamp(undefined), '220px');
    assert.strictEqual(clamp('invalid'), '220px');

    // Borne basse (min 80px)
    assert.strictEqual(clamp('30px'), '80px');
    assert.strictEqual(clamp(50), '80px');

    // Borne haute (max 45% viewport = 360px pour 800px, plafond absolu 420px)
    assert.strictEqual(clamp('900px'), '360px');
    assert.strictEqual(clamp('400px'), '360px');

    // Hauteur valide préservée
    assert.strictEqual(clamp('220px'), '220px');
    assert.strictEqual(clamp('250px'), '250px');
});

test('#375: Comms CSS - en-tête fixé, liste scrollable et hauteur par défaut 220px', () => {
    const cssPath = path.join(__dirname, '..', 'media', 'comms-feed.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('#comms-feed {'), '#comms-feed doit être ciblé');
    assert.ok(css.includes('height: 220px;'), 'cible ~220px en CSS');
    assert.ok(css.includes('min-height: 80px;'), 'min-height 80px en CSS');
    assert.ok(css.includes('flex: none;'), '.comms-feed__header doit être flex: none');
    assert.ok(css.includes('overflow-y: auto;'), '.comms-feed__list doit être overflow-y: auto');
});

test('#376: binome.js - transmission de --task-id <id> à comms.log et statut skipped ACP', () => {
    const binomePath = path.join(__dirname, '..', 'agent-bridge', 'binome.js');
    const binomeSrc = fs.readFileSync(binomePath, 'utf8');
    assert.ok(binomeSrc.includes("'--task-id'"), 'binome.js doit supporter --task-id dans OPT_WITH_VAL');
    assert.ok(binomeSrc.includes("const rawTaskId = opt('--task-id');"), 'extraction de rawTaskId');
    assert.ok(binomeSrc.includes('{ taskId }'), 'propagation de taskId vers comms.log');
    assert.ok(binomeSrc.includes("kind: 'status'"), 'sur skipped, journalise kind status');
});
/* ===== Tests #377 : DiffCom transport / peerTransport couple ===== */

test('#377: formatTransport - affichage du couple transport/peerTransport sans deviner les champs absents', () => {
    const commsFeedPath = path.join(__dirname, '..', 'media', 'comms-feed.js');
    const commsFeed = require(commsFeedPath);
    const formatTransport = commsFeed.formatTransport;

    assert.strictEqual(typeof formatTransport, 'function', 'formatTransport doit être exporté');

    // Les deux champs existent et diffèrent : affiche les deux en ordre
    assert.strictEqual(formatTransport('acp', 'hub'), 'ACP → HUB');
    assert.strictEqual(formatTransport('hub', 'acp'), 'HUB → ACP');

    // Les deux champs existent et sont identiques : affiche une seule valeur
    assert.strictEqual(formatTransport('ACP', 'ACP'), 'ACP');
    assert.strictEqual(formatTransport('hub', 'hub'), 'HUB');

    // Champ unique : ne jamais deviner le champ manquant
    assert.strictEqual(formatTransport('hub', null), 'HUB');
    assert.strictEqual(formatTransport('acp', undefined), 'ACP');
    assert.strictEqual(formatTransport(null, 'hub'), 'HUB');
    assert.strictEqual(formatTransport(undefined, 'acp'), 'ACP');

    // Aucun champ ou chaînes vides
    assert.strictEqual(formatTransport(null, null), null);
    assert.strictEqual(formatTransport(undefined, undefined), null);
    assert.strictEqual(formatTransport('', ''), null);
    assert.strictEqual(formatTransport('   ', null), null);
});

test('#377: comms-feed.css - .comms-feed__transport avec white-space nowrap', () => {
    const cssPath = path.join(__dirname, '..', 'media', 'comms-feed.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('.comms-feed__transport {'), '.comms-feed__transport doit exister');
    assert.ok(css.includes('white-space: nowrap;'), 'white-space: nowrap doit être présent pour éviter les coupures');
});
test('#377: CommsFeed DOM rendering - dual label transport et préservation du taskId', () => {
    function createMockElement(tag) {
        return {
            tagName: tag,
            className: '',
            style: {},
            textContent: '',
            children: [],
            appendChild(child) { this.children.push(child); return child; },
            addEventListener() {}
        };
    }
    const mockDocument = {
        createElement: (tag) => createMockElement(tag)
    };
    const mockWindow = { document: mockDocument };

    const commsFeedPath = path.join(__dirname, '..', 'media', 'comms-feed.js');
    const commsFeedCode = fs.readFileSync(commsFeedPath, 'utf8');

    const sandbox = { window: mockWindow, document: mockDocument };
    vm.runInNewContext(commsFeedCode, sandbox);

    const CommsFeed = sandbox.window.CommsFeed;
    const container = createMockElement('div');
    CommsFeed.mount(container);

    CommsFeed.setEntries([
        { src: 'agy', dst: 'devin', transport: 'hub', peerTransport: 'acp', taskId: 377, text: 'hello' },
        { src: 'devin', dst: 'agy', transport: 'acp', peerTransport: 'acp', taskId: 378, text: 'ack' },
        { src: 'system', text: 'status update' }
    ]);

    const root = container.children[0];
    const list = root.children[1];
    assert.strictEqual(list.children.length, 3);

    // Item 1 : 'hub' et 'acp' diffèrent -> 'HUB → ACP', taskId #377
    const meta1 = list.children[0].children[0];
    const transportSpan1 = meta1.children.find(c => c.className === 'comms-feed__transport');
    const tagSpan1 = meta1.children.find(c => c.className === 'comms-feed__tag');
    assert.ok(transportSpan1, 'badge transport présent');
    assert.strictEqual(transportSpan1.textContent, 'HUB → ACP');
    assert.ok(tagSpan1, 'badge tag présent');
    assert.strictEqual(tagSpan1.textContent, '#377');

    // Item 2 : 'acp' et 'acp' identiques -> 'ACP', taskId #378
    const meta2 = list.children[1].children[0];
    const transportSpan2 = meta2.children.find(c => c.className === 'comms-feed__transport');
    const tagSpan2 = meta2.children.find(c => c.className === 'comms-feed__tag');
    assert.ok(transportSpan2, 'badge transport présent');
    assert.strictEqual(transportSpan2.textContent, 'ACP');
    assert.strictEqual(tagSpan2.textContent, '#378');

    // Item 3 : aucun transport ni taskId
    const meta3 = list.children[2].children[0];
    const transportSpan3 = meta3.children.find(c => c.className === 'comms-feed__transport');
    const tagSpan3 = meta3.children.find(c => c.className === 'comms-feed__tag');
    assert.strictEqual(transportSpan3, undefined, 'aucun badge transport si absent');
    assert.strictEqual(tagSpan3, undefined, 'aucun badge tag si taskId absent');
});
