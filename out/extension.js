"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.wakeDevin = wakeDevin;
exports.matchesWorkspace = matchesWorkspace;
exports.listAcpSessions = listAcpSessions;
exports.__setAcpInjectorForTests = __setAcpInjectorForTests;
exports.wakeAcpAgent = wakeAcpAgent;
exports.wakeAntigravity = wakeAntigravity;
exports.sendToDevinChat = sendToDevinChat;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const child_process_1 = require("child_process");
const OrchestratorPanel_1 = require("./panel/OrchestratorPanel");
const panelHtml_1 = require("./panel/panelHtml");
const messages_1 = require("./panel/messages");
const client_1 = require("./data/client");
let wsClient;
let bridgeProcess;
let bridgeAutoStarted = false;
let lastSnapshot = undefined;
const knownTaskStatus = new Map();
let sidebarView;
let extensionRoot = '';
let statusItem;
let wsConnected = false;
let connectedClients = 1;
let watchdogPeerActive = false;
let watchdogStartTimer;
function resolveWorkspaceRoot() {
    const folderRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folderRoot) {
        return folderRoot;
    }
    const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
    return workspaceFile ? path.dirname(workspaceFile) : undefined;
}
function queueWatchdogStart(delayMs = 1500) {
    if (watchdogStartTimer || (watchdogProcess && !watchdogProcess.killed)) {
        return;
    }
    watchdogStartTimer = setTimeout(() => {
        watchdogStartTimer = undefined;
        startWatchdog();
    }, delayMs);
    watchdogStartTimer.unref?.();
}
function checkWatchdogStatus() {
    if (watchdogProcess && !watchdogProcess.killed) {
        return { running: true, isPeer: false };
    }
    if (watchdogPeerActive) {
        return { running: true, isPeer: true };
    }
    const root = resolveWorkspaceRoot();
    if (root) {
        try {
            const statePath = path.join(root, '.agent', 'skills', 'reactive-orchestrator', 'watch-state.json');
            if (fs.existsSync(statePath)) {
                const stat = fs.statSync(statePath);
                if ((Date.now() - stat.mtimeMs) < 120000) {
                    return { running: true, isPeer: true };
                }
            }
        }
        catch { /* best-effort */ }
    }
    return { running: false, isPeer: false };
}
function updateStatus() {
    if (!statusItem) {
        return;
    }
    const ws = wsConnected ? 'WS on' : 'WS off';
    const wdInfo = checkWatchdogStatus();
    let wdText = 'WD off';
    if (wdInfo.running) {
        if (wdInfo.isPeer) {
            const count = Math.max(2, connectedClients);
            wdText = `WD on (peer x${count})`;
        }
        else if (connectedClients > 1) {
            wdText = `WD on (lead x${connectedClients})`;
        }
        else {
            wdText = 'WD on';
        }
    }
    statusItem.text = `$(pulse) HPHE ${ws} | ${wdText}`;
    statusItem.tooltip = `Hephaistos orchestrator-monitor : Bridge WebSocket (${ws}), Watchdog (${wdText}), ${connectedClients} session(s) active(s)`;
}
function activate(context) {
    extensionRoot = context.extensionPath;
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('orchestratorMonitor.tasks', new TasksWebviewProvider(context)), vscode.commands.registerCommand('orchestratorMonitor.openPanel', () => OrchestratorPanel_1.OrchestratorPanel.createOrShow(context.extensionUri)), vscode.commands.registerCommand('orchestratorMonitor.refresh', () => refresh()), vscode.commands.registerCommand('orchestratorMonitor.startBridge', () => startBridge(context)), vscode.commands.registerCommand('orchestratorMonitor.restartBridge', () => restartBridge(context)), vscode.commands.registerCommand('orchestratorMonitor.clearCompleted', () => clearTasks(['completed'])), vscode.commands.registerCommand('orchestratorMonitor.clearFailed', () => clearTasks(['failed'])), vscode.commands.registerCommand('orchestratorMonitor.clearPending', () => clearTasks(['pending'])), vscode.commands.registerCommand('orchestratorMonitor.clearTasks', (statuses) => clearTasks(statuses)), vscode.commands.registerCommand('orchestratorMonitor.clearComms', () => {
        try {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root) {
                fs.writeFileSync(path.join(root, '.agent', 'comms.jsonl'), '');
            }
        }
        catch { /* best-effort */ }
    }), vscode.commands.registerCommand('orchestratorMonitor.providerToggle', (provider, enabled) => {
        if (!wsClient) {
            vscode.window.showErrorMessage(L('bridge.off'));
            return;
        }
        wsClient.send({ command: 'provider_toggle', provider, enabled });
    }), vscode.commands.registerCommand('orchestratorMonitor.providerOrder', (order) => {
        if (!wsClient) {
            vscode.window.showErrorMessage(L('bridge.off'));
            return;
        }
        wsClient.send({ command: 'provider_order', order });
    }), vscode.commands.registerCommand('orchestratorMonitor.deleteTask', (id) => {
        if (!wsClient) {
            vscode.window.showErrorMessage(L('bridge.off'));
            return;
        }
        wsClient.send({ command: 'delete_task', id });
    }), vscode.commands.registerCommand('orchestratorMonitor.sendToChat', (text, label) => sendToDevinChat(text, label)), vscode.commands.registerCommand('orchestratorMonitor.panelReady', () => {
        forwardToWebviews({ type: 'config', lang: vscode.env.language });
        if (lastSnapshot) {
            forwardToWebviews(lastSnapshot);
        }
    }), vscode.commands.registerCommand('orchestratorMonitor.dumpSessionCommands', async () => {
        // Diagnostic local : liste les commandes enregistrées liées aux
        // sessions/chat dans .agent/commands-dump.json (rien n'est envoyé).
        const cmds = await vscode.commands.getCommands(true);
        const hits = cmds.filter((c) => /session|prompt|cascade|acp/i.test(c)).sort();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
        const out = path.join(root, '.agent', 'commands-dump.json');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(hits, null, 1));
        commsLog('orchestrator', 'devin', 'diagnostic', `dump ${hits.length} commandes session -> ${out}`);
        vscode.window.showInformationMessage(`dump: ${hits.length} commandes -> ${out}`);
    }), vscode.commands.registerCommand('orchestratorMonitor.joinBinome', () => runBinome('join')), vscode.commands.registerCommand('orchestratorMonitor.rejoinPair', () => runBinome('pair')), vscode.commands.registerCommand('orchestratorMonitor.pairStatus', () => pairStatus()));
    const wsRoot0 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    wsClient = new client_1.OrchestratorWS('ws://127.0.0.1:7477', wsRoot0 ? path.join(wsRoot0, '.agent', 'ws-bridge.token') : undefined);
    wsClient.on('connected', () => {
        wsConnected = true;
        updateStatus();
        forwardToWebviews({ type: 'ws_status', connected: true });
        refresh();
    });
    wsClient.on('disconnected', () => {
        wsConnected = false;
        updateStatus();
        forwardToWebviews({ type: 'ws_status', connected: false });
        if (!bridgeAutoStarted) {
            bridgeAutoStarted = true;
            startBridge(context);
        }
    });
    wsClient.on('message', (msg) => {
        if (msg?.type === 'list_acp_sessions' && typeof msg.requestId === 'string') {
            if (!matchesWorkspace(msg.workspaceRoot))
                return;
            void listAcpSessions(msg.providerId || undefined)
                .then((sessions) => wsClient?.send({ command: 'acp_sessions_result', requestId: msg.requestId, sessions }))
                .catch(() => wsClient?.send({ command: 'acp_sessions_result', requestId: msg.requestId, sessions: [] }));
            return;
        }
        if (msg?.type === 'wake_acp_agent' && typeof msg.requestId === 'string') {
            if (!matchesWorkspace(msg.workspaceRoot))
                return;
            void wakeAcpAgent(String(msg.text || ''), String(msg.sessionId || ''), String(msg.providerId || ''), { draft: msg.draft === true })
                .then((status) => wsClient?.send({ command: 'acp_wake_result', requestId: msg.requestId, status }))
                .catch(() => wsClient?.send({ command: 'acp_wake_result', requestId: msg.requestId, status: 'failed' }));
            return;
        }
        if (msg && msg.type === 'client_count') {
            connectedClients = Number(msg.count) || 1;
            updateStatus();
        }
        if (msg && msg.type === 'snapshot') {
            lastSnapshot = msg;
            if (typeof msg.client_count === 'number') {
                connectedClients = msg.client_count;
            }
            updateStatus();
            for (const t of msg.tasks ?? []) {
                knownTaskStatus.set(t.id, t.status);
            }
        }
        if (msg && msg.type === 'task_update' && msg.task) {
            const prev = knownTaskStatus.get(msg.task.id);
            knownTaskStatus.set(msg.task.id, msg.task.status);
            if (prev !== msg.task.status) {
                onTaskTerminalWake(msg.task);
            }
        }
        if (msg && msg.type === 'wake_devin' && msg.text) {
            wakeDevin(msg.text, msg.cascadeId || undefined);
        }
        if (msg && msg.type === 'wake_antigravity' && msg.text) {
            wakeAntigravity(msg.text, msg.agyCascadeId || undefined, msg.replyToCascadeId || undefined);
        }
        if (msg && msg.type === 'clear_result') {
            if (msg.error) {
                vscode.window.showErrorMessage(L('purge.err', { err: msg.error }));
            }
            else {
                vscode.window.showInformationMessage(L('purge.ok', { n: String(msg.deleted) }));
            }
        }
        forwardToWebviews(msg);
    });
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!watchdogProcess || watchdogProcess.killed) {
            if (watchdogStartTimer) {
                clearTimeout(watchdogStartTimer);
                watchdogStartTimer = undefined;
            }
            startWatchdog();
        }
    }));
    wsClient.connect();
    startWatchdog();
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.command = 'orchestratorMonitor.openPanel';
    updateStatus();
    statusItem.show();
    context.subscriptions.push(statusItem);
    context.subscriptions.push({ dispose: () => deactivate() });
}
function forwardToWebviews(msg) {
    OrchestratorPanel_1.OrchestratorPanel.currentPanel?.postMessageToWebview(msg);
    sidebarView?.webview.postMessage(msg);
}
function refresh() {
    if (wsClient) {
        wsClient.send({ command: 'refresh' });
    }
    if (lastSnapshot) {
        forwardToWebviews(lastSnapshot);
    }
}
/* ===== Chaînes localisées côté extension (toasts, confirmations) ===== */
const EXT_STRINGS = {
    fr: {
        'purge.confirm': "Supprimer définitivement les tâches {list} de l'orchestrateur ?",
        'purge.ok': '{n} tâche(s) purgée(s).', 'purge.err': 'Purge impossible : {err}',
        'purge.btn': 'Supprimer', 'status.completed': 'terminées', 'status.failed': 'échouées',
        'status.pending': 'en attente', 'status.in_progress': 'en cours', 'status.and': ' et ',
        'bridge.off': 'Bridge non connecté.', 'chat.sent': '{label} envoyé dans le chat Devin.',
        'chat.failed': 'Injection impossible — commande Devin indisponible ({label}).', 'chat.default': 'Texte'
    },
    en: {
        'purge.confirm': 'Permanently delete {list} tasks from the orchestrator?',
        'purge.ok': '{n} task(s) purged.', 'purge.err': 'Purge failed: {err}',
        'purge.btn': 'Delete', 'status.completed': 'completed', 'status.failed': 'failed',
        'status.pending': 'pending', 'status.in_progress': 'in progress', 'status.and': ' and ',
        'bridge.off': 'Bridge not connected.', 'chat.sent': '{label} sent to the Devin chat.',
        'chat.failed': 'Injection failed — Devin command unavailable ({label}).', 'chat.default': 'Text'
    },
    de: {
        'purge.confirm': '{list} Aufgaben endgültig aus dem Orchestrator löschen?',
        'purge.ok': '{n} Aufgabe(n) gelöscht.', 'purge.err': 'Löschen fehlgeschlagen: {err}',
        'purge.btn': 'Löschen', 'status.completed': 'abgeschlossene', 'status.failed': 'fehlgeschlagene',
        'status.pending': 'wartende', 'status.in_progress': 'laufende', 'status.and': ' und ',
        'bridge.off': 'Bridge nicht verbunden.', 'chat.sent': '{label} an den Devin-Chat gesendet.',
        'chat.failed': 'Injection fehlgeschlagen — Devin-Befehl nicht verfügbar ({label}).', 'chat.default': 'Text'
    },
    es: {
        'purge.confirm': '¿Eliminar permanentemente las tareas {list} del orquestador?',
        'purge.ok': '{n} tarea(s) purgada(s).', 'purge.err': 'Error de purga: {err}',
        'purge.btn': 'Eliminar', 'status.completed': 'completadas', 'status.failed': 'fallidas',
        'status.pending': 'en espera', 'status.in_progress': 'en curso', 'status.and': ' y ',
        'bridge.off': 'Bridge no conectado.', 'chat.sent': '{label} enviado al chat de Devin.',
        'chat.failed': 'Inyección fallida — comando Devin no disponible ({label}).', 'chat.default': 'Texto'
    }
};
function uiLang() {
    const l = (vscode.env.language || 'en').split('-')[0].toLowerCase();
    return EXT_STRINGS[l] ? l : 'en';
}
function L(key, vars) {
    let s = EXT_STRINGS[uiLang()][key] || EXT_STRINGS.en[key] || key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            s = s.replace(`{${k}}`, v);
        }
    }
    return s;
}
async function clearTasks(statuses) {
    const human = statuses.map((s) => L('status.' + s)).join(L('status.and'));
    const btn = L('purge.btn');
    const choice = await vscode.window.showWarningMessage(L('purge.confirm', { list: human }), { modal: true }, btn);
    if (choice !== btn) {
        return;
    }
    if (!wsClient) {
        vscode.window.showErrorMessage(L('bridge.off'));
        return;
    }
    wsClient.send({ command: 'clear_tasks', statuses });
}
/* ===== Encodage protobuf minimal pour l'injection chat =====
 * Noms ci-dessous = identifiants internes du protocole fil de Devin
 * (exa.codeium_common_pb / exa.chat_client_server_pb / exa.language_server_pb).
 * Ils sont obligatoires tels quels — ce ne sont PAS des agents ni du vocabulaire
 * métier : juste le schéma binaire attendu par devin.sendChatActionMessage.
 *   TextOrScopeItem { no:1 text:string (oneof chunk) }
 *   AddCascadeInputRequest { no:1 items:[TextOrScopeItem] }   ← draft
 *   SendCascadeInputRequest { no:1 items:[TextOrScopeItem] }  ← envoi réel
 *   SendActionToChatPanelRequest { no:1 action_type, no:2 payload:bytes[] }
 */
