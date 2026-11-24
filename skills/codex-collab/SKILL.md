---
name: codex-collab
description: Orchestrate stateful collaboration with the local Codex App (`codex app-server`) from Antigravity. Use when delegating tasks to Codex, offering or running a cross-model code review after non-trivial code changes, reading or forking persisted Codex Desktop threads without lock conflicts, organizing Codex Desktop sidebar sections, or driving macOS desktop/simulator apps via Codex Computer Use.
---

# Codex App Bridge (`codex-collab`)

Always prefer the persistent **`codex-bridge_app-server`** MCP server tools (`codex_*`) to interact with **Codex App Server**. Its in-memory state preserves active turns and interactive approval callbacks across calls. (The standalone CLI entrypoint is strictly for stateless one-shot queries such as `capabilities`, `threads`, or `read`.)

## Core Principles

1. **Avoid Session Lock Conflicts & Understand Snapshot Boundaries**
   - Use `codex_thread_list` and `codex_thread_read` to inspect sessions. Both read persisted SQLite/rollout history (`snapshotSource: "persisted_state_db"` / `"persisted_rollout_history"`) without calling `thread/resume`, so `Codex.app` never hits `"Conversation opened in another application"`. Note that unpersisted in-flight tokens inside an actively streaming `Codex.app` window only appear once flushed to disk.
   - When continuing from a thread that may be open in `Codex.app`, use `codex_turn_send` with **`mode: "fork"`** (`threadId` set to the source thread). `mode: "fork"` and `mode: "resume"` automatically inherit the source thread's sandbox, approval policy, and reviewer settings unless you explicitly pass overrides.
   - Once all active turns and pending approvals on a thread finish, `codex-bridge` automatically unsubscribes so the thread can be opened in `Codex.app` without lock contention.

2. **Poll Long Tasks Safely (`waitTimeoutMs` & `codex_turn_status`)**
   - `codex_turn_send`, `codex_turn_status`, and `codex_approval_respond` default to `waitTimeoutMs: 45000` (45s) — well below the MCP host's 180s call timeout — so you always receive `{ threadId, turnId, status: "running_in_background" }` cleanly on long jobs.
   - Loop with `codex_turn_status({ threadId, turnId })` until `status` reaches `"completed"`, `"awaiting_approval"`, `"failed"`, or `"interrupted"`.
   - Cancelling an MCP tool call only stops waiting; call `codex_turn_interrupt({ threadId, turnId })` when you actually want Codex to abort execution.

3. **Handle Interactive Approvals (`status: "awaiting_approval"`)**
   - With `approvalHandling: "defer"` (default), escalated commands, file writes, permission requests, user-input questions, or MCP elicitations pause and return `pendingApprovals: [{ approvalId, scope, method, params }]`.
   - Always pass an explicit `decision` (`"accept"`, `"acceptForSession"`, `"decline"`, or `"cancel"`) to `codex_approval_respond`. Note that `humanCommand` checkpoints only allow one-time decisions (`"accept"`, `"decline"`, `"cancel"`), MCP form elicitations with required fields expect `content`, and `item/tool/requestUserInput` expects `answers`.

4. **Using Codex macOS Computer Use (`useComputerUse: true`)**
   - Verify readiness first via `codex_capabilities` (`computerUse.ready === true`).
   - Modern Codex App (`unified-computer-use@openai-bundled`) exposes macOS UI control via the **`cua_repl` MCP server** (`js` tool), while older bundles attach a `computer-use` skill. `codex_turn_send({ useComputerUse: true, ... })` verifies that an enabled plugin + active `cua_repl` tool catalog (or skill) is present on the target thread, failing fast with an actionable reason if unavailable.

5. **Isolate Parallel Edits & Multi-Turn Loops**
   - In Git repositories, pass a dedicated `git worktree` path as `cwd` when running parallel edits.
   - Delegate multi-round polling or approval workflows to the `codex-delegate` subagent to keep the main chat concise.

## Cross-Model Code Review (Proactive Offer & Triage)

- **When to Offer (Restrained by Default)**:
  - After completing a **non-trivial change** (e.g., multi-file edits, core logic/state transitions, concurrency, protocol/API boundaries, auth/security, or risky refactors), proactively offer to run a read-only cross-model review via `codex_review_start` rather than invoking it silently (unless the user already asked for a Codex review).
  - Do **not** offer a Codex review for trivial edits (typos, docs-only tweaks, minor config updates, or straightforward one-liners).
- **Triage Findings Critically — Avoid Over-Defense & Scope Creep**:
  - Codex's reviewer can be overly defensive (flagging speculative edge cases, redundant guards already covered by invariants, or unrelated cleanups). Never apply its findings blindly.
  - Verify each finding independently against the actual code, call sites, and invariants:
    - **Fix real, in-scope defects**: confirmed bugs, race conditions, broken contracts, data-loss risks, security issues, or crashes on realistic inputs.
    - **Skip over-defensive noise**: impossible states, hypothetical "what-if" checks, redundant defensive boilerplate, style nits, or refactors that expand the change scope unnecessarily.
  - When reporting back to the user, clearly distinguish **verified issues fixed (or worth fixing)** from **dismissed over-defensive / out-of-scope findings** with a brief reason.

## Tool Quick Reference

| Goal | Tool | Key Arguments |
| :--- | :--- | :--- |
| Check auth, Computer Use (`cua_repl`), skills & sections | `codex_capabilities` | `{ cwd? }` |
| Browse persisted Codex Desktop threads | `codex_thread_list` | `{ cwd?, searchTerm?, sectionId?, archived?, cursor?, limit? }` |
| Read persisted thread turns (lock-free) | `codex_thread_read` | `{ threadId, turnLimit?: 5, cursor?, itemsView? }` |
| Run new task / fork Desktop thread / Computer Use | `codex_turn_send` | `{ mode?: "new" \| "fork" \| "resume", prompt, threadId?, cwd?, title?, sectionId?, useComputerUse?, approvalHandling? }` |
| Poll in-progress turn | `codex_turn_status` | `{ threadId, turnId, waitTimeoutMs? }` |
| Reply to command / permission / MCP approval | `codex_approval_respond` | `{ approvalId, decision, scope?, content?, answers? }` |
| List active approval callbacks | `codex_pending_approvals` | `{ threadId?, turnId? }` |
| Stop active turn | `codex_turn_interrupt` | `{ threadId, turnId }` |
| Run native Codex diff/branch review | `codex_review_start` | `{ cwd, targetType?: "uncommittedChanges" \| "baseBranch" \| "commit" \| "custom" }` |
| Rename, move section, or archive thread | `codex_thread_organize` | `{ threadId, name?, sectionId?, archive? }` |
