# WS Bridge Status

This WebSocket bridge connects to the orchestrator database and provides real-time updates to the VS Code extension.

## Features
- Connection to orchestrator database at `<INSTALL>/data/orchestrator.db`
  (resolved via `ORCHESTRATOR_DB`/`HPHE_ORCH_DB`/`HPHE_INSTALL`, default
  `%ProgramFiles%\servers\hephaistos2-kit`)
  (read via a `readonly` handle for snapshots; separate short-lived writable
  connections for `provider_prefs`, task deletion and zombie-task reconcile)
- WebSocket server on port 7477, bound to **127.0.0.1 only** (loopback —
  no LAN exposure)
- **Auth required at upgrade**: `ORCH_MONITOR_TOKEN` env or
  `.agent/ws-bridge.token` (generated at boot, never logged). Clients pass it
  via `?token=` query param or `Authorization: Bearer` header.
- Polls for snapshot and task updates every 2 seconds
- Broadcasts updates to all connected clients
- Relays inter-agent comms feed (`.agent/comms.jsonl`, multi-workspace merge)
- Reap zombie tasks (in_progress whose dispatched pid is dead)

## Dependencies
- better-sqlite3: For SQLite database access
- ws: WebSocket implementation

## Usage
Run `npm start` or `node bridge.js` to start the bridge.

## Notes
- The bridge runs as a separate process spawned by the VS Code extension
- Do not open port 7477 in the firewall — it is loopback-only by design
- Automatic reconnection handling for WebSocket clients