function encodeVarint(n) {
    const out = [];
    while (n > 0x7f) {
        out.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
}
function lenField(fieldNo, data) {
    return Buffer.concat([
        Buffer.from([(fieldNo << 3) | 2]),
        Buffer.from(encodeVarint(data.length)),
        data
    ]);
}
function buildChatInputPayload(text) {
    const item = lenField(1, Buffer.from(text, 'utf8')); // TextOrScopeItem{text}
    const request = lenField(1, item); // {items} — même schéma pour les actions draft et send
    return request.toString('base64');
}
/**
 * La cascade actuellement active côté utilisateur — source fiable :
 * windsurf.acp.sessioninfo.session.* dans le globalStorage Devin
 * (info.updatedAt = dernière interaction utilisateur réelle).
 * Fallback : .pb le plus récent (bruité par les writes de fond).
 */
const DRAFT_TITLES_EXT = new Set(['Awaiting User\'s Request', 'New Cascade', '']);
function activeCascadeId() {
    // 1) globalStorage sessioninfo (updatedAt = activité utilisateur réelle)
    try {
        const { DatabaseSync } = require('node:sqlite');
        const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const dbPath = path.join(appdata, 'Devin', 'User', 'globalStorage', 'state.vscdb');
        if (fs.existsSync(dbPath)) {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            try {
                const rows = db.prepare("SELECT value FROM ItemTable WHERE key LIKE 'windsurf.acp.sessioninfo.session.%'").all();
                let best = '';
                let bestTs = '';
                // 'cascade' = convs classiques ; 'devin-cli' = sessions agent
                // Devin Desktop (acp/devin-cli/*) — la vraie fenêtre utilisateur.
                for (const r of rows) {
                    try {
                        const p = JSON.parse(r.value);
                        if (p.providerId !== 'cascade' && p.providerId !== 'devin-cli')
                            continue;
                        // Drafts vides = ids éphémères : sendCascadeInput les
                        // matérialise sous un nouvel id (fenêtre parasite).
                        if (DRAFT_TITLES_EXT.has(p.info?.title || ''))
                            continue;
                        // devin-cli sans message utilisateur = sessions spawnées
                        // (sub-agents/daemons), jamais la fenêtre utilisateur.
                        const meta = p.info?._meta || {};
                        if (p.providerId === 'devin-cli' &&
                            typeof meta['cognition.ai/userMessageCount'] === 'number' &&
                            meta['cognition.ai/userMessageCount'] === 0)
                            continue;
                        const id = p.info?.sessionId || '';
                        const ts = p.info?.updatedAt || '';
                        if (id && ts > bestTs) {
                            bestTs = ts;
                            best = id;
                        }
                    }
                    catch { /* skip */ }
                }
                if (best) {
                    return best;
                }
            }
            finally {
                db.close();
            }
        }
    }
    catch { /* node:sqlite absent / DB verrouillée → fallback */ }
    // 2) fallback : .pb le plus récent
    try {
        const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
        const files = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.pb') && !f.endsWith('.archived'));
        let newest = '';
        let newestM = -1;
        for (const f of files) {
            const m = fs.statSync(path.join(dir, f)).mtimeMs;
            if (m > newestM) {
                newestM = m;
                newest = f;
            }
        }
        return newest.replace(/\.pb$/, '');
    }
    catch {
        return '';
    }
}
/** La conversation <cascadeId> est-elle déjà celle affichée ? */
function isActiveCascade(cascadeId) {
    return activeCascadeId() === cascadeId;
}
function cascadeExists(cascadeId) {
    try {
        return fs.existsSync(path.join(os.homedir(), '.codeium', 'windsurf', 'cascade', `${cascadeId}.pb`));
    }
    catch {
        return false;
    }
}
/** Session ACP (devin-cli) connue dans sessioninfo ? (pas de .pb pour les acp/*) */
function acpSessionExists(sessionId) {
    try {
        const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const dbPath = path.join(appdata, 'Devin', 'User', 'globalStorage', 'state.vscdb');
        if (!fs.existsSync(dbPath)) {
            return false;
        }
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(`windsurf.acp.sessioninfo.session.${sessionId}`);
            return !!row;
        }
        finally {
            db.close();
        }
    }
    catch {
        return false;
    }
}
function sessionExists(id) {
    return id.startsWith('acp/') ? acpSessionExists(id) : cascadeExists(id);
}
/**
 * Réveil réel : soumet un message au chat Devin (nouveau tour), pas un brouillon.
 *
 * Sémantique réelle des actions (décodée du client chat bundle) :
 *   - sendCascadeInput soumet le composer du webview AFFICHÉ — le proto
 *     SendCascadeInputRequest n'a PAS de champ cascadeId.
 *   - setCascadeId = tCy({type:"cascade"}) + t35("cascade") : le même chemin
 *     qu'un clic utilisateur dans le sélecteur — switch in-place, no-op si la
 *     conv est déjà affichée. NE MARCHE QUE pour les sessions 'cascade'
 *     (uuid .pb) — le type est câblé "cascade".
 *   - explainAndFixProblem : route ACP. Son payload est UN TextOrScopeItem
 *     brut (field1 = texte UTF-8, PAS de wrapper SendCascadeInputRequest) ;
 *     le handler le mappe puis appelle session/prompt — livré comme vrai
 *     message utilisateur dans la session ACP focalisée ('lastActive').
 *   - markCascadeIdActive ne fait qu'un timestamp de récence : ne route rien.
 *
 * IMPORTANT : la conv utilisateur dans Devin Desktop est une session
 * 'devin-cli' (ACP), PAS une session 'cascade' — le resolver current-cascade
 * accepte les deux. Réveiller un cascadeId pendant que l'utilisateur vit dans
 * une session acp = message rendu dans une autre fenêtre (bug v44–v48).
 *
 * opts.noFocus (wakes de tâches) : n'injecter QUE si la cible est déjà la conv
 * active — une notification de fond ne doit jamais voler le focus.
 */
