const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync: Database } = require('node:sqlite');
const WebSocket = require('../ws-bridge/node_modules/ws');

const bridgeDir = path.join(__dirname, '..', 'ws-bridge');
const bridgePath = path.join(bridgeDir, 'bridge.js');

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

test('bridge starts with an isolated database and serves a local snapshot', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-bridge-'));
    const commsDir = path.join(tempDir, '.agent');
    const dbPath = path.join(tempDir, 'orchestrator.db');
    const commsPath = path.join(commsDir, 'comms.jsonl');
    fs.mkdirSync(commsDir, { recursive: true });
    fs.writeFileSync(commsPath, '');

    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE tasks_todo (
            id INTEGER PRIMARY KEY, title TEXT, description TEXT, priority INTEGER,
            status TEXT, due_date TEXT, created_at TEXT, dependencies TEXT,
            assigned_to TEXT, result TEXT, task_type TEXT, model TEXT,
            provider TEXT, dispatcher TEXT
        );
        CREATE TABLE agents (
            id INTEGER PRIMARY KEY, agent_name TEXT, agent_type TEXT, config TEXT, active INTEGER
        );
        CREATE TABLE model_health (
            id INTEGER PRIMARY KEY, supplier TEXT, provider TEXT, model TEXT,
            available INTEGER, latency_ms INTEGER, checked_at TEXT
        );
        CREATE TABLE task_events (
            id INTEGER PRIMARY KEY, task_id INTEGER, event TEXT, detail TEXT, ts TEXT
        );
    `);
    db.close();

    const port = await getFreePort();
    const TOKEN = 'test-token-bridge-01';
    const child = spawn(process.execPath, [bridgePath], {
        cwd: bridgeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ORCHESTRATOR_DB: dbPath,
            ORCH_MONITOR_PORT: String(port),
            ORCH_MONITOR_POLL_MS: '60000',
            ORCH_MODEL_PING_MS: '0',
            ORCH_MONITOR_DISABLE_PROBES: '1',
            ORCH_MONITOR_TOKEN: TOKEN,
            HEPHAISTOS_WORKSPACE: tempDir,
            COMMS_LOG: commsPath
        }
    });

    let output = '';
    let stderr = '';
    let ready = false;
    const bridgeReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`bridge did not listen; stderr: ${stderr}`)), 10000);
        child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (!ready && output.includes('websocket listening')) {
                ready = true;
                clearTimeout(timer);
                resolve();
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            if (!ready) {
                clearTimeout(timer);
                reject(new Error(`bridge exited with code ${code}; stderr: ${stderr}`));
            }
        });
    });

    let client;
    t.after(async () => {
        if (client && client.readyState === WebSocket.OPEN) client.close();
        if (child.exitCode === null) child.kill();
        if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    await bridgeReady;

    // Sans token → l'upgrade est rejeté en 401 (revue sécu : pas de client
    // local anonyme capable de lire le snapshot ou d'envoyer des commandes).
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connexion sans token non rejetée')), 4000);
        const bad = new WebSocket(`ws://127.0.0.1:${port}`);
        const done = (err) => { clearTimeout(timer); if (err) reject(err); else resolve(); };
        bad.once('open', () => done(new Error('open sans token')));
        bad.once('unexpected-response', (req, res) => {
            try { assert.equal(res.statusCode, 401); res.resume(); done(); }
            catch (e) { done(e); }
        });
        bad.once('error', () => { /* 'unexpected-response' couvre déjà */ });
    });

    // Header Bearer accepté aussi (clients Node propres).
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bearer rejeté')), 4000);
        const ok = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        ok.once('open', () => { clearTimeout(timer); ok.close(); resolve(); });
        ok.once('error', (e) => { clearTimeout(timer); reject(e); });
    });

    client = new WebSocket(`ws://127.0.0.1:${port}?token=${TOKEN}`);
    const snapshot = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge snapshot timeout')), 5000);
        client.once('message', (raw) => {
            clearTimeout(timer);
            try { resolve(JSON.parse(raw.toString())); } catch (error) { reject(error); }
        });
        client.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    assert.equal(snapshot.type, 'snapshot');
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.agents, []);
});

