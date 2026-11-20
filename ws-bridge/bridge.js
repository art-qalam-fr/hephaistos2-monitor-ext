// Orchestrator WS Bridge — poll orchestrator.db (read-only) and broadcast snapshots.
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DB_PATH = process.env.ORCHESTRATOR_DB
    || process.env.HPHE_ORCH_DB
    || path.join(process.env.HPHE_INSTALL || path.join(process.env.ProgramFiles || 'C:/Program Files', 'servers', 'hephaistos2-kit'), 'data', 'orchestrator.db');
const WS_PORT = Number(process.env.ORCH_MONITOR_PORT || 7477);
const POLL_INTERVAL = Number(process.env.ORCH_MONITOR_POLL_MS || 2000);
const PROBES_DISABLED = process.env.ORCH_MONITOR_DISABLE_PROBES === '1';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
console.log(`[bridge] connected to ${DB_PATH} (read-only)`);

// Suicide si un ancêtre meurt : le bridge est spawné par l'extension IDE ;
// sans garde il devient orphelin à la mort de l'IDE et continue à poller.
(function guardAncestors() {
    const SYS = new Set(['system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe',
        'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'tasklist.exe', 'conhost.exe']);
    const { execFileSync } = require('child_process');
    const chain = [];
    let cur = process.ppid;
    for (let i = 0; i < 16 && cur && cur > 4; i++) {
        try {
            const out = execFileSync('powershell', ['-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter 'ProcessId=${cur}' | Select-Object ParentProcessId,Name | ConvertTo-Json -Compress)`],
                { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
            if (!out) break;
            const p = JSON.parse(out);
            if (SYS.has(String(p.Name || '').toLowerCase())) break;
            chain.push(cur);
            cur = p.ParentProcessId;
        } catch { break; }
    }
    if (!chain.length) return;
    const t = setInterval(() => {
        for (const pid of chain) {
            try { process.kill(pid, 0); } catch (e) {
                if (e.code === 'EPERM') continue;
                clearInterval(t);
                console.log(`[bridge] ancêtre ${pid} mort — sortie`);
                process.exit(0);
            }
        }
    }, 5000);
    t.unref();
})();

// Bus comms inter-agents : .agent/comms.jsonl à la racine du workspace
// (agy-hub, monitor, scripts y appendent ; on tail et on broadcast).
// Résolution : COMMS_LOG (tests) sinon fusion de toutes les racines connues.
// Multi-workspaces : plusieurs IDE (Devin, Cursor, …) écrivent chacun dans
// leur .agent/comms.jsonl — le feed doit les FUSIONNER.
// Racines supplémentaires :
//   HEPHAISTOS_WORKSPACES  (séparateur ; ou retour ligne)
//   <HPHE_INSTALL>/data/ingest-roots.txt  (liste déjà tenue par le kit)
function installDataDir() {
    return path.join(
        process.env.HPHE_INSTALL || path.join(process.env.ProgramFiles || 'C:/Program Files', 'servers', 'hephaistos2-kit'),
        'data'
    );
}
function normalizeRoot(raw) {
    let s = String(raw || '').trim();
    if (!s || s.startsWith('#')) return '';
    if (s.startsWith('\\\\?\\')) s = s.slice(4);
    else if (s.startsWith('\\?\\')) s = s.slice(3);
    try { return path.resolve(s); } catch { return ''; }
}
function registeredWorkspaceDirs() {
    const chunks = [process.env.HEPHAISTOS_WORKSPACES || ''];
    try { chunks.push(fs.readFileSync(path.join(installDataDir(), 'ingest-roots.txt'), 'utf8')); } catch { /* absent */ }
    const dirs = [];
    for (const chunk of chunks) {
        for (const line of chunk.split(/[\r\n;]+/)) {
            const norm = normalizeRoot(line);
            if (norm) dirs.push(norm);
        }
    }
    return dirs;
}
function resolveCommsPaths() {
    if (process.env.COMMS_LOG) return [process.env.COMMS_LOG];
    const dirs = [
        process.env.HEPHAISTOS_WORKSPACE,
        process.cwd(),
        path.join(__dirname, '..', '..', '..'), // layout repo : ws-bridge → racine
        process.env.HEPHAISTOS_KIT,
        ...registeredWorkspaceDirs(),
    ].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const dir of dirs) {
        const norm = path.resolve(dir);
        if (seen.has(norm)) continue;
        seen.add(norm);
        const p = path.join(norm, '.agent', 'comms.jsonl');
        if (fs.existsSync(p)) out.push(p);
    }
    if (out.length === 0 && dirs[0]) out.push(path.join(dirs[0], '.agent', 'comms.jsonl'));
    return out;
}
let COMMS_PATHS = resolveCommsPaths();
const wakedSigs = new Set();
const commsOffsets = new Map(); // path -> offset

function parseLines(lines) {
    return lines.filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

function readCommsTail(n = 100) {
    const all = [];
    for (const p of COMMS_PATHS) {
        try {
            all.push(...parseLines(fs.readFileSync(p, 'utf8').split('\n')));
        } catch { /* absent */ }
    }
    // merge trié par ts, dédup ts+text
    const seen = new Set();
    return all
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
        .filter((e) => {
            const k = String(e.ts) + '|' + String(e.text);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .slice(-n);
}

function readCommsFrom(p, offset) {
    try {
        const st = fs.statSync(p);
        let truncated = false;
        if (offset > st.size) { offset = 0; truncated = true; }
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        return { entries: parseLines(buf.toString('utf8').split('\n')), offset: st.size, truncated };
    } catch { return { entries: [], offset: 0, truncated: (commsOffsets.get(p) || 0) > 0 }; }
}
// Prime les offsets pour ne broadcaster que les NOUVELLES entrées
for (const p of COMMS_PATHS) {
    try { commsOffsets.set(p, fs.statSync(p).size); } catch { commsOffsets.set(p, 0); }
}

// Table des toggles provider (créée en écriture, lue partout) :
// enabled = on/off, position = ordre de priorité (drag & drop UI)
try {
    const wdb = new DatabaseSync(DB_PATH);
    wdb.exec('CREATE TABLE IF NOT EXISTS provider_prefs (provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)');
    try { wdb.exec('ALTER TABLE provider_prefs ADD COLUMN position INTEGER'); } catch { /* colonne déjà là */ }
    // FR-08 : heartbeat worker (datetime('now'), comparable au cutoff du reconcile)
    try { wdb.exec('ALTER TABLE tasks_todo ADD COLUMN last_heartbeat TEXT'); } catch { /* déjà là */ }
    // ollama local : réservé à l'utilisateur par défaut → seed OFF
    wdb.prepare("INSERT OR IGNORE INTO provider_prefs (provider, enabled) VALUES ('ollama', 0)").run();
    wdb.close();
} catch (e) { console.error('[bridge] provider_prefs init:', e.message); }

function readProviderPrefs() {
    const prefs = {};
    try {
        for (const r of db.prepare('SELECT provider, enabled FROM provider_prefs').all()) {
            prefs[r.provider] = !!r.enabled;
        }
    } catch { /* table absente → tout ON */ }
    return prefs;
}

function readProviderOrder() {
    try {
        return db.prepare('SELECT provider FROM provider_prefs WHERE position IS NOT NULL ORDER BY position').all()
            .map(r => r.provider);
    } catch { return []; }
}

// Santé modèles : dernier état connu par (provider, model) — table alimentée
// par les pings model-discovery ET par la sonde locale ci-dessous.
function readModelHealth() {
    try {
        return db.prepare(
            `SELECT supplier, provider, model, available, latency_ms, checked_at
             FROM model_health
             WHERE id IN (SELECT MAX(id) FROM model_health GROUP BY provider, model)
             ORDER BY checked_at DESC`
        ).all();
    } catch { return []; }
}

// --- Sonde de modèles : même recette que ping-model du MCP model-discovery
// (POST /chat/completions, max_tokens=1). Round-robin : un modèle par tick,
// cibles = modèles vus dans les tâches récentes (pending/in_progress/failed).
// Ping d'inférence désactivé par défaut : il consomme les forfaits. Activer explicitement avec ORCH_MODEL_PING_MS=<ms>.
const PING_MS = Number(process.env.ORCH_MODEL_PING_MS || 0);
const PROVIDER_TO_SUPPLIER = {
    'nvidia-nim': 'nim', 'nvidia-nim2': 'nim2',
    'openrouter': 'openrouter', 'openrouter-free': 'openrouter-free',
    'kilo': 'kilo', 'kilo-free': 'kilo', 'nous': 'nous', 'hermes-free': 'nous',
    'ollama': 'ollama', 'ollama-cloud': 'ollama',
    'omniroute-local': 'omniroute',
};
const PING_ENDPOINTS = {
    nim: () => ({ url: `${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`, key: process.env.NVIDIA_API_KEY }),
    nim2: () => ({ url: `${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`, key: process.env.NVIDIA_API_KEY_2 }),
    openrouter: () => ({ url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY }),
    'openrouter-free': () => ({ url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY }),
    kilo: () => ({ url: 'https://api.kilo.ai/api/gateway/chat/completions', key: process.env.KILO_API_KEY }),
    nous: () => {
        try {
            const p = `${process.env.LOCALAPPDATA || ''}/hermes/auth.json`;
            const tok = JSON.parse(fs.readFileSync(p, 'utf-8'))?.providers?.nous?.access_token;
            if (!tok) return null;
            return { url: 'https://inference-api.nousresearch.com/v1/chat/completions', key: tok };
        } catch { return null; }
    },
    ollama: () => ({ url: 'http://localhost:11434/v1/chat/completions' }),
    // OmniRoute : gateway locale OpenAI-compatible (authless en loopback par
    // défaut — OMNIROUTE_API_KEY optionnelle, REQUIRE_API_KEY=false côté serveur).
    omniroute: () => ({
        url: `${process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128/v1'}/chat/completions`,
        key: process.env.OMNIROUTE_API_KEY || undefined,
    }),
};

// Catalogues free par provider — rechargés toutes les 30 min. Le ping doit
// couvrir CHAQUE modèle free détaillé (pas seulement le routeur) : quand un
// modèle spécifique répond bien, pickModel le préfère au routeur free.
const FREE_CATALOGS = [
    { supplier: 'openrouter-free', url: 'https://openrouter.ai/api/v1/models', key: () => process.env.OPENROUTER_API_KEY, free: (id) => id.endsWith(':free') || id === 'openrouter/free' },
    { supplier: 'kilo', url: 'https://api.kilo.ai/api/gateway/models', key: () => process.env.KILO_API_KEY, free: (id) => id.includes('free') },
    { supplier: 'nous', url: 'https://inference-api.nousresearch.com/v1/models', key: () => PING_ENDPOINTS.nous()?.key, free: (id) => id.includes(':free') },
];
let freeTargets = [];
let freeTargetsAt = 0;
function fetchJsonArr(url, key, cb) {
    const transport = url.startsWith('https') ? https : http;
    transport.get(url, { timeout: 10000, headers: key ? { Authorization: `Bearer ${key}` } : {} }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { cb(JSON.parse(buf)); } catch { cb(null); } });
    }).on('error', () => cb(null)).on('timeout', function () { this.destroy(); cb(null); });
}
function refreshFreeTargets() {
    for (const cat of FREE_CATALOGS) {
        fetchJsonArr(cat.url, cat.key(), (data) => {
            if (!data?.data) return;
            const models = data.data
                .map((m) => m.id)
                .filter((id) => typeof id === 'string' && cat.free(id))
                .map((model) => ({ supplier: cat.supplier, model }));
            freeTargets = freeTargets.filter((t) => t.supplier !== cat.supplier).concat(models);
        });
    }
    freeTargetsAt = Date.now();
}
if (!PROBES_DISABLED) {
    refreshFreeTargets();
    setInterval(refreshFreeTargets, 30 * 60e3);
}

function pingTargets() {
    let taskModels = [];
    try {
        taskModels = db.prepare(
            `SELECT DISTINCT provider, model FROM tasks_todo
             WHERE model IS NOT NULL AND model != ''
               AND status IN ('pending','in_progress','failed')
             ORDER BY id DESC LIMIT 20`
        ).all()
            .map((r) => ({ supplier: PROVIDER_TO_SUPPLIER[r.provider], model: r.model }))
            .filter((t) => t.supplier && t.model);
    } catch { /* */ }
    const seen = new Set(taskModels.map((t) => `${t.supplier}|${t.model}`));
    return taskModels.concat(freeTargets.filter((t) => !seen.has(`${t.supplier}|${t.model}`)));
}

let pingIdx = 0;
let pingInFlight = false;
function pingNextModel() {
    if (pingInFlight) return;
    const targets = pingTargets();
    if (!targets.length) return;
    const t = targets[pingIdx++ % targets.length];
    const ep = PING_ENDPOINTS[t.supplier] && PING_ENDPOINTS[t.supplier]();
    if (!ep || ep.error) return;
    pingInFlight = true;
    const started = Date.now();
    const body = JSON.stringify({ model: t.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
    const transport = ep.url.startsWith('https') ? https : http;
    const req = transport.request(ep.url, {
        method: 'POST',
        timeout: 20000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
        },
    }, (res) => {
        res.resume();
        res.on('end', () => recordPing(t, res.statusCode >= 200 && res.statusCode < 300, Date.now() - started));
    });
    req.on('timeout', () => { req.destroy(); recordPing(t, false, Date.now() - started); });
    req.on('error', () => recordPing(t, false, Date.now() - started));
    req.end(body);
}
const SUPPLIER_TO_PROVIDER = {
    nim: 'nvidia-nim', nim2: 'nvidia-nim2',
    'openrouter-free': 'openrouter-free', openrouter: 'openrouter-free',
    kilo: 'kilo-free', nous: 'hermes-free', ollama: 'ollama',
    omniroute: 'omniroute-local',
};
function recordPing(t, ok, latency) {
    pingInFlight = false;
    try {
        const wdb = new DatabaseSync(DB_PATH);
        wdb.prepare('INSERT INTO model_health (supplier, provider, model, available, latency_ms) VALUES (?,?,?,?,?)')
            .run(t.supplier, SUPPLIER_TO_PROVIDER[t.supplier] || t.supplier, t.model, ok ? 1 : 0, latency);
        wdb.close();
    } catch (e) { console.error('[bridge] ping write:', e.message); }
}
if (PING_MS > 0 && !PROBES_DISABLED) setInterval(pingNextModel, PING_MS);

/* ----- Auth WS : une entrée par workspace -----
   Loopback-only ne suffit pas : tout process local pourrait envoyer
   wake_acp_agent / clear_tasks. Plusieurs IDE partagent le même port ;
   chacun présente le secret de SON .agent/ws-bridge.token.
   Acceptés à chaque upgrade (relecture disque, pas de redémarrage) :
   1) env ORCH_MONITOR_TOKEN (tests, override explicite)
   2) chaque ws-bridge.token à côté d'un comms.jsonl fusionné
   3) chaque ws-bridge.token des racines ingest-roots / HEPHAISTOS_WORKSPACES
   S'il n'existe aucun secret, un token est généré et écrit seulement dans
   les dossiers .agent déjà résolus. Jamais logué. */
function bridgeTokenPaths() {
    const files = COMMS_PATHS.map((p) => path.join(path.dirname(p), 'ws-bridge.token'));
    if (!process.env.COMMS_LOG) {
        for (const dir of registeredWorkspaceDirs()) {
            files.push(path.join(dir, '.agent', 'ws-bridge.token'));
        }
    }
    return files;
}
let acceptedTokens = [];
function refreshAcceptedTokens() {
    const found = [];
    const seen = new Set();
    const push = (raw) => {
        const t = String(raw || '').trim();
        if (!t || seen.has(t)) return;
        seen.add(t);
        found.push(Buffer.from(t, 'utf8'));
    };
    push(process.env.ORCH_MONITOR_TOKEN);
    for (const f of bridgeTokenPaths()) {
        try { push(fs.readFileSync(f, 'utf8')); } catch { /* absent */ }
    }
    if (!found.length) {
        const token = crypto.randomBytes(24).toString('hex');
        let written = 0;
        for (const f of bridgeTokenPaths()) {
            try {
                fs.mkdirSync(path.dirname(f), { recursive: true });
                fs.writeFileSync(f, token + '\n', { mode: 0o600 });
                written++;
            } catch { /* best-effort */ }
        }
        if (!written) console.error('[bridge] WARN: ws-bridge.token non écrit — clients sans env rejetés');
        push(token);
    }
    // Backfill : un workspace enregistré après le premier boot n'a aucun
    // fichier token -> ses clients sont rejetés au upgrade (401). Si au
    // moins un secret existe, on propage le premier vers les .agent/
    // résolus qui n'en ont pas. On ne crée pas .agent/ pour autant : un
    // workspace sans .agent/comms.jsonl n'est pas encore une cible agent.
    if (found.length) {
        const shared = found[0].toString('utf8');
        for (const f of bridgeTokenPaths()) {
            try {
                if (!fs.existsSync(f) && fs.existsSync(path.dirname(f))) {
                    fs.writeFileSync(f, shared + '\n', { mode: 0o600 });
                }
            } catch { /* best-effort */ }
        }
    }
    acceptedTokens = found;
}
refreshAcceptedTokens();
console.log(`[bridge] ${COMMS_PATHS.length} entrée(s) comms, ${acceptedTokens.length} secret(s) accepté(s)`);

function upgradeAuthorized(req) {
    let tok = '';
    try { tok = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token') || ''; } catch { /* url malformée */ }
    if (!tok) {
        const auth = req.headers.authorization || '';
        const m = /^bearer\s+(.+)$/i.exec(auth.trim());
        if (m) tok = m[1].trim();
    }
    if (!tok.length) return false;
    refreshAcceptedTokens();
    // Audit F4 : comparaison en temps constant sur chaque secret connu.
    const a = Buffer.from(tok, 'utf8');
    let ok = false;
    for (const b of acceptedTokens) {
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
    }
    return ok;
}

// Serveur HTTP explicite : bind loopback strict + auth sur l'upgrade WS.
// (new WebSocket.Server({port}) binderait sur 0.0.0.0 → exposé LAN).
const wss = new WebSocket.Server({ noServer: true });
const httpServer = http.createServer();
httpServer.on('upgrade', (req, socket, head) => {
    if (!upgradeAuthorized(req)) {
        console.warn(`[bridge] upgrade rejeté (${req.socket.remoteAddress} — token invalide)`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
httpServer.listen(WS_PORT, '127.0.0.1');
console.log(`[bridge] websocket listening on ws://127.0.0.1:${WS_PORT} (loopback+token)`);
const pendingAcpRequests = new Map();

function finishAcpRequest(requestId, timedOut = false) {
    const pending = pendingAcpRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
    pendingAcpRequests.delete(requestId);
    let result;
    if (pending.type === 'list_acp_sessions') {
        const unique = new Map();
        for (const response of pending.responses) {
            for (const session of response.sessions || []) {
                if (session?.sessionId && session?.providerId) unique.set(`${session.providerId}|${session.sessionId}`, session);
            }
        }
        result = { type: 'acp_sessions_result', requestId, sessions: [...unique.values()] };
        if (timedOut && !pending.responses.length) result.error = 'ACP extension timeout';
    } else {
        const statuses = pending.responses.map((response) => response.status);
        result = {
            type: 'acp_wake_result',
            requestId,
            status: statuses.includes('sent') ? 'sent' : statuses.includes('failed') ? 'failed' : 'skipped'
        };
        if (timedOut && !pending.responses.length) result.error = 'ACP extension timeout';
    }
    if (pending.ws.readyState === WebSocket.OPEN) pending.ws.send(JSON.stringify(result));
}

function completeAcpRequest(requestId, response) {
    const pending = pendingAcpRequests.get(requestId);
    if (!pending) return;
    pending.responses.push(response);
    if (pending.type === 'wake_acp_agent' && response.status === 'sent') {
        finishAcpRequest(requestId);
        return;
    }
    if (!pending.settleTimer) {
        const settleMs = pending.type === 'wake_acp_agent' ? 1500 : 300;
        pending.settleTimer = setTimeout(() => finishAcpRequest(requestId), settleMs);
    }
}

function requestAcpClient(ws, requestId, type, payload, timeoutMs = 10000) {
    if (typeof requestId !== 'string' || !requestId) return;
    const pending = { ws, type, responses: [], timer: null, settleTimer: null };
    pending.timer = setTimeout(() => finishAcpRequest(requestId, true), timeoutMs);
    pendingAcpRequests.set(requestId, pending);
    broadcast({ type, requestId, ...payload });
}

const lastTaskHash = new Map(); // task id -> hash of serialized row
let lastAgentHash = '';
let lastHealthHash = '';

function readTasks() {
    return db.prepare(
        `SELECT id, title, description, priority, status, due_date, created_at,
                dependencies, assigned_to, result, task_type, model, provider, dispatcher
         FROM tasks_todo ORDER BY id DESC`
    ).all();
}

function readAgents() {
    return db.prepare(
        `SELECT id, agent_name, agent_type, config, active FROM agents ORDER BY id`
    ).all();
}

function getDistinctIdeCount() {
    const idePids = new Set();
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client._idePid) {
            idePids.add(client._idePid);
        }
    }
    return idePids.size > 0 ? idePids.size : (wss.clients && wss.clients.size > 0 ? Math.ceil(wss.clients.size / 2) : 1);
}

function snapshot() {
    return {
        type: 'snapshot',
        client_count: getDistinctIdeCount(),
        tasks: readTasks(),
        agents: readAgents(),
        providers: readProviderPrefs(),
        provider_order: readProviderOrder(),
        model_health: readModelHealth(),
        comms: readCommsTail(100),
        ts: new Date().toISOString()
    };
}

function broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
}

function syncCommsPaths() {
    if (process.env.COMMS_LOG) return;
    const next = resolveCommsPaths();
    for (const p of next) {
        if (!commsOffsets.has(p)) {
            try { commsOffsets.set(p, fs.statSync(p).size); } catch { commsOffsets.set(p, 0); }
        }
    }
    COMMS_PATHS = next;
}

// Referent de liaison (binome) lu a chaque reveil depuis .agent/binome-link.json.
// Plus de session codee en dur : la liaison se change sans toucher au code.
function readBinomeReferent(wsRoot) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(wsRoot, '.agent', 'binome-link.json'), 'utf8'));
        if (j?.referent?.sessionId && j?.referent?.providerId) return j.referent;
    } catch { /* fichier absent : repli ci-dessous */ }
    return { sessionId: 'acp/devin-cli/ionian-helicopter', providerId: 'devin-cli' };
}

function poll() {
    try {
        syncCommsPaths();
        const tasks = readTasks();
        const now = new Date().toISOString();

        for (const task of tasks) {
            const h = JSON.stringify(task);
            if (lastTaskHash.get(task.id) !== h) {
                lastTaskHash.set(task.id, h);
                broadcast({ type: 'task_update', task, ts: now });
            }
        }
        // deleted tasks — broadcast un snapshot sinon le dashboard garde les
        // tâches supprimées (ex: delete_task via hphe-mcp court-circuite le bridge)
        const ids = new Set(tasks.map(t => t.id));
        let removed = false;
        for (const id of [...lastTaskHash.keys()]) {
            if (!ids.has(id)) { lastTaskHash.delete(id); removed = true; }
        }
        if (removed) {
            broadcast({ type: 'snapshot', tasks, agents: readAgents(), providers: readProviderPrefs(), provider_order: readProviderOrder(), ts: now });
        }

        const agents = readAgents();
        const ah = JSON.stringify(agents);
        if (ah !== lastAgentHash) {
            lastAgentHash = ah;
            broadcast({ type: 'snapshot', tasks, agents, providers: readProviderPrefs(), provider_order: readProviderOrder(), ts: now });
        }

        // Santé modèles : broadcast quand la table bouge (pings discovery ou sonde locale)
        const mh = readModelHealth();
        const mhHash = JSON.stringify(mh);
        if (mhHash !== lastHealthHash) {
            lastHealthHash = mhHash;
            broadcast({ type: 'model_health', models: mh, ts: now });
        }

        // Feed comms inter-agents (append-only JSONL, multi-workspaces)
        let anyTruncated = false;
        const fresh = [];
        for (const p of COMMS_PATHS) {
            const c = readCommsFrom(p, commsOffsets.get(p) || 0);
            commsOffsets.set(p, c.offset);
            if (c.truncated) anyTruncated = true;
            fresh.push(...c.entries);
        }
        if (anyTruncated) {
            broadcast({ type: 'comms', reset: true, entries: [], ts: now });
            broadcast({ type: 'comms', entries: readCommsTail(100), ts: now });
        }
        if (fresh.length) {
            fresh.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
            broadcast({ type: 'comms', entries: fresh, ts: now });

            // Signaux Bleubite -> réveil du référent : toute réponse d'agent
            // (agent-reply, agent-error) ou DONE:<id> déclenche wake_acp_agent
            // vers la session entrée — sinon l'orchestrateur n'apprend jamais
            // que l'agent a répondu.
            for (const e of fresh) {
                const txt = String(e.text || '');
                if (e.kind !== 'agent-reply' && e.kind !== 'agent-error' && !/DONE:\d+/.test(txt)) continue;
                // Dedup persistante entre polls : le meme comms.jsonl peut etre
                // vu via deux racines (jonction NTFS) ou relu par un poll
                // concurrent -> la meme reponse arriverait deux fois.
                const sig = `${e.ts}|${e.src}|${e.kind}|${txt.slice(0, 80)}`;
                if (wakedSigs.has(sig)) continue;
                wakedSigs.add(sig);
                if (wakedSigs.size > 500) wakedSigs.delete(wakedSigs.values().next().value);
                const client = [...wss.clients].find((c) => c.readyState === WebSocket.OPEN);
                if (!client) break;
                const wsRoot = path.dirname(path.dirname(e._path || COMMS_PATHS[0]));
                const link = readBinomeReferent(wsRoot);
                requestAcpClient(client, `sig-${Date.now()}`, 'wake_acp_agent', {
                    text: `[${e.src}] ${e.kind}: ${txt.slice(0, 400)}`,
                    sessionId: link.sessionId,
                    providerId: link.providerId,
                    workspaceRoot: wsRoot,
                });
            }
        }
    } catch (err) {
        console.error('[bridge] poll error:', err.message);
    }
}

// ---- Faucheur de tâches zombies (2e couche — hphe-rest fait pareil quand il vit) ----
// Une tâche in_progress dont le worker est mort ne transitionne jamais :
// aucun wake terminal ne part, le poll ne voit aucun changement -> silence.
// On marque 'failed' ici pour que le dashboard + les wakes reflètent la réalité.
function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---- Suivi des requêtes ACP des fenêtres hephaistos-chats ----
// Chaque tour de chat émet start/done/fail ; la requête devient une ligne
// tasks_todo (task_type='acp_chat', expected_artifact='req:<id>') + events
// task_events, donc le dashboard voit pending -> completed/failed en direct.
function handleTrackRequest(msg) {
    try {
        const wdb = new DatabaseSync(DB_PATH);
        const rid = String(msg.requestId).slice(0, 120);
        const key = `req:${rid}`;
        const now = new Date().toISOString();
        const row = wdb.prepare(
            "SELECT id, status FROM tasks_todo WHERE expected_artifact=? ORDER BY id DESC LIMIT 1"
        ).get(key);
        const ev = wdb.prepare("INSERT INTO task_events (task_id, event, detail, ts) VALUES (?,?,?,?)");
        if (msg.action === 'start') {
            if (row && (row.status === 'in_progress' || row.status === 'pending')) { wdb.close(); return; }
            const title = `[chat] ${msg.provider || '?'} / ${msg.model || '?'}`.slice(0, 200);
            const desc = `${key} ${String(msg.preview || '').replace(/\s+/g, ' ').slice(0, 400)}`;
            const info = wdb.prepare(
                `INSERT INTO tasks_todo (title, description, status, task_type, provider, model, dispatcher, workspace, expected_artifact, last_heartbeat, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`
            ).run(title, desc, 'in_progress', 'acp_chat', msg.provider || null, msg.model || null,
                  'hephaistos-chats', msg.workspace || null, key, now, now);
            ev.run(String(info.lastInsertRowid), 'request_start',
                JSON.stringify({ sessionId: msg.sessionId || '', src: msg.src || 'user', mode: msg.mode || '' }), now);
        } else if (row) {
            if (msg.action === 'done') {
                wdb.prepare("UPDATE tasks_todo SET status='completed', result=?, last_heartbeat=? WHERE id=?")
                   .run(String(msg.result || '').slice(0, 4000), now, row.id);
                ev.run(String(row.id), 'request_done', String(msg.result || '').slice(0, 500), now);
                // Notification bus : la fin de tour d'une fenêtre doit remonter
                // sur comms.jsonl — les agents abonnés (Devin/WakeUp) le voient.
                appendComms({
                    src: msg.provider || 'hephaistos-chats', dst: 'devin',
                    text: `[chat] ${msg.provider || '?'}/${msg.model || '?'} a terminé son tour (${rid}) : ${String(msg.result || '').replace(/\s+/g, ' ').slice(0, 200)}`,
                    sessionId: msg.sessionId || '', ts: now,
                });
            } else if (msg.action === 'fail') {
                wdb.prepare("UPDATE tasks_todo SET status='failed', result=?, last_heartbeat=? WHERE id=?")
                   .run(String(msg.error || 'échec').slice(0, 2000), now, row.id);
                ev.run(String(row.id), 'request_failed', String(msg.error || '').slice(0, 500), now);
                appendComms({
                    src: msg.provider || 'hephaistos-chats', dst: 'devin',
                    text: `[chat] ${msg.provider || '?'}/${msg.model || '?'} a ÉCHOUÉ (${rid}) : ${String(msg.error || 'échec').replace(/\s+/g, ' ').slice(0, 200)}`,
                    sessionId: msg.sessionId || '', ts: now,
                });
            } else if (msg.action === 'progress') {
                wdb.prepare("UPDATE tasks_todo SET last_heartbeat=? WHERE id=?").run(now, row.id);
            }
        }
        wdb.close();
        broadcast({ type: 'task_tracked', requestId: rid, action: msg.action, ts: now });
    } catch (e) {
        console.error('[bridge] track_request error:', e.message);
    }
}

function reconcileTasks() {
    try {
        const wdb = new DatabaseSync(DB_PATH);
        const cutoff = '-180 seconds';
        const markFailed = (id, result, detail) => {
            wdb.prepare("UPDATE tasks_todo SET status='failed', result=? WHERE id=?").run(result, id);
            wdb.prepare("INSERT INTO task_events (task_id, event, detail, ts) VALUES (?,?,?,?)")
               .run(String(id), 'reaped', detail, new Date().toISOString());
            console.log(`[bridge] reconcile: task#${id} -> failed (${detail})`);
        };
        // 1) event 'dispatched' avec pid mort
        for (const r of wdb.prepare(
            `SELECT t.id, e.detail FROM tasks_todo t
             JOIN task_events e ON e.id = (
               SELECT MAX(id) FROM task_events
               WHERE task_id = CAST(t.id AS TEXT) AND event = 'dispatched')
             WHERE t.status IN ('in_progress','assigned')
               AND e.ts <= datetime('now', ?)`).all(cutoff)) {
            const m = /pid=(\d+)/.exec(r.detail || '');
            const pid = m ? parseInt(m[1], 10) : 0;
            if (pid && !pidAlive(pid)) {
                markFailed(r.id, `process pid=${pid} terminé sans résultat (reap bridge)`, `pid=${pid} mort — reconcilié par ws-bridge`);
            }
        }
        // 2) dernier event = 'dispatch_error' (spawn tenté, jamais parti)
        for (const r of wdb.prepare(
            `SELECT t.id FROM tasks_todo t
             JOIN task_events e ON e.id = (
               SELECT MAX(id) FROM task_events
               WHERE task_id = CAST(t.id AS TEXT))
             WHERE t.status IN ('in_progress','assigned')
               AND e.event = 'dispatch_error'
               AND e.ts <= datetime('now', ?)`).all(cutoff)) {
            markFailed(r.id, 'spawn raté (dispatch_error) — reconcilié par ws-bridge', 'dispatch_error — jamais spawné');
        }
        // 3) FR-08 : heartbeat expiré (>10 min sans tick) — worker gelé mais
        // vivant (pid OK, zéro progression). Le tick ne monte que si le
        // wrapper voit du signal ; un worker gelé finit ici en failed.
        for (const r of wdb.prepare(
            `SELECT id FROM tasks_todo
             WHERE status IN ('in_progress','assigned')
               AND last_heartbeat IS NOT NULL AND last_heartbeat != ''
               AND last_heartbeat <= datetime('now', '-600 seconds')`).all()) {
            markFailed(r.id, "heartbeat expiré (>10min sans tick) — worker gelé ou mort (reap bridge)", 'heartbeat_timeout >600s — reconcilié par ws-bridge');
        }
        wdb.close();
    } catch (e) {
        console.error('[bridge] reconcile error:', e.message);
    }
}
setInterval(reconcileTasks, 60e3);

// ---- FR-08 : heartbeat tick 30s — wrapper des workers spawnés ----
// Tant que le pid du dernier event 'dispatched' est vivant, on rafraîchit
// tasks_todo.last_heartbeat. Un worker gelé-mais-vivant (pid OK, aucun tick
// d'output) est détecté côté reaper si le signal de vie s'arrête >10 min.
function heartbeatTick() {
    try {
        const wdb = new DatabaseSync(DB_PATH);
        const rows = wdb.prepare(
            `SELECT t.id, e.detail FROM tasks_todo t
             JOIN task_events e ON e.id = (
               SELECT MAX(id) FROM task_events
               WHERE task_id = CAST(t.id AS TEXT) AND event = 'dispatched')
             WHERE t.status IN ('in_progress','assigned')`).all();
        const beat = wdb.prepare("UPDATE tasks_todo SET last_heartbeat=datetime('now') WHERE id=?");
        for (const r of rows) {
            const m = /pid=(\d+)/.exec(r.detail || '');
            const pid = m ? parseInt(m[1], 10) : 0;
            if (!pid || !pidAlive(pid)) continue;
            // Signal de vie réel : si le dispatch a redirigé stdout vers un
            // log, le beat exige un mtime < 4 min — un pid vivant mais gelé
            // (cas worker muet) n'écrit rien et finit heartbeat_timeout.
            const lm = /log=(\S+)/.exec(r.detail || '');
            if (lm) {
                try {
                    const age = Date.now() - fs.statSync(lm[1]).mtimeMs;
                    if (age > 240e3) continue;
                } catch { /* log absent/illisible → pas de beat */ continue; }
            }
            beat.run(r.id);
        }
        wdb.close();
    } catch (e) {
        console.error('[bridge] heartbeat tick:', e.message);
    }
}
setInterval(heartbeatTick, 30e3);
heartbeatTick();

function handleProviderToggle(provider, enabled) {
    if (!provider || typeof provider !== 'string') return;
    try {
        const wdb = new DatabaseSync(DB_PATH);
        wdb.prepare('INSERT INTO provider_prefs (provider, enabled) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled')
            .run(provider, enabled ? 1 : 0);
        wdb.close();
        console.log(`[bridge] provider ${provider} -> ${enabled ? 'ON' : 'OFF'}`);
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] provider_toggle error:', err.message);
    }
}

function handleProviderOrder(order) {
    if (!Array.isArray(order)) return;
    try {
        const wdb = new DatabaseSync(DB_PATH);
        const stmt = wdb.prepare('INSERT INTO provider_prefs (provider, enabled, position) VALUES (?, 1, ?) ' +
            'ON CONFLICT(provider) DO UPDATE SET position = excluded.position');
        const tx = wdb.transaction(() => { order.forEach((p, i) => { if (typeof p === 'string') stmt.run(p, i); }); });
        tx();
        wdb.close();
        console.log(`[bridge] provider order: ${order.join(' > ')}`);
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] provider_order error:', err.message);
    }
}

function handleClearTasks(statuses) {
    const allowed = new Set(['completed', 'failed', 'pending', 'in_progress', 'cancelled']);
    const sts = statuses.filter((s) => allowed.has(s));
    if (!sts.length) return;
    try {
        const wdb = new DatabaseSync(DB_PATH);
        const res = wdb
            .prepare(`DELETE FROM tasks_todo WHERE status IN (${sts.map(() => '?').join(',')})`)
            .run(...sts);
        wdb.close();
        console.log(`[bridge] cleared ${res.changes} task(s) [${sts.join(',')}]`);
        // resynchronise les hash pour ne pas rebroadcaster les suppressions en task_update
        lastTaskHash.clear();
        for (const t of readTasks()) lastTaskHash.set(t.id, JSON.stringify(t));
        broadcast({ type: 'clear_result', deleted: res.changes, statuses: sts, ts: new Date().toISOString() });
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] clear_tasks error:', err.message);
        broadcast({ type: 'clear_result', error: err.message, ts: new Date().toISOString() });
    }
}