async function wakeDevin(text, cascadeId, opts) {
    const payload = buildChatInputPayload(text);
    // Cible explicite conservée telle quelle : un message adressé à X ne doit
    // jamais être rerouté vers Y. Sans cible : conv la plus récemment active.
    const target = cascadeId || activeCascadeId();
    if (!target) {
        commsLog('orchestrator', 'devin', 'wake-noroute', text, cascadeId);
        return 'skipped';
    }
    if (target.startsWith('acp/')) {
        // Session ACP (devin-cli) : l'action explainAndFixProblem route sur la
        // session focalisée — on n'envoie que si la cible est bien la session
        // ACP focalisée ET connue (providerId 'devin-cli'). Si le focus est sur
        // une autre session, on ouvre l'onglet de la cible par son URI
        // (vscode-cascade-editor:///cascade-<sessionId>) : switch vers l'onglet
        // existant, pas de nouvelle conversation. Jamais de fallback
        // toast/presse-papier. L'acceptation de la commande = soumission prise
        // en compte, pas une preuve de livraison au provider.
        try {
            const getAcp = async () => (await vscode.commands.executeCommand('workbench.action.getAcpState'))?.reduxStore?.acp;
            let acp = await getAcp();
            const known = () => Array.isArray(acp?.sessions) && acp.sessions.some((s) => s.sessionId === target && s.providerId === 'devin-cli');
            if (acp && acp.focusedSessionId !== target && known()) {
                const before = acp.focusedSessionId;
                // Réutiliser la surface EXISTANTE de la session, jamais en ouvrir
                // une nouvelle : (1) onglet éditeur cascade déjà ouvert →
                // tabGroups.activate, (2) sinon session affichée dans le panneau
                // chat → openCascadeIdInChatPanel en dernier recours.
                // Réutiliser la surface EXISTANTE de la session : onglet cascade
                // déjà ouvert → vscode.open sur son URI (même URI = même onglet,
                // focus sans nouvelle fenêtre). openCascadeIdInChatPanel n'est
                // qu'un dernier recours — il duplique une vue panneau.
                let focusVia = 'vscode.open';
                const cascadeUri = `vscode-cascade-editor:///cascade-${target}`;
                try {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(cascadeUri), { preview: false });
                }
                catch { /* ignore */ }
                await new Promise((r) => setTimeout(r, 600));
                acp = await getAcp();
                if (acp?.focusedSessionId !== target) {
                    focusVia = 'openCascadeIdInChatPanel';
                    try {
                        await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                            actionType: 'openCascadeIdInChatPanel',
                            payload: [Buffer.from(target, 'utf8').toString('base64')],
                        }));
                    }
                    catch { /* ignore */ }
                    await new Promise((r) => setTimeout(r, 600));
                    acp = await getAcp();
                }
                commsLog('orchestrator', 'devin', 'wake-acp-focus', `${before} -> ${acp?.focusedSessionId ?? '?'} via ${focusVia}`, target);
            }
            else if (acp && acp.focusedSessionId !== target) {
                commsLog('orchestrator', 'devin', 'wake-acp-focus', `cible inconnue dans acp.sessions (focus=${acp.focusedSessionId}, n=${acp.sessions?.length ?? 0})`, target);
            }
            if (acp?.focusedSessionId !== target || !known()) {
                commsLog('orchestrator', 'devin', 'wake-noroute', `${text} (session ACP cible non focalisée ou inconnue ; focus=${acp?.focusedSessionId ?? 'absent'})`, target);
                return 'skipped';
            }
            await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                actionType: 'explainAndFixProblem',
                payload: [lenField(1, Buffer.from(text, 'utf8')).toString('base64')],
            }));
            commsLog('orchestrator', 'devin', 'wake-acp-submitted', text, target);
            return 'sent';
        }
        catch (error) {
            commsLog('orchestrator', 'devin', 'wake-failed', `${text} (${error?.message || error})`, target);
            return 'failed';
        }
    }
    if (!sessionExists(target)) {
        commsLog('orchestrator', 'devin', 'wake-noroute', text, target);
        return 'skipped';
    }
    if (opts?.noFocus && !isActiveCascade(target)) {
        commsLog('orchestrator', 'devin', 'wake', `${text} (non actif)`, target);
        return 'skipped';
    }
    // setCascadeId : sélectionne la conv dans la surface chat (comme un clic
    // dans le picker). Idempotent — si la conv est déjà affichée, no-op.
    // Un draft affiché est remplacé par la vraie conv, jamais soumis.
    try {
        await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
            actionType: 'setCascadeId',
            payload: [Buffer.from(target, 'utf8').toString('base64')],
        }));
        await new Promise((r) => setTimeout(r, 400));
    }
    catch {
        commsLog('orchestrator', 'devin', 'wake-noroute', `${text} (setCascadeId a échoué)`, target);
        return 'skipped';
    }
    try {
        await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({ actionType: 'sendCascadeInput', payload: [payload] }));
        commsLog('orchestrator', 'devin', 'wake', text, target);
        return 'sent';
    }
    catch {
        commsLog('orchestrator', 'devin', 'wake-failed', text, cascadeId);
        return 'failed';
    }
}
function matchesWorkspace(requested) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (typeof requested !== 'string' || !requested || !root)
        return false;
    return path.resolve(requested).toLowerCase() === path.resolve(root).toLowerCase();
}
function enabledAcpProviders() {
    try {
        return vscode.workspace.getConfiguration('devin.acp').get('enabledAgents', {}) || {};
    }
    catch {
        return {};
    }
}
async function listAcpSessions(providerId) {
    if (providerId === 'antigravity-acp' || providerId === 'agy') {
        const hub = agyHub();
        if (hub) {
            try {
                const res = await agyRpc(hub, 'ListCascades', {});
                const cascades = res?.cascades || [];
                const activeId = await getActiveAgyCascade(hub);
                return cascades.map((c) => ({
                    sessionId: `acp/antigravity-acp/${c.cascadeId}`,
                    providerId: 'antigravity-acp',
                    focused: c.cascadeId === activeId
                }));
            }
            catch { /* best effort */ }
        }
    }
    const acp = (await vscode.commands.executeCommand('workbench.action.getAcpState'))?.reduxStore?.acp;
    if (!Array.isArray(acp?.sessions))
        return [];
    const enabled = enabledAcpProviders();
    return acp.sessions
        .filter((session) => typeof session?.sessionId === 'string' &&
        typeof session?.providerId === 'string' &&
        (enabled[session.providerId] === true || (session.providerId === 'devin-cli' && enabled['devin-cli'] !== false)) &&
        (!providerId || session.providerId === providerId))
        .map((session) => ({
        sessionId: session.sessionId,
        providerId: session.providerId,
        focused: acp.focusedSessionId === session.sessionId
    }));
}
let acpInjectorForTests;
function __setAcpInjectorForTests(mod) {
    acpInjectorForTests = mod;
}
function getAcpInjector() {
    if (acpInjectorForTests !== undefined)
        return acpInjectorForTests;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const candidates = [
        wsRoot ? path.join(wsRoot, '.agent', 'agent-bridge', 'acp-inject.js') : '',
        path.join(__dirname, '..', 'agent-bridge', 'acp-inject.js'),
        extensionRoot ? path.join(extensionRoot, 'agent-bridge', 'acp-inject.js') : ''
    ];
    for (const candidate of candidates) {
        if (!candidate || !fs.existsSync(candidate))
            continue;
        try {
            return require(candidate);
        }
        catch { /* essaie le suivant */ }
    }
    return null;
}
async function wakeAcpAgent(text, target, providerId, opts) {
    if (!text || !target || !providerId)
        return 'skipped';
    if (providerId === 'antigravity-acp' || providerId === 'agy') {
        const cascadeId = target.replace(/^acp\/[^/]+\//, '');
        if (opts?.draft) {
            // Draft (pointage ⌖) : JAMAIS de soumission ni de SendUserCascadeMessage !
            // Insérer dans le composer lexical d'Antigravity via la commande officielle antigravity.addContext
            try {
                await vscode.commands.executeCommand('antigravity.addContext', text);
                commsLog('orchestrator', providerId, 'wake-acp-draft', text, cascadeId);
                return 'sent';
            }
            catch (err) {
                commsLog('orchestrator', providerId, 'wake-acp-failed', `antigravity.addContext échoué: ${String(err?.message || err)}`, cascadeId);
                return 'failed';
            }
        }
        const res = await wakeAntigravity(text, cascadeId);
        commsLog('orchestrator', providerId, 'wake-acp-submitted', `Message injecte dans Antigravity (${cascadeId})`, target);
        return res === 'sent' ? 'sent' : 'failed';
    }
    if (opts?.draft && providerId !== 'devin-cli') {
        commsLog('orchestrator', providerId, 'wake-acp-draft-unsupported', `draft non supporte pour ${providerId}`, target);
        return 'skipped';
    }
    // Route ACP tierce (ex: opencode, hermes, kilo, etc.) :
    // Injection dédiée via acp-inject.js — jamais devin.sendChatActionMessage,
    // jamais vscode-cascade-editor/openCascadeIdInChatPanel, jamais session/new.
    // Provider non mappé ou module absent = refus fail-closed (skipped).
    if (providerId !== 'devin-cli') {
        const enabled = enabledAcpProviders();
        if (enabled[providerId] !== true) {
            commsLog('orchestrator', providerId, 'wake-acp-disabled', `provider ACP ${providerId} non activé`, target);
            return 'skipped';
        }
        try {
            const getAcp = async () => (await vscode.commands.executeCommand('workbench.action.getAcpState'))?.reduxStore?.acp;
            const acp = await getAcp();
            const known = Array.isArray(acp?.sessions) &&
                acp.sessions.some((session) => session.sessionId === target && session.providerId === providerId);
            if (!known) {
                commsLog('orchestrator', providerId, 'wake-acp-unknown', `session ${target} introuvable pour le provider ${providerId}`, target);
                return 'skipped';
            }
        }
        catch { /* best-effort */ }
        const injector = getAcpInjector();
        if (!injector?.providerCommand?.(providerId)) {
            commsLog('orchestrator', providerId, 'wake-acp-unsupported', `refus fail-closed : provider ACP ${providerId} non injectable (aucune commande stdio connue)`, target);
            return 'skipped';
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            commsLog('orchestrator', providerId, 'wake-acp-unsupported', 'workspace root absent — cwd ACP indéterminé', target);
            return 'skipped';
        }
        try {
            const res = await injector.inject({ providerId, sessionId: target, text, cwd, wait: 'delivered' });
            commsLog('orchestrator', providerId, 'wake-acp-submitted', `ACP prompt livré via stdio (${res?.via ?? 'session/load+prompt'})`, target);
            return 'sent';
        }
        catch (error) {
            commsLog('orchestrator', providerId, 'wake-acp-failed', String(error?.message || error), target);
            return 'failed';
        }
    }
    // Route native devin-cli (l'agent Devin lui-même via ACP, démontrée sûre)
    const enabled = enabledAcpProviders();
    if (enabled['devin-cli'] === false) {
        commsLog('orchestrator', providerId, 'wake-acp-disabled', 'provider devin-cli désactivé', target);
        return 'skipped';
    }
    // Normalisation : le roster envoie parfois le slug nu ('sugary-shoemaker')
    // alors que acp.sessions et focusedSessionId utilisent l'id complet
    // ('acp/devin-cli/sugary-shoemaker'). Sans ça : wake-acp-unknown + FIFO.
    if (!target.includes('/'))
        target = `acp/${providerId}/${target}`;
    try {
        const getAcp = async () => (await vscode.commands.executeCommand('workbench.action.getAcpState'))?.reduxStore?.acp;
        let acp = await getAcp();
        const known = () => Array.isArray(acp?.sessions) &&
            acp.sessions.some((session) => session.sessionId === target && session.providerId === 'devin-cli');
        if (!known()) {
            commsLog('orchestrator', providerId, 'wake-acp-unknown', `session devin-cli ${target} inconnue — message conservé en FIFO`, target);
            queueAcpFallback(target, text);
            return 'skipped';
        }
        if (opts?.draft) {
            // Draft (pointage ⌖) : préfill du composer, JAMAIS d'envoi ni de
            // vscode.open (qui duplique l'onglet cascade). Si la cible n'est
            // pas focalisée on épingle sa vue panneau existante ; sinon on
            // renonce plutôt que d'ouvrir quoi que ce soit.
            if (acp.focusedSessionId !== target) {
                try {
                    await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                        actionType: 'openCascadeIdInChatPanel',
                        payload: [Buffer.from(target, 'utf8').toString('base64')],
                    }));
                }
                catch { /* ignore */ }
                await new Promise((r) => setTimeout(r, 700));
                acp = await getAcp();
            }
            if (acp?.focusedSessionId !== target) {
                commsLog('orchestrator', providerId, 'wake-acp-noroute', `draft : cible non focalisee (focus=${acp?.focusedSessionId ?? 'absent'})`, target);
                return 'skipped';
            }
            await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                actionType: 'addCascadeInput',
                payload: [buildChatInputPayload(text)],
            }));
            commsLog('orchestrator', providerId, 'wake-acp-draft', text, target);
            return 'sent';
        }
        if (acp.focusedSessionId !== target) {
            const before = acp.focusedSessionId;
            // Réutiliser la fenêtre EXISTANTE de la session, jamais de doublon :
            // (1) si un onglet cascade-editor est déjà ouvert pour la cible →
            // vscode.open sur la même URI (même URI = même onglet, focus pur) ;
            // (2) sinon → openCascadeIdInChatPanel pour l'ouvrir puis injecter.
            const cascadeUri = `vscode-cascade-editor:///cascade-${target}`;
            const tabExists = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => {
                const input = t.input;
                return input?.uri?.toString?.() === cascadeUri;
            }));
            let focusVia = tabExists ? 'vscode.open' : 'openCascadeIdInChatPanel';
            if (tabExists) {
                try {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(cascadeUri), { preview: false });
                }
                catch { /* ignore */ }
                await new Promise((r) => setTimeout(r, 800));
                acp = await getAcp();
            }
            if (acp?.focusedSessionId !== target) {
                if (!tabExists)
                    focusVia = 'openCascadeIdInChatPanel';
                try {
                    await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                        actionType: 'openCascadeIdInChatPanel',
                        payload: [Buffer.from(target, 'utf8').toString('base64')],
                    }));
                }
                catch { /* ignore */ }
                await new Promise((r) => setTimeout(r, 800));
                acp = await getAcp();
                if (acp?.focusedSessionId !== target && !tabExists) {
                    focusVia = 'vscode.open';
                    try {
                        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(cascadeUri), { preview: false });
                    }
                    catch { /* ignore */ }
                    await new Promise((r) => setTimeout(r, 800));
                    acp = await getAcp();
                }
            }
            commsLog('orchestrator', providerId, 'wake-acp-focus', `${before ?? '?'} -> ${acp?.focusedSessionId ?? '?'} via ${focusVia}`, target);
        }
        else {
            // redux.focusedSessionId peut valoir `target` alors que le panneau chat
            // sert une autre fenêtre — on épingle quand même le panneau sur la
            // cible avant le submit (idempotent).
            try {
                await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                    actionType: 'openCascadeIdInChatPanel',
                    payload: [Buffer.from(target, 'utf8').toString('base64')],
                }));
            }
            catch { /* ignore */ }
            await new Promise((r) => setTimeout(r, 500));
        }
        if (acp?.focusedSessionId !== target || !known()) {
            commsLog('orchestrator', providerId, 'wake-acp-noroute', `session devin-cli non focalisée ou inconnue (focus=${acp?.focusedSessionId ?? 'absent'}) — message conservé en FIFO`, target);
            queueAcpFallback(target, text);
            return 'skipped';
        }
        await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
            actionType: 'explainAndFixProblem',
            payload: [lenField(1, Buffer.from(text, 'utf8')).toString('base64')]
        }));
        // Post-vérif : si le focus a dérivé juste après le submit, le prompt a pu
        // atterrir dans la mauvaise fenêtre → copie FIFO de la vraie cible.
        await new Promise((r) => setTimeout(r, 900));
        const after = await getAcp();
        if (after?.focusedSessionId && after.focusedSessionId !== target) {
            queueAcpFallback(target, text);
            commsLog('orchestrator', providerId, 'wake-acp-misroute', `focus dérivé vers ${after.focusedSessionId} après submit — copie FIFO`, target);
            return 'sent';
        }
        commsLog('orchestrator', providerId, 'wake-acp-submitted', 'ACP prompt submitted', target);
        return 'sent';
    }
    catch (error) {
        commsLog('orchestrator', providerId, 'wake-acp-failed', String(error?.message || error), target);
        return 'failed';
    }
}
/**
 * Copie de secours dans la FIFO de la cible (.agent/queue/<session>.jsonl) —
 * même format que agent-bridge/message-queue.js. Garantit qu'un prompt non
 * livré en direct n'est jamais perdu : la session le dépile à son prochain tour.
 */