test('bridge accepts one token per workspace entry', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-bridge-multi-'));
    const dirs = [path.join(tempDir, 'devin'), path.join(tempDir, 'cursor')];
    const tokens = ['token-devin-entry', 'token-cursor-entry'];
    for (let i = 0; i < dirs.length; i++) {
        const agent = path.join(dirs[i], '.agent');
        fs.mkdirSync(agent, { recursive: true });
        fs.writeFileSync(path.join(agent, 'comms.jsonl'), '');
        fs.writeFileSync(path.join(agent, 'ws-bridge.token'), tokens[i] + '\n');
    }
    const dbPath = path.join(tempDir, 'orchestrator.db');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE tasks_todo (
            id INTEGER PRIMARY KEY, title TEXT, description TEXT, priority INTEGER,
            status TEXT, due_date TEXT, created_at TEXT, dependencies TEXT,
            assigned_to TEXT, result TEXT, task_type TEXT, model TEXT,
            provider TEXT, dispatcher TEXT
        );
        CREATE TABLE agents (
            id INTEGER PRIMARY KEY, agent_name TEXT, agent_type TEXT, config TEXT, active INTEGER
        );
        CREATE TABLE model_health (
            id INTEGER PRIMARY KEY, supplier TEXT, provider TEXT, model TEXT,
            available INTEGER, latency_ms INTEGER, checked_at TEXT
        );
        CREATE TABLE task_events (
            id INTEGER PRIMARY KEY, task_id INTEGER, event TEXT, detail TEXT, ts TEXT
        );
    `);
    db.close();

    const port = await getFreePort();
    const child = spawn(process.execPath, [bridgePath], {
        cwd: bridgeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ORCHESTRATOR_DB: dbPath,
            ORCH_MONITOR_PORT: String(port),
            ORCH_MONITOR_POLL_MS: '60000',
            ORCH_MODEL_PING_MS: '0',
            ORCH_MONITOR_DISABLE_PROBES: '1',
            ORCH_MONITOR_TOKEN: '',
            HEPHAISTOS_WORKSPACE: dirs[0],
            HEPHAISTOS_WORKSPACES: dirs.join(';'),
            COMMS_LOG: ''
        }
    });

    let output = '';
    let stderr = '';
    let ready = false;
    const bridgeReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`bridge did not listen; stderr: ${stderr}`)), 10000);
        child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (!ready && output.includes('websocket listening')) {
                ready = true;
                clearTimeout(timer);
                resolve();
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('exit', (code) => {
            if (!ready) {
                clearTimeout(timer);
                reject(new Error(`bridge exited with code ${code}; stderr: ${stderr}`));
            }
        });
    });

    t.after(async () => {
        if (child.exitCode === null) child.kill();
        if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    await bridgeReady;
    await new Promise((resolve, reject) => {
        const started = Date.now();
        const probe = () => {
            const sock = net.connect(port, '127.0.0.1');
            const done = (ok) => { try { sock.destroy(); } catch { /* noop */ } ok ? resolve() : retry(); };
            sock.once('connect', () => done(true));
            sock.once('error', () => done(false));
        };
        const retry = () => {
            if (Date.now() - started > 4000) reject(new Error(`port ${port} fermé; stderr: ${stderr}`));
            else setTimeout(probe, 50);
        };
        probe();
    });
    assert.match(output, /entrée\(s\) comms/);

    for (const token of tokens) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`token refusé: ${token}`)), 4000);
            const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
            ws.once('message', () => { clearTimeout(timer); ws.close(); resolve(); });
            ws.once('unexpected-response', (_req, res) => {
                clearTimeout(timer);
                reject(new Error(`HTTP ${res.statusCode} pour ${token}`));
            });
            ws.once('error', (e) => { clearTimeout(timer); reject(e); });
        });
    }

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('token inconnu non rejeté')), 4000);
        const bad = new WebSocket(`ws://127.0.0.1:${port}?token=not-a-workspace-token`);
        bad.once('open', () => { clearTimeout(timer); reject(new Error('open avec token inconnu')); });
        bad.once('unexpected-response', (_req, res) => {
            try { assert.equal(res.statusCode, 401); res.resume(); clearTimeout(timer); resolve(); }
            catch (e) { clearTimeout(timer); reject(e); }
        });
        bad.once('error', () => { /* unexpected-response suit */ });
    });
});