// Append d'un message dans le bus comms du premier workspace résolu — les
// agents abonnés au feed (et les autres sessions) sont informés des actions UI.
function appendComms(entry) {
    const target = COMMS_PATHS[0];
    if (!target) return;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, JSON.stringify(entry) + '\n');
    } catch (e) { console.error('[bridge] comms append:', e.message); }
}

function handleDeleteTask(id) {
    const tid = Number(id);
    if (!Number.isFinite(tid)) return;
    try {
        const t = db.prepare('SELECT id, title, assigned_to FROM tasks_todo WHERE id=?').get(tid);
        const wdb = new DatabaseSync(DB_PATH);
        const res = wdb.prepare('DELETE FROM tasks_todo WHERE id=?').run(tid);
        wdb.close();
        lastTaskHash.delete(tid);
        if (res.changes > 0) {
            appendComms({
                src: 'user', dst: 'broadcast',
                text: `tâche #${tid} supprimée manuellement${t ? ` — « ${String(t.title).slice(0, 80)} »` : ''}`,
                ts: new Date().toISOString(),
            });
        }
        broadcast({ type: 'task_delete', id: tid, deleted: res.changes, ts: new Date().toISOString() });
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] delete_task error:', err.message);
        broadcast({ type: 'task_delete', id: tid, error: err.message, ts: new Date().toISOString() });
    }
}