function queueAcpFallback(sessionId, text) {
    try {
        const root = resolveWorkspaceRoot();
        if (!root) {
            return;
        }
        const dir = path.join(root, '.agent', 'queue');
        fs.mkdirSync(dir, { recursive: true });
        const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_').slice(0, 120);
        fs.appendFileSync(path.join(dir, `${safe}.jsonl`), JSON.stringify({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            ts: new Date().toISOString(),
            src: 'orchestrator',
            dst: sessionId.split('/').pop() || sessionId,
            sessionId,
            transport: 'acp',
            text: String(text ?? ''),
            kind: 'prompt'
        }) + '\n');
    }
    catch { /* la file est best-effort, jamais bloquante */ }
}
const CASCADE_TAG = /(?:(?<![a-z])cascade|conv)[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const AGY_CASCADE_TAG = /agycascade[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/* ===== Bus comms inter-agents (feed temps réel du panneau) =====
 * Append-only JSONL : <workspace>/.agent/comms.jsonl — même format que
 * extensions/agent-ws-bridge/comms.js ; le ws-bridge tail et broadcast.
 */
function commsLog(src, dst, kind, text, convId, taskId) {
    try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            return;
        }
        const p = path.join(root, '.agent', 'comms.jsonl');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify({
            ts: new Date().toISOString(), src, dst, kind,
            text: String(text ?? '').slice(0, 4000),
            ...(convId ? { convId } : {}),
            ...(taskId !== undefined ? { taskId } : {})
        }) + '\n');
    }
    catch { /* le feed est best-effort */ }
}
// Fallback FR-11 : quand l'extension google-antigravity n'exporte pas
// { csrfToken, port } (API non exposee ou extension inactive), on lit la
// cmdline du process `agy.exe --hub --hub-port=<P> --csrf_token=<T>` via
// spawn(argv) — jamais de shell string.
function agyHubFromProcess() {
    if (process.platform !== 'win32') {
        return undefined;
    }
    try {
        const out = (0, child_process_1.execFileSync)('powershell', [
            '-NoProfile', '-Command',
            "(Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | " +
                "Where-Object { $_.CommandLine -match '--hub-port' } | " +
                "Select-Object -First 1 | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine })"
        ], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
        const pidRaw = out.split('|')[0];
        const cl = out.slice(pidRaw.length + 1);
        const port = /--hub-port[ =]"?(\d+)/.exec(cl)?.[1];
        let tok = /--csrf_token[ =]"?([A-Za-z0-9_-]+)/.exec(cl)?.[1];
        // agy ≥ daemon : le jeton a quitté la cmdline pour
        // ~/.gemini/<app_data_dir>/daemon/hub_<port>.json (pid contrôlé).
        if (port && !tok) {
            try {
                const appDir = /--app_data_dir[ =]"?([^\s"]+)/.exec(cl)?.[1] || 'antigravity';
                const metaPath = path.join(os.homedir(), '.gemini', appDir, 'daemon', `hub_${port}.json`);
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (String(meta.pid) === pidRaw && meta.csrfToken)
                    tok = meta.csrfToken;
            }
            catch { /* daemon file absent */ }
        }
        if (port && tok) {
            return { port: Number(port), csrfToken: tok };
        }
    }
    catch { /* hub introuvable */ }
    return undefined;
}
function agyHub() {
    const ext = vscode.extensions.getExtension('google.google-antigravity');
    const api = ext?.exports;
    if (api?.csrfToken && api?.port) {
        return { port: api.port, csrfToken: api.csrfToken };
    }
    return agyHubFromProcess();
}
function agyRpc(hub, method, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: hub.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-codeium-csrf-token': hub.csrfToken,
                'connect-protocol-version': '1'
            },
            timeout: timeoutMs
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                try {
                    const j = d ? JSON.parse(d) : {};
                    if (res.statusCode !== 200 || j.code) {
                        reject(new Error(`${method}: ${res.statusCode} ${d.slice(0, 300)}`));
                    }
                    else {
                        resolve(j);
                    }
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`${method}: timeout`)); });
        req.end(JSON.stringify(body || {}));
    });
}
let agyModelCache;
async function agyDefaultModel(hub) {
    if (agyModelCache !== undefined) {
        return agyModelCache;
    }
    try {
        const d = await agyRpc(hub, 'GetCascadeModelConfigData', {});
        agyModelCache = (d?.defaultOverrideModelConfig?.modelOrAlias?.model
            ?? (d?.clientModelConfigs || []).find((c) => !c.disabled)?.modelOrAlias?.model
            ?? null);
    }
    catch {
        agyModelCache = null;
    }
    return agyModelCache;
}
async function getActiveAgyCascade(hub) {
    try {
        const r = await agyRpc(hub, 'GetAllCascadeTrajectories', {});
        const list = Object.entries(r.trajectorySummaries || {}).map(([id, m]) => ({
            id, updated: m.lastModifiedTime || m.createdTime || ''
        }));
        if (!list.length)
            return null;
        list.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());
        return list[0].id;
    }
    catch {
        return null;
    }
}
/**
 * Injecte un message dans la conversation Antigravity active (ou ciblée).
 * Si `replyToCascadeId` (Devin) est fourni, attend la fin de l'exécution
 * puis renvoie la réponse de l'agent dans cette conversation Devin.
 */
