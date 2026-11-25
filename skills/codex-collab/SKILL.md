---
name: codex-collab
description: Orchestrate stateful collaboration with the local Codex App (`codex app-server`) from Antigravity. Use when delegating tasks to Codex, running cross-model code reviews, second-opinion bug diagnosis, or design consultations, reading or forking persisted Codex Desktop threads without lock conflicts, organizing Codex Desktop sidebar sections, or driving macOS desktop/simulator apps via Codex Computer Use.
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

## Collaboration Playbook

- **Start Read-Only for Advisory Work, Escalate When Needed**:
  - For code reviews, diagnosis, and design consultations, always pass the target repo's absolute `cwd` and default to read-only (`codex_review_start`, or `codex_turn_send` with `sandbox: "read-only"`, `approvalPolicy: "never"`, `approvalHandling: "decline"`).
  - Treat read-only as a sensible default, not a straitjacket: if a reproduction test needs temporary writes, either run it locally and feed observed results back to Codex, or use `workspace-write` + `approvalHandling: "defer"` when the user wants Codex to run tests or make edits. Feel free to delegate standalone coding tasks, refactors, or adversarial edge-case test generation when Codex is a good fit.
- **Reasoning Depth (`high` / `xhigh`)**:
  - Prioritize rigor over speed: default to `effort: "high"` on `codex_turn_send`, and use `"xhigh"` for stubborn bugs, concurrency/security issues, or high-stakes architectural trade-offs. (`codex_review_start` uses Codex's native reviewer config.)
- **Stateful Multi-Round (`mode: "resume"`) & Practical Pitfalls**:
  - Keep `ephemeral: false` (default) on any thread you may continue — `ephemeral: true` drops on auto-unsubscribe and fails `thread/resume` (`no rollout found`). Optionally archive finished threads via `codex_thread_organize({ threadId, archive: true })` to keep `Codex.app`'s sidebar tidy.
  - When resuming a completed read-only thread, pass `approvalHandling: "decline"` (`sandbox`/`approvalPolicy` inherit from the thread, while `approvalHandling` resets to `"defer"` per turn) and send only incremental evidence or focused counter-arguments rather than re-dumping full context.
  - Let the problem dictate rounds: stop after 1 round if already conclusive; use 2–3 rounds as a practical convergence guardrail for iterative diagnosis or design debates, then present consensus plus any unresolved trade-offs (your stance vs. Codex's stance) to the user.
- **Direct Call vs. Async `codex-delegate`**:
  - Use `codex-delegate` (`invoke_subagent`) for **non-blocking background runs** (e.g., `codex_review_start` or long `high`/`xhigh` turns while the main agent works on unrelated tasks or keeps verbose polling out of the main chat); for read-only delegation, specify in the prompt whether local edits and approval escalations are disallowed.
  - Call `codex_turn_send` directly from the main agent when you need high-fidelity nuance in tight back-and-forth design discussions where subagent summarization would lose detail. Avoid firing other `codex_*` calls concurrently with a blocking `codex_turn_status` wait (some MCP hosts serialize calls per server).
- **Triage Critically — No Over-Defense or Scope Creep**:
  - Verify Codex's findings independently against actual code, call sites, and invariants. Adopt real, in-scope defects and dismiss speculative edge cases, redundant guards, or unrelated refactors (briefly noting what was skipped and why).
  - Respect task scope: if reviewing your own authorized implementation, fix verified in-scope defects directly; if the user requested a standalone review only, report findings first and ask before editing.

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