wss.on('connection', (ws, req) => {
    try {
        if (req && req.url) {
            const u = new URL(req.url, 'http://127.0.0.1');
            const idePid = u.searchParams.get('idePid');
            if (idePid) ws._idePid = idePid;
        }
    } catch { /* noop */ }
    console.log('[bridge] client connected');
    ws.send(JSON.stringify(snapshot()));
    broadcast({ type: 'client_count', count: getDistinctIdeCount() });
    ws.on('close', () => {
        broadcast({ type: 'client_count', count: getDistinctIdeCount() });
    });
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.command === 'refresh') ws.send(JSON.stringify(snapshot()));
            if (msg.command === 'provider_toggle' && typeof msg.provider === 'string') {
                handleProviderToggle(msg.provider, !!msg.enabled);
            }
            if (msg.command === 'provider_order' && Array.isArray(msg.order)) {
                handleProviderOrder(msg.order);
            }
            if (msg.command === 'clear_tasks' && Array.isArray(msg.statuses)) {
                handleClearTasks(msg.statuses);
            }
            if (msg.command === 'delete_task') {
                handleDeleteTask(msg.id);
            }
            if (msg.command === 'track_request' && typeof msg.requestId === 'string') {
                handleTrackRequest(msg);
            }
            if (msg.command === 'list_acp_sessions' && typeof msg.workspaceRoot === 'string') {
                requestAcpClient(ws, msg.requestId, 'list_acp_sessions', {
                    providerId: msg.providerId || '',
                    workspaceRoot: msg.workspaceRoot
                });
            }
            if (msg.command === 'wake_acp_agent' && msg.text && msg.sessionId && msg.providerId && typeof msg.workspaceRoot === 'string') {
                requestAcpClient(ws, msg.requestId, 'wake_acp_agent', {
                    text: String(msg.text).slice(0, 4000),
                    sessionId: String(msg.sessionId),
                    providerId: String(msg.providerId),
                    workspaceRoot: msg.workspaceRoot
                }, 15000);
            }
            if (msg.command === 'acp_sessions_result' && Array.isArray(msg.sessions)) {
                completeAcpRequest(msg.requestId, {
                    type: 'acp_sessions_result',
                    requestId: msg.requestId,
                    sessions: msg.sessions.slice(0, 200)
                });
            }
            if (msg.command === 'acp_wake_result' && typeof msg.status === 'string') {
                completeAcpRequest(msg.requestId, {
                    type: 'acp_wake_result',
                    requestId: msg.requestId,
                    status: msg.status
                });
            }
            if (msg.command === 'open_chat' && typeof msg.sessionId === 'string') {
                console.log(`[bridge] open_chat -> ${msg.sessionId}`);
                broadcast({ type: 'open_chat', sessionId: msg.sessionId, ts: new Date().toISOString() });
            }
            if (msg.command === 'wake_devin' && msg.text) {
                const targetId = msg.cascadeId || '';
                console.log(`[bridge] direct wake_devin received -> cascadeId=${targetId || 'active'}`);
                broadcast({
                    type: 'wake_devin',
                    text: msg.text,
                    cascadeId: targetId,
                    ts: new Date().toISOString()
                });
            }
            if ((msg.command === 'wake_antigravity' || msg.command === 'wake_agy') && msg.text) {
                const targetId = msg.agyCascadeId || msg.cascadeId || '';
                console.log(`[bridge] direct wake_antigravity received -> agyCascadeId=${targetId || 'active'}`);
                broadcast({
                    type: 'wake_antigravity',
                    text: msg.text,
                    agyCascadeId: targetId,
                    replyToCascadeId: msg.replyToCascadeId || '',
                    ts: new Date().toISOString()
                });
            }
        } catch { /* ignore malformed */ }
    });
    ws.on('close', () => {
        for (const [requestId, pending] of pendingAcpRequests) {
            if (pending.ws === ws) {
                clearTimeout(pending.timer);
                if (pending.settleTimer) clearTimeout(pending.settleTimer);
                pendingAcpRequests.delete(requestId);
            }
        }
        console.log('[bridge] client disconnected');
    });
    ws.on('error', (e) => console.error('[bridge] ws error:', e.message));
});

// prime hashes without broadcasting the whole history
for (const t of readTasks()) lastTaskHash.set(t.id, JSON.stringify(t));
lastAgentHash = JSON.stringify(readAgents());

setInterval(poll, POLL_INTERVAL);
console.log(`[bridge] polling every ${POLL_INTERVAL} ms`);