async function wakeAntigravity(text, agyCascadeId, replyToCascadeId) {
    const hub = agyHub();
    if (!hub) {
        return 'failed';
    }
    try {
        let targetId = agyCascadeId;
        if (!targetId) {
            targetId = (await getActiveAgyCascade(hub)) || undefined;
        }
        if (!targetId) {
            return 'failed';
        }
        if (process.env.AGY_FOCUS === '1') {
            await agyRpc(hub, 'SetBrowserOpenConversation', {
                cascadeId: targetId,
                expiresAt: new Date(Date.now() + 3600e3).toISOString()
            }).catch(() => undefined);
        }
        // Aucun modèle n'est envoyé : la conversation garde le modèle présélectionné
        // dans l'UI. Relire metadata.modelUsage (placeholder interne) l'écrasait.
        const steps = await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId: targetId })
            .catch(() => ({ steps: [] }));
        // Procedure de choix : quota reel puis specialite (voir agy-hub.js pickAgyModel)
        const cfg = await agyRpc(hub, 'GetCascadeModelConfigData', {}).catch(() => ({}));
        const kind = process.env.AGY_KIND || 'general';
        const KIND_MODELS = {
            code: ['GPT-OSS 120B (Medium)', 'Claude Sonnet 5.5 (High)', 'Gemini 3.8 Flash (High)'],
            general: ['Gemini 3.8 Flash (Medium)', 'Gemini 3.8 Flash (Low)', 'GPT-OSS 120B (Medium)'],
            image: ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)'],
            complex: ['Claude Opus 5.5 (High)', 'Claude Sonnet 5.5 (High)', 'Claude Sonnet 5.5 (Medium)'],
        };
        const configs = (cfg?.clientModelConfigs || []).filter((c) => !c.disabled);
        const chosen = (KIND_MODELS[kind] || KIND_MODELS.general)
            .map((label) => configs.find((c) => c.label === label))
            .find((c) => typeof c?.quotaInfo?.remainingFraction === 'number' && c.quotaInfo.remainingFraction >= 0.05);
        const planModel = chosen?.modelOrAlias?.model;
        // Aucun modèle valide : on n'envoie pas. Sans cascadeConfig le hub applique
        // son défaut interne et change le modèle de la fenêtre.
        if (!planModel) {
            commsLog('orchestrator', 'agy', 'wake-acp-unsupported', `aucun modèle à quota pour ${kind} : envoi annulé`, targetId);
            return 'skipped';
        }
        const body = { cascadeId: targetId, items: [{ text }], cascadeConfig: { plannerConfig: { planModel } } };
        const before = (steps?.steps || []).length;
        await agyRpc(hub, 'SendUserCascadeMessage', body);
        commsLog('orchestrator', 'agy', 'prompt', text, targetId);
        if (replyToCascadeId) {
            relayAgyReply(hub, targetId, before, replyToCascadeId)
                .catch((e) => console.error('[agy] relay:', e?.message || e));
        }
        return 'sent';
    }
    catch (e) {
        console.error('[agy] send:', e?.message || e);
        return 'failed';
    }
}
/** Attend l'idle de la conv AGY puis injecte ses réponses dans le chat Devin. */
async function relayAgyReply(hub, agyCascadeId, sinceStep, devinCascadeId) {
    await agyRpc(hub, 'WaitForConversationFullyIdle', {
        conversationId: agyCascadeId,
        inactivityTimeoutSeconds: 300,
        stabilizationDurationSeconds: 2,
        returnOnExecutorError: true
    }, 10 * 60 * 1000);
    const r = await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId: agyCascadeId });
    const steps = r.steps || [];
    const texts = [];
    for (let i = sinceStep; i < steps.length; i++) {
        const s = steps[i];
        if (s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
            const p = s.plannerResponse || {};
            const t = p.modifiedResponse || p.response || '';
            if (t) {
                texts.push(t);
            }
        }
        else if (s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
            texts.push(`[agy-error] ${s.errorMessage?.error?.shortError || 'erreur'}`);
        }
    }
    if (texts.length) {
        commsLog('agy', 'devin', 'reply', texts.join('\n\n'), agyCascadeId);
        await wakeDevin(`[AGY↩ ${agyCascadeId.slice(0, 8)}] ${texts.join('\n\n')}`, devinCascadeId, { noFocus: true });
    }
}
function onTaskTerminalWake(task) {
    if (!vscode.workspace.getConfiguration('orchestratorMonitor').get('autoWake', true)) {
        return;
    }
    const status = task?.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
        return;
    }
    const blob = `${task?.title ?? ''} ${task?.description ?? ''}`;
    const cascadeId = blob.match(CASCADE_TAG)?.[1];
    const agyCascadeId = blob.match(AGY_CASCADE_TAG)?.[1];
    const title = String(task?.title ?? task?.description ?? '').slice(0, 140);
    const wake = `[WAKE] tâche #${task?.id ?? '?'} → ${status}${title ? ` — ${title}` : ''}`;
    // Adresse de retour prioritaire : le champ `dispatcher` de la tâche.
    // Effet pyramidal : un bleubite (local ou distant, ACP ou CLI) qui délègue
    // reçoit le résultat LUI, pas un tiers. Le tag embarqué reste le fallback.
    const dispatcher = String(task?.dispatcher ?? '');
    const acpMatch = dispatcher.match(/^acp\/([^/]+)\/(.+)$/);
    if (acpMatch) {
        const [, provider, session] = acpMatch;
        if (provider === 'devin-cli') {
            wakeDevin(wake, session, { noFocus: true });
        }
        else {
            void wakeAcpAgent(wake, session, provider);
        }
        return;
    }
    if (/^(agy|hub)/.test(dispatcher)) {
        wakeAntigravity(wake, agyCascadeId, cascadeId);
        return;
    }
    if (dispatcher) {
        // Dispatcher CLI/worker : signal sur le bus (il poll get_next_task +
        // tail comms) — pas de fenêtre IDE à réveiller.
        commsLog('orchestrator', dispatcher, 'wake', wake);
        return;
    }
    if (!cascadeId && !agyCascadeId) {
        // Tâche sans tag de routage → JAMAIS d'injection chat : un
        // sendCascadeInput sans cible explicite atterrit dans la conversation
        // que l'utilisateur est en train de lire — tours [WAKE] parasites,
        // boutons « run » sur les réponses, perte du scrollback. Le passage
        // terminal reste visible dans le feed monitor et sur le bus comms.
        commsLog('orchestrator', 'devin', 'wake', `${wake} (non routé)`);
        return;
    }
    if (agyCascadeId) {
        // Tâche née dans une conversation Antigravity → la réponse retourne
        // dans CETTE conversation (et dans Devin si un tag cascade coexiste).
        wakeAntigravity(wake, agyCascadeId, cascadeId);
        if (!cascadeId) {
            return;
        }
    }
    // Les complétions de tâches sont informatives : injection seulement si la
    // conv cible est déjà affichée — jamais d'ouverture de fenêtre surprise.
    wakeDevin(wake, cascadeId, { noFocus: true });
}
/** Envoie du texte dans le chat Devin actif. Pas de fallback presse-papiers :
    écrire en secret dans le clipboard est un canal caché (revue sécu). */
