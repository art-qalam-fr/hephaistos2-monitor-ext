"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestratorWS = void 0;
const events_1 = require("events");
const fs = require("fs");
const path = require("path");
// Le VSIX n'embarque pas node_modules racine : fallback sur le ws du ws-bridge
// (toujours packagé), sinon le WebSocket natif (Node >=22).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = (() => {
    try {
        return require('ws');
    }
    catch { /* absent */ }
    try {
        return require(path.join(__dirname, '..', '..', 'ws-bridge', 'node_modules', 'ws'));
    }
    catch { /* absent */ }
    return globalThis.WebSocket;
})();
/**
 * Client WebSocket vers le bridge orchestrator-monitor (ws-bridge/bridge.js).
 * Emits: 'message' (raw parsed object), 'connected', 'disconnected'.
 * Le bridge exige un token (ORCH_MONITOR_TOKEN ou .agent/ws-bridge.token)
 * transmis en query param à l'upgrade.
 */
class OrchestratorWS extends events_1.EventEmitter {
    constructor(url = 'ws://127.0.0.1:7477', tokenFile) {
        super();
        this.ws = null;
        this.reconnectTimer = null;
        this.shouldReconnect = true;
        this.url = url;
        this.tokenFile = tokenFile;
    }
    connectUrl() {
        let tok = (process.env.ORCH_MONITOR_TOKEN || '').trim();
        if (!tok) {
            const candidates = [
                this.tokenFile,
                process.env.HEPHAISTOS_WORKSPACE
                    ? path.join(process.env.HEPHAISTOS_WORKSPACE, '.agent', 'ws-bridge.token')
                    : undefined,
            ].filter((f) => !!f);
            for (const f of candidates) {
                try {
                    const t = fs.readFileSync(f, 'utf8').trim();
                    if (t) {
                        tok = t;
                        break;
                    }
                }
                catch { /* absent */ }
            }
        }
        const params = [];
        if (tok) {
            params.push(`token=${encodeURIComponent(tok)}`);
        }
        params.push(`idePid=${process.pid}`);
        return `${this.url}?${params.join('&')}`;
    }
    connect() {
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { /* noop */ }
        }
        this.ws = new WebSocket(this.connectUrl());
        this.ws.on('open', () => {
            this.emit('connected');
            if (this.reconnectTimer) {
                clearInterval(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        });
        this.ws.on('message', (data) => {
            try {
                this.emit('message', JSON.parse(data.toString()));
            }
            catch {
                // malformed frame — ignore
            }
        });
        this.ws.on('close', () => {
            this.emit('disconnected');
            this.scheduleReconnect();
        });
        this.ws.on('error', () => {
            // 'close' will follow and trigger reconnect
        });
    }
    scheduleReconnect() {
        if (!this.shouldReconnect || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setInterval(() => this.connect(), 5000);
    }
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
    dispose() {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { /* noop */ }
            this.ws = null;
        }
    }
}
exports.OrchestratorWS = OrchestratorWS;
//# sourceMappingURL=client.js.map