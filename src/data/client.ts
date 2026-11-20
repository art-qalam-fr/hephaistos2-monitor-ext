import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// Le VSIX n'embarque pas node_modules racine : fallback sur le ws du ws-bridge
// (toujours packagé), sinon le WebSocket natif (Node >=22).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket: typeof import('ws') = (() => {
    try { return require('ws'); } catch { /* absent */ }
    try { return require(path.join(__dirname, '..', '..', 'ws-bridge', 'node_modules', 'ws')); } catch { /* absent */ }
    return (globalThis as unknown as { WebSocket: typeof import('ws') }).WebSocket;
})();

/**
 * Client WebSocket vers le bridge orchestrator-monitor (ws-bridge/bridge.js).
 * Emits: 'message' (raw parsed object), 'connected', 'disconnected'.
 * Le bridge exige un token (ORCH_MONITOR_TOKEN ou .agent/ws-bridge.token)
 * transmis en query param à l'upgrade.
 */
export class OrchestratorWS extends EventEmitter {
    private ws: import('ws') | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private readonly url: string;
    private readonly tokenFile?: string;
    private shouldReconnect = true;

    constructor(url: string = 'ws://127.0.0.1:7477', tokenFile?: string) {
        super();
        this.url = url;
        this.tokenFile = tokenFile;
    }

    private connectUrl(): string {
        let tok = (process.env.ORCH_MONITOR_TOKEN || '').trim();
        if (!tok) {
            const candidates = [
                this.tokenFile,
                process.env.HEPHAISTOS_WORKSPACE
                    ? path.join(process.env.HEPHAISTOS_WORKSPACE, '.agent', 'ws-bridge.token')
                    : undefined,
            ].filter((f): f is string => !!f);
            for (const f of candidates) {
                try {
                    const t = fs.readFileSync(f, 'utf8').trim();
                    if (t) { tok = t; break; }
                } catch { /* absent */ }
            }
        }
        const params: string[] = [];
        if (tok) { params.push(`token=${encodeURIComponent(tok)}`); }
        params.push(`idePid=${process.pid}`);
        return `${this.url}?${params.join('&')}`;
    }

    public connect(): void {
        if (this.ws) {
            try { this.ws.close(); } catch { /* noop */ }
        }
        this.ws = new WebSocket(this.connectUrl());

        this.ws.on('open', () => {
            this.emit('connected');
            if (this.reconnectTimer) {
                clearInterval(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        });

        this.ws.on('message', (data: import('ws').Data) => {
            try {
                this.emit('message', JSON.parse(data.toString()));
            } catch {
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

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || this.reconnectTimer) { return; }
        this.reconnectTimer = setInterval(() => this.connect(), 5000);
    }

    public send(data: unknown): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    public dispose(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }
    }
}