async function sendToDevinChat(text, label) {
    const lbl = label ?? L('chat.default');
    try {
        const payload = buildChatInputPayload(text);
        const action = JSON.stringify({ actionType: 'addCascadeInput', payload: [payload] });
        await vscode.commands.executeCommand('devin.sendChatActionMessage', action);
        vscode.window.showInformationMessage(L('chat.sent', { label: lbl }));
    }
    catch {
        vscode.window.showErrorMessage(L('chat.failed', { label: lbl }));
    }
}
function startBridge(context) {
    if (bridgeProcess && !bridgeProcess.killed) {
        if (!bridgeAutoStarted) {
            vscode.window.showInformationMessage('Orchestrator bridge already running.');
        }
        return;
    }
    bridgeAutoStarted = true;
    const bridgePath = path.join(context.extensionPath, 'ws-bridge', 'bridge.js');
    const bridgeCwd = path.dirname(bridgePath);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || bridgeCwd;
    bridgeProcess = (0, child_process_1.spawn)('node', [bridgePath], {
        cwd: bridgeCwd,
        windowsHide: true,
        env: { ...process.env, HEPHAISTOS_WORKSPACE: wsRoot }
    });
    bridgeProcess.stdout?.on('data', (d) => console.log(`[bridge] ${d}`));
    bridgeProcess.stderr?.on('data', (d) => console.error(`[bridge:err] ${d}`));
    bridgeProcess.on('close', (code) => {
        bridgeProcess = undefined;
        vscode.window.showWarningMessage(`Orchestrator bridge stopped (code ${code}).`);
    });
    vscode.window.showInformationMessage('Orchestrator bridge started.');
}
function restartBridge(context) {
    if (bridgeProcess) {
        try {
            bridgeProcess.kill();
        }
        catch { /* noop */ }
        bridgeProcess = undefined;
    }
    startBridge(context);
}
/* ===== Watchdog réactif : auto-start + supervision (#533) ==================
 * Si le workspace contient .agent/skills/reactive-orchestrator/watchdog.ps1,
 * l'extension le démarre en tâche de fond à activate() et le relance avec un
 * backoff si le process meurt — le watchdog survit ainsi aux crashs script
 * sans dépendre de tasks.json ni d'une action utilisateur. */
