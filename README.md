# Codex App Bridge (`codex-bridge`)

Stateful **JSON-RPC 2.0** bridge plugin for **Google Antigravity** (and any MCP-compatible host) that connects directly to OpenAI's local **`codex app-server`** instead of wrapping stateless `codex exec` CLI calls.

Zero external `npm` dependencies. Runs out of the box on macOS / Unix with Node.js 20+ and `codex` CLI (`>= 0.170`).

---

## Why `codex app-server` Instead of CLI Wrappers?

Wrapping `codex exec` over stdout loses the stateful capabilities that make **Codex Desktop (`Codex.app`)** useful. By speaking the official bidirectional `codex app-server` protocol directly, `codex-bridge` preserves:

- **Lock-Free Coexistence with `Codex.app`**:
  - `codex_thread_list` and `codex_thread_read` inspect persisted SQLite / Rollout history without calling `thread/resume`, never triggering `"Conversation opened in another application"` in open `Codex.app` windows.
  - `codex_turn_send({ mode: "fork" })` branches cleanly off any existing Desktop thread while inheriting its sandbox and reviewer settings.
  - Automatic `thread/unsubscribe` releases subscriptions immediately once turns and approvals finish.
- **macOS Computer Use (`unified-computer-use` / `cua_repl`)**:
  - Verifies active `cua_repl` (`js` / `js_reset` / `turn_ended`) or legacy `computer-use` skills before starting UI-automation turns, failing fast with actionable diagnostics when unavailable.
- **Codex App Connectors & Sidebar Sections**:
  - Retains authenticated `codex_apps` connectors (GitHub, Gmail, Spreadsheets, Presentations, etc.) and manages `Codex.app` sidebar sections (`Pinned`, custom groups) via `codex_thread_organize`.
- **Strict Bidirectional Approvals**:
  - Pauses on command, file-change, permission, user-input, `humanCommand` checkpoints, and MCP form elicitations (`status: "awaiting_approval"`), allowing Antigravity or the user to review and reply via `codex_approval_respond`.

---

## Installation

### 1. Antigravity (Recommended)

Install directly from GitHub or a local clone:

```bash
# From GitHub
agy plugin install https://github.com/JLA97/codex-bridge

# Or from a local directory
agy plugin install /path/to/codex-bridge
```

This single bundle registers:
- **MCP Server** (`codex-bridge_app-server`): 10 `codex_*` tools managed automatically on demand.
- **Skill** (`codex-collab`): Workflow rules for lock-free reading/forking, 45s polling loops, approval handling, and Computer Use.
- **Subagent** (`codex-delegate`): Dedicated background coordinator to keep verbose multi-turn polling out of the main chat.

### 2. Other MCP Hosts (Claude Code / Cursor / Generic MCP)

Point any stdio MCP client to `scripts/codex-bridge-mcp`:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "/bin/sh",
      "args": ["/absolute/path/to/codex-bridge/scripts/codex-bridge-mcp", "--mcp"]
    }
  }
}
```

---

## Exposed MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `codex_capabilities` | Check `codex app-server` version, auth, `cua_repl` Computer Use readiness, loaded skills, MCP connectors, and Desktop sections. |
| `codex_thread_list` | Browse active or archived `Codex.app` threads (filter by `cwd`, `searchTerm`, `sectionId`, `cursor`) without session locks. |
| `codex_thread_read` | Read persisted turns, messages, commands, file changes, and MCP calls of any thread without locking it. |
| `codex_turn_send` | Start a `"new"` thread, `"fork"` an open Desktop thread, or `"resume"` an idle thread (`useComputerUse`, `approvalHandling`, 45s safe wait window). |
| `codex_turn_status` | Poll an active background turn (`status: "running_in_background"`) until completion or approval. |
| `codex_pending_approvals` | Inspect queued command, file, permission, user-input, or MCP elicitation callbacks. |
| `codex_approval_respond` | Send an explicit decision (`accept`, `acceptForSession`, `decline`, `cancel`) and continue waiting on the turn. |
| `codex_turn_interrupt` | Cancel a running Codex turn, await its terminal event, and release the thread subscription. |
| `codex_review_start` | Run Codex's native code reviewer (`review/start`) on uncommitted changes, branches, commits, or custom instructions. |
| `codex_thread_organize` | Rename threads, move threads across `Codex.app` sidebar sections, or archive/unarchive threads. |

---

## Repository Layout

```text
codex-bridge/
├── plugin.json                  # Antigravity plugin manifest
├── mcp_config.json              # Antigravity stdio MCP server definition
├── scripts/
│   ├── codex-bridge-mcp         # Portable POSIX Node launcher
│   └── self-test.mjs            # Zero-dependency automated test suite (node --test)
├── server/
│   ├── app-server-client.mjs    # Stateful JSON-RPC 2.0 client & approval/turn state machine
│   ├── tools.mjs                # Tool schemas, input validation & handlers
│   └── index.mjs                # MCP stdio server + stateless one-shot CLI
├── skills/
│   └── codex-collab/SKILL.md    # Collaboration workflow instructions
├── agents/
│   └── codex-delegate.md        # Context-isolating coordinator subagent
└── assets/
    └── logo.svg                 # Plugin icon
```

---

## Local Development & Verification

If you are actively developing this repository locally on macOS, symlink it into `~/.gemini/config/plugins/codex-bridge` so edits in your Git checkout take effect immediately without reinstalling:

```bash
rm -rf ~/.gemini/config/plugins/codex-bridge
ln -s /Users/leo/Projects/codex-bridge ~/.gemini/config/plugins/codex-bridge
```

Run the test suite and strict plugin validator:

```bash
node --test scripts/self-test.mjs
agy plugin validate --strict .
```

---

## Acknowledgements / 致谢

- 感谢 **[LINUX DO](https://linux.do/)** 社区在多 Agent 协同工作流、工程实践与日常交流中带来的诸多启发与讨论。
- Built on top of the open [Codex App Server](https://github.com/openai/codex) protocol and the [Google Antigravity](https://antigravity.google/docs/plugins) plugin ecosystem.

## License

[MIT](./LICENSE)