let watchdogProcess;
let watchdogTimer;
let watchdogRestarts = 0;
function startWatchdog() {
    if (process.env.HEPHAISTOS_WATCHDOG !== '1') {
        return;
    }
    const root = resolveWorkspaceRoot();
    if (!root) {
        queueWatchdogStart();
        return;
    }
    if (watchdogProcess && !watchdogProcess.killed) {
        return;
    }
    const script = path.join(root, '.agent', 'skills', 'reactive-orchestrator', 'watchdog.ps1');
    if (!fs.existsSync(script)) {
        queueWatchdogStart();
        return;
    }
    const pwsh = process.env.PWSH_PATH || 'pwsh';
    let stdoutBuffer = '';
    try {
        watchdogProcess = (0, child_process_1.spawn)(pwsh, [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
            '-WorkspaceRoot', root, '-IntervalSeconds', '30'
        ], { cwd: root, windowsHide: true });
        watchdogProcess.stdout?.on('data', (d) => {
            stdoutBuffer += d.toString();
        });
    }
    catch (e) {
        console.error('[watchdog] spawn failed:', e);
        queueWatchdogStart();
        return;
    }
    commsLog('orchestrator', 'watchdog', 'event', `watchdog started pid=${watchdogProcess.pid}`);
    updateStatus();
    watchdogProcess.on('close', (code) => {
        watchdogProcess = undefined;
        if (code === 0 && stdoutBuffer.includes('already_running')) {
            watchdogPeerActive = true;
            commsLog('orchestrator', 'watchdog', 'event', 'watchdog peer already running, yielding');
        }
        else if (code !== 0) {
            watchdogPeerActive = false;
            commsLog('orchestrator', 'watchdog', 'event', `watchdog exited code=${code} restart#${watchdogRestarts}`);
        }
        updateStatus();
        if (watchdogPeerActive) {
            watchdogRestarts = 0;
            if (watchdogTimer) {
                clearTimeout(watchdogTimer);
            }
            watchdogTimer = setTimeout(() => { startWatchdog(); }, 30000);
            watchdogTimer.unref?.();
        }
        else {
            watchdogRestarts += 1;
            const delay = Math.min(15000 * watchdogRestarts, 300000);
            if (watchdogTimer) {
                clearTimeout(watchdogTimer);
            }
            watchdogTimer = setTimeout(() => { watchdogRestarts = 0; startWatchdog(); }, delay);
            watchdogTimer.unref?.();
        }
    });
    watchdogProcess.on('error', (e) => {
        console.error('[watchdog] error:', e);
        queueWatchdogStart();
    });
}
/* ===== Binôme FR-11 : Join / Rejoin / Status ============================
 * Commandes palette qui délèguent à .agent/agent-bridge/binome.js (spawn
 * argv, jamais de shell). `pair` retombe sur la paire persistée en DB
 * (FR-09) quand le handshake comms.jsonl a expiré. */
function runBinome(subcmd) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showErrorMessage('Binôme : aucun workspace ouvert.');
        return;
    }
    const script = path.join(root, '.agent', 'agent-bridge', 'binome.js');
    if (!fs.existsSync(script)) {
        vscode.window.showErrorMessage('Binôme : .agent/agent-bridge/binome.js absent du workspace.');
        return;
    }
    const proc = (0, child_process_1.spawn)('node', [script,
        '--as', 'devin', '--via', 'acp', '--peer', 'agy', '--peer-via', 'hub',
        subcmd
    ], { cwd: root, windowsHide: true });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.stderr?.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
        const last = out.trim().split('\n').pop() || `exit ${code}`;
        commsLog('orchestrator', 'binome', 'command', `binome ${subcmd} -> ${last}`);
        if (code === 0) {
            vscode.window.showInformationMessage(`Binôme ${subcmd} : ${last}`);
        }
        else {
            vscode.window.showErrorMessage(`Binôme ${subcmd} a échoué (${code}) : ${last}`);
        }
    });
    proc.on('error', (e) => {
        vscode.window.showErrorMessage(`Binôme ${subcmd} : ${e.message}`);
    });
}
function pairStatus() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showErrorMessage('Pair status : aucun workspace ouvert.');
        return;
    }
    const dbPath = path.join(root, '.agent', 'orchestrator.db');
    const candidates = [
        process.env.HPHE_ORCH_DB,
        process.env.ORCHESTRATOR_DB,
        dbPath,
        '<servers>/hephaistos2-kit/data/orchestrator.db'
    ].filter((p) => !!p);
    const db = candidates.find((p) => fs.existsSync(p));
    if (!db) {
        vscode.window.showErrorMessage('Pair status : orchestrator.db introuvable.');
        return;
    }
    // Lecture seule via node:sqlite (version embarquée du runtime node de l'IDE).
    const probe = `const{DatabaseSync}=require('node:sqlite');` +
        `const r=new DatabaseSync(process.argv[1]).prepare("SELECT pair_id,agent_a,agent_b,last_seen FROM pairs ORDER BY last_seen DESC LIMIT 1").all();` +
        `console.log(JSON.stringify(r));`;
    try {
        const raw = (0, child_process_1.execFileSync)(process.execPath, ['-e', probe, db], {
            encoding: 'utf8', timeout: 8000, windowsHide: true
        }).trim();
        const rows = JSON.parse(raw || '[]');
        if (rows.length === 0) {
            vscode.window.showInformationMessage('Binôme : aucune paire persistée.');
        }
        else {
            const p = rows[0];
            vscode.window.showInformationMessage(`Binôme ${p.agent_a} <-> ${p.agent_b} | pair ${String(p.pair_id).slice(0, 8)} | vu ${p.last_seen}`);
        }
    }
    catch (e) {
        vscode.window.showWarningMessage(`Pair status illisible : ${e.message}`);
    }
}
/**
 * Vue sidebar : exactement le même dashboard webview que le panneau éditeur,
 * avec un bouton d'agrandissement vers le panneau plein écran.
 */
class TasksWebviewProvider {
    constructor(_context) {
        this._context = _context;
    }
    resolveWebviewView(view) {
        sidebarView = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
                vscode.Uri.joinPath(this._context.extensionUri, 'resources')
            ]
        };
        try {
            view.webview.html = (0, panelHtml_1.getPanelHtml)(view.webview, this._context.extensionUri, { compact: true });
        }
        catch (err) {
            console.error('[orchestrator-monitor] resolveWebviewView:', err);
            view.webview.html = `<html><body style="color:#f66;font:12px monospace;padding:12px">resolveWebviewView error:<br>${String(err?.message || err)}<br>${String(err?.stack || '')}</body></html>`;
        }
        view.webview.onDidReceiveMessage((message) => (0, messages_1.handlePanelMessage)(message));
        view.onDidDispose(() => {
            if (sidebarView === view) {
                sidebarView = undefined;
            }
        });
        // Pousser immédiatement le dernier état connu
        if (lastSnapshot) {
            view.webview.postMessage(lastSnapshot);
        }
    }
}
function deactivate() {
    wsClient?.dispose();
    wsClient = undefined;
    if (bridgeProcess) {
        try {
            bridgeProcess.kill();
        }
        catch { /* noop */ }
        bridgeProcess = undefined;
    }
    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
    }
    if (watchdogStartTimer) {
        clearTimeout(watchdogStartTimer);
        watchdogStartTimer = undefined;
    }
    if (watchdogProcess) {
        try {
            watchdogProcess.kill();
        }
        catch { /* noop */ }
        watchdogProcess = undefined;
    }
}
//# sourceMappingURL=extension.js.map