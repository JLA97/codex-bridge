import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MAX_RETAINED_TERMINAL_TURNS = 50;
const TERMINAL_TURN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 45_000;

const VALID_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const HUMAN_COMMAND_DECISIONS = new Set(["accept", "decline", "cancel"]);

function findWindowsCodexFromPath(env = process.env, fileExists = existsSync) {
  const rawPath = env.PATH ?? env.Path ?? "";
  const pathDirs = rawPath.split(path.win32.delimiter);
  for (const rawDir of pathDirs) {
    const dir = rawDir.trim().replace(/^"+|"+$/g, "");
    if (!dir) continue;
    const exePath = path.win32.join(dir, "codex.exe");
    if (fileExists(exePath)) {
      return exePath;
    }
    const cmdPath = path.win32.join(dir, "codex.cmd");
    if (fileExists(cmdPath)) {
      const siblingJs = path.win32.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      return fileExists(siblingJs) ? siblingJs : cmdPath;
    }
  }
  return null;
}

function quoteWindowsCmdArg(arg) {
  const str = String(arg);
  if (str.length > 0 && /^[a-zA-Z0-9_./:\\-]+$/.test(str)) {
    return str;
  }
  const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export function resolveCodexSpawnSpec(explicitBin, extraArgs = [], runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  const fileExists = runtime.existsSync ?? existsSync;
  const execPath = runtime.execPath ?? process.execPath;
  const envBin = explicitBin || env.CODEX_BIN;
  const appServerArgs = ["app-server", "--stdio", ...extraArgs];
  let bin = null;

  if (envBin) {
    if (/[\\/]/.test(envBin) && !fileExists(envBin)) {
      throw new Error(`Configured CODEX_BIN path does not exist: ${envBin}`);
    }
    bin = envBin;
  } else if (platform === "win32") {
    const fromPath = findWindowsCodexFromPath(env, fileExists);
    if (fromPath) {
      bin = fromPath;
    } else {
      const appData = env.APPDATA ?? env.AppData;
      const npmCodexJs = appData
        ? path.win32.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
        : null;
      bin = npmCodexJs && fileExists(npmCodexJs) ? npmCodexJs : "codex";
    }
  } else {
    for (const candidate of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
      if (fileExists(candidate)) {
        bin = candidate;
        break;
      }
    }
    if (!bin) bin = "codex";
  }

  if (platform === "win32") {
    const lower = bin.toLowerCase();
    if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
      return {
        command: execPath,
        args: [bin, ...appServerArgs],
        displayBin: bin,
      };
    }
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const commandLine = [bin, ...appServerArgs].map(quoteWindowsCmdArg).join(" ");
      return {
        command: env.ComSpec || env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", `"${commandLine}"`],
        displayBin: bin,
        windowsVerbatimArguments: true,
      };
    }
  }

  return {
    command: bin,
    args: appServerArgs,
    displayBin: bin,
  };
}

export function buildChildEnv(extraEnv = {}, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const baseEnv = runtime.env ?? process.env;
  const env = { ...baseEnv, ...extraEnv };
  if (platform === "win32") {
    return env;
  }
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
  const currentParts = (env.PATH || "").split(":").filter(Boolean);
  for (const p of extraPaths.reverse()) {
    if (!currentParts.includes(p)) {
      currentParts.unshift(p);
    }
  }
  env.PATH = currentParts.join(":");
  return env;
}

function truncateText(text, maxChars = 2500) {
  if (typeof text !== "string" || text.length <= maxChars) {
    return text ?? null;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n... [truncated ${omitted} chars]`;
}

function compactJson(val, maxChars = 1200) {
  if (val === undefined || val === null) return null;
  try {
    const str = JSON.stringify(val);
    if (str.length <= maxChars) return val;
    return { _truncatedPreview: truncateText(str, maxChars) };
  } catch {
    return { _truncatedPreview: truncateText(String(val), maxChars) };
  }
}

function mapLegacyReviewDecision(decision) {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "cancel":
      return "abort";
    case "decline":
    default:
      return { denied: { rejection: "Declined by caller" } };
  }
}

class TurnTracker {
  constructor({ threadId, turnId, approvalHandling = "defer" }) {
    this.threadId = threadId;
    this.turnId = turnId;
    this.approvalHandling = approvalHandling;
    this.policyLocked = false;
    this.status = "running"; // running | completed | failed | interrupted
    this.turnError = null;
    this.durationMs = null;
    this.completedAtWallMs = null;

    this.deltasByItemId = new Map();
    this.completedMessagesById = new Map();
    this.messageOrder = [];

    this.latestPlan = null;
    this.latestDiff = null;
    this.commandsById = new Map();
    this.fileChangesById = new Map();
    this.mcpCallsById = new Map();
    this.guardianReviews = [];
    this.autoApprovedEvents = [];
    this.warnings = [];
    this.errors = [];

    this.waiters = new Set();
  }

  recordMessageDelta(itemId, delta) {
    if (!itemId || typeof delta !== "string") return;
    if (!this.messageOrder.includes(itemId)) {
      this.messageOrder.push(itemId);
    }
    this.deltasByItemId.set(itemId, (this.deltasByItemId.get(itemId) || "") + delta);
  }

  recordItem(item) {
    if (!item || typeof item !== "object") return;
    switch (item.type) {
      case "agentMessage": {
        if (!this.messageOrder.includes(item.id)) {
          this.messageOrder.push(item.id);
        }
        if (typeof item.text === "string") {
          this.completedMessagesById.set(item.id, item.text);
          this.deltasByItemId.delete(item.id);
        }
        break;
      }
      case "plan": {
        if (typeof item.text === "string" && item.text.trim()) {
          this.latestPlan = truncateText(item.text, 4000);
        }
        break;
      }
      case "commandExecution": {
        this.commandsById.set(item.id, {
          id: item.id,
          command: truncateText(item.command, 1000),
          cwd: item.cwd,
          status: item.status,
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null,
          outputPreview: truncateText(item.aggregatedOutput, 2000),
        });
        break;
      }
      case "fileChange": {
        const changes = Array.isArray(item.changes)
          ? item.changes.slice(0, 50).map((ch) => ({
              path: ch.path ?? null,
              kind: ch.kind ?? null,
              diffPreview: ch.diff ? truncateText(ch.diff, 1000) : undefined,
            }))
          : [];
        this.fileChangesById.set(item.id, {
          id: item.id,
          status: item.status,
          changes,
        });
        break;
      }
      case "mcpToolCall": {
        this.mcpCallsById.set(item.id, {
          id: item.id,
          server: item.server,
          pluginId: item.pluginId ?? null,
          tool: item.tool,
          status: item.status,
          durationMs: item.durationMs ?? null,
          arguments: compactJson(item.arguments, 1000),
          error: item.error ?? null,
          resultPreview: item.result ? truncateText(JSON.stringify(item.result), 1200) : null,
        });
        break;
      }
      default:
        break;
    }
  }

  getAssistantText() {
    const parts = [];
    for (const id of this.messageOrder) {
      if (this.completedMessagesById.has(id)) {
        parts.push(this.completedMessagesById.get(id));
      } else if (this.deltasByItemId.has(id)) {
        parts.push(this.deltasByItemId.get(id));
      }
    }
    return parts.join("\n\n").trim();
  }

  isTerminal() {
    return (
      this.status === "completed" ||
      this.status === "failed" ||
      this.status === "interrupted"
    );
  }

  markTerminal(status, turnError = null, durationMs = null) {
    this.status = status;
    this.turnError = turnError;
    this.durationMs = durationMs;
    this.completedAtWallMs = Date.now();
  }

  notifyWaiters(outcome) {
    for (const resolve of this.waiters) {
      resolve(outcome);
    }
    this.waiters.clear();
  }

  toSummary(pendingApprovals = []) {
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      status:
        pendingApprovals.length > 0 && !this.isTerminal()
          ? "awaiting_approval"
          : this.status,
      assistantResponse: this.getAssistantText(),
      plan: this.latestPlan,
      commands: Array.from(this.commandsById.values()),
      fileChanges: Array.from(this.fileChangesById.values()),
      diffPreview: truncateText(this.latestDiff, 4000),
      mcpToolCalls: Array.from(this.mcpCallsById.values()),
      guardianReviews: this.guardianReviews,
      autoApprovedEvents: this.autoApprovedEvents,
      pendingApprovals,
      turnError: this.turnError,
      warnings: this.warnings,
      errors: this.errors,
      durationMs: this.durationMs,
    };
  }
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.explicitCodexBin = options.codexBin || null;
    this.extraArgs = options.extraArgs || [];
    this.extraEnv = options.extraEnv || {};
    this.idleShutdownMs = options.idleShutdownMs ?? 90_000;

    // Active connection state (scoped per spawned child via activeConn)
    this.activeConn = null;
    this.connectPromise = null;
    this.nextRpcId = 1;
    this.nextApprovalSeq = 1;

    this.turns = new Map(); // `${threadId}:${turnId}` -> TurnTracker
    this.latestTurnByThread = new Map(); // threadId -> TurnTracker
    this.pendingTurnPolicyByThread = new Map(); // threadId -> policy for a turn currently starting
    this.subscribedThreads = new Set(); // threadIds currently subscribed on activeConn
    this.pendingApprovals = new Map(); // approvalId -> { approvalId, rpcId, method, params, createdAt, conn }
    this.resolvedApprovalHistory = new Map(); // approvalId -> { resolvedAt, method, decision }
    this.idleTimer = null;
  }

  get child() {
    return this.activeConn?.child ?? null;
  }

  get serverInfo() {
    return this.activeConn?.serverInfo ?? null;
  }

  touchIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this._pruneCompletedTurns();
    if (this.idleShutdownMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.hasActiveWork()) {
        this.touchIdleTimer();
        return;
      }
      this.close();
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  _pruneCompletedTurns() {
    const now = Date.now();
    const terminalEntries = [];
    for (const [key, tracker] of this.turns.entries()) {
      if (!tracker.isTerminal()) continue;
      if (tracker.completedAtWallMs && now - tracker.completedAtWallMs > TERMINAL_TURN_TTL_MS) {
        this._evictTurnEntry(key, tracker);
      } else {
        terminalEntries.push([key, tracker]);
      }
    }
    if (terminalEntries.length > MAX_RETAINED_TERMINAL_TURNS) {
      terminalEntries.sort(
        (a, b) => (a[1].completedAtWallMs || 0) - (b[1].completedAtWallMs || 0)
      );
      const excess = terminalEntries.length - MAX_RETAINED_TERMINAL_TURNS;
      for (let i = 0; i < excess; i++) {
        const [key, tracker] = terminalEntries[i];
        this._evictTurnEntry(key, tracker);
      }
    }
  }

  _evictTurnEntry(key, tracker) {
    this.turns.delete(key);
    if (this.latestTurnByThread.get(tracker.threadId) === tracker) {
      this.latestTurnByThread.delete(tracker.threadId);
    }
  }

  hasActiveWork() {
    if (this.activeConn && this.activeConn.pendingRequests.size > 0) {
      return true;
    }
    if (this.pendingApprovals.size > 0) {
      return true;
    }
    for (const tracker of this.turns.values()) {
      if (!tracker.isTerminal()) return true;
    }
    return false;
  }

  async ensureConnected() {
    if (this.activeConn && !this.activeConn.closed && this.activeConn.serverInfo) {
      this.touchIdleTimer();
      return this.activeConn.serverInfo;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this._spawnAndInitialize();
    try {
      const info = await this.connectPromise;
      this.touchIdleTimer();
      return info;
    } finally {
      this.connectPromise = null;
    }
  }

  async _spawnAndInitialize() {
    const spec = resolveCodexSpawnSpec(this.explicitCodexBin, this.extraArgs);
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(this.extraEnv),
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    const conn = {
      child,
      codexBin: spec.displayBin,
      closed: false,
      serverInfo: null,
      pendingRequests: new Map(),
      stderrRing: [],
      rlOut: null,
      rlErr: null,
    };
    this.activeConn = conn;
    this.subscribedThreads.clear();

    conn.rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    conn.rlOut.on("line", (line) => {
      if (this.activeConn !== conn || conn.closed) return;
      this._handleStdoutLine(conn, line);
    });

    conn.rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    conn.rlErr.on("line", (line) => {
      if (!line.trim()) return;
      conn.stderrRing.push(line);
      if (conn.stderrRing.length > 40) {
        conn.stderrRing.shift();
      }
    });

    child.stdin?.on("error", (err) => {
      if (this.activeConn !== conn || conn.closed) return;
      this._teardownConnection(conn, new Error(`codex app-server stdin error: ${err.message}`));
    });

    child.on("error", (err) => {
      this._teardownConnection(
        conn,
        new Error(`Failed to spawn ${spec.displayBin}: ${err.message}`)
      );
    });

    child.on("exit", (code, signal) => {
      const tail = conn.stderrRing.slice(-8).join("\n");
      this._teardownConnection(
        conn,
        new Error(
          `codex app-server exited (code=${code}, signal=${signal})${tail ? `:\n${tail}` : ""}`
        )
      );
    });

    try {
      const initResult = await this._rawRequestOnConn(
        conn,
        "initialize",
        {
          clientInfo: {
            name: "antigravity-codex-bridge",
            title: "Antigravity Codex Bridge",
            version: "0.2.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            requiredHumanApproval: true,
            extensions: {
              "openai/form": {},
            },
          },
        },
        15_000
      );

      this._writeJsonOnConn(conn, { jsonrpc: "2.0", method: "initialized" });
      conn.serverInfo = { ...initResult, resolvedCodexBin: spec.displayBin };
      return conn.serverInfo;
    } catch (initErr) {
      this._killConnProcess(conn);
      this._teardownConnection(conn, initErr);
      throw initErr;
    }
  }

  _killConnProcess(conn) {
    if (!conn || conn.closed) return;
    conn.closed = true;
    try {
      conn.rlOut?.close();
      conn.rlErr?.close();
    } catch {}
    if (conn.child && !conn.child.killed) {
      try {
        conn.child.stdin?.end();
      } catch {}
      try {
        conn.child.kill("SIGTERM");
      } catch {}
    }
  }

  _teardownConnection(conn, error) {
    if (!conn) return;
    conn.closed = true;

    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    conn.pendingRequests.clear();

    if (this.activeConn !== conn) {
      // Retired connection exiting late: never clobber the replacement connection!
      return;
    }

    this.activeConn = null;
    this.subscribedThreads.clear();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    for (const [aprId, entry] of this.pendingApprovals.entries()) {
      if (entry.conn === conn) {
        this.pendingApprovals.delete(aprId);
      }
    }

    for (const tracker of this.turns.values()) {
      if (!tracker.isTerminal()) {
        tracker.markTerminal("failed", { message: error.message });
        tracker.notifyWaiters({ outcome: "disconnected", error });
      }
    }
  }

  _writeJsonOnConn(conn, payload) {
    if (!conn || conn.closed || !conn.child?.stdin || conn.child.stdin.destroyed) {
      throw new Error("codex app-server stdin is not writable");
    }
    conn.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _rawRequestOnConn(conn, method, params, timeoutMs = 30_000) {
    if (!conn || conn.closed) {
      return Promise.reject(new Error("codex app-server connection is closed"));
    }
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingRequests.delete(String(id));
        reject(new Error(`Timed out waiting for codex app-server method '${method}' (${timeoutMs}ms)`));
      }, timeoutMs);

      conn.pendingRequests.set(String(id), { resolve, reject, timer, method });
      try {
        const msg = { jsonrpc: "2.0", id, method };
        if (params !== undefined) {
          msg.params = params;
        }
        this._writeJsonOnConn(conn, msg);
      } catch (err) {
        clearTimeout(timer);
        conn.pendingRequests.delete(String(id));
        reject(err);
      }
    });
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    await this.ensureConnected();
    this.touchIdleTimer();
    return this._rawRequestOnConn(this.activeConn, method, params, timeoutMs);
  }

  _handleStdoutLine(conn, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const key = String(msg.id);
      const pending = conn.pendingRequests.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      conn.pendingRequests.delete(key);
      if (msg.error) {
        const errMsg = msg.error.message || JSON.stringify(msg.error);
        const err = new Error(`[${pending.method}] ${errMsg}`);
        err.rpcError = msg.error;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && typeof msg.method === "string") {
      this._handleServerRequest(conn, msg);
      return;
    }

    if (typeof msg.method === "string") {
      this._handleNotification(msg);
    }
  }

  _getOrCreateTracker(threadId, turnId, requestedPolicy) {
    if (!threadId || !turnId) return null;
    const key = `${threadId}:${turnId}`;
    let tracker = this.turns.get(key);
    if (!tracker) {
      const initialPolicy =
        requestedPolicy || this.pendingTurnPolicyByThread.get(threadId) || "defer";
      tracker = new TurnTracker({
        threadId,
        turnId,
        approvalHandling: initialPolicy,
      });
      if (requestedPolicy) {
        tracker.policyLocked = true;
      }
      this.turns.set(key, tracker);
    } else if (requestedPolicy && !tracker.policyLocked) {
      tracker.approvalHandling = requestedPolicy;
      tracker.policyLocked = true;
    } else if (
      requestedPolicy &&
      tracker.policyLocked &&
      requestedPolicy !== tracker.approvalHandling &&
      !tracker.isTerminal()
    ) {
      tracker.warnings.push(
        `Ignored approvalHandling override '${requestedPolicy}' on already-active turn '${turnId}' (keeping '${tracker.approvalHandling}').`
      );
    }
    this.latestTurnByThread.set(threadId, tracker);
    return tracker;
  }

  _findExistingTracker(threadId, turnId) {
    if (threadId && turnId) {
      return this.turns.get(`${threadId}:${turnId}`) || null;
    }
    if (threadId) {
      const latest = this.latestTurnByThread.get(threadId);
      if (latest && !latest.isTerminal()) {
        return latest;
      }
    }
    return null;
  }

  _hasActiveTurnForThread(threadId) {
    for (const tracker of this.turns.values()) {
      if (tracker.threadId === threadId && !tracker.isTerminal()) {
        return true;
      }
    }
    return false;
  }

  _hasPendingApprovalsForThread(threadId) {
    for (const entry of this.pendingApprovals.values()) {
      if (entry.params?.threadId === threadId) return true;
    }
    return false;
  }

  _maybeUnsubscribeThread(threadId) {
    if (!threadId || !this.subscribedThreads.has(threadId)) return;
    if (this._hasActiveTurnForThread(threadId)) return;
    if (this._hasPendingApprovalsForThread(threadId)) return;
    this.safeUnsubscribe(threadId).catch(() => {});
  }

  _handleNotification(msg) {
    const p = msg.params || {};
    switch (msg.method) {
      case "turn/started": {
        if (p.threadId && p.turn?.id) {
          this._getOrCreateTracker(p.threadId, p.turn.id);
        }
        break;
      }
      case "item/agentMessage/delta": {
        const tracker =
          this._findExistingTracker(p.threadId, p.turnId) ||
          this._getOrCreateTracker(p.threadId, p.turnId);
        if (tracker) {
          tracker.recordMessageDelta(p.itemId, p.delta);
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const tracker =
          this._findExistingTracker(p.threadId, p.turnId) ||
          this._getOrCreateTracker(p.threadId, p.turnId);
        if (tracker && p.item) {
          tracker.recordItem(p.item);
        }
        break;
      }
      case "turn/plan/updated": {
        const tracker = this._findExistingTracker(p.threadId, p.turnId);
        if (tracker && Array.isArray(p.plan)) {
          tracker.latestPlan = p.plan
            .map((step) => `[${step.status || "pending"}] ${step.step || ""}`)
            .join("\n");
        }
        break;
      }
      case "turn/diff/updated": {
        const tracker = this._findExistingTracker(p.threadId, p.turnId);
        if (tracker && typeof p.diff === "string") {
          tracker.latestDiff = truncateText(p.diff, 8000);
        }
        break;
      }
      case "item/autoApprovalReview/completed": {
        const tracker = this._findExistingTracker(p.threadId, p.turnId);
        if (tracker) {
          tracker.guardianReviews.push({
            reviewId: p.reviewId,
            status: p.review?.status ?? null,
            riskLevel: p.review?.riskLevel ?? null,
            rationale: p.review?.rationale ?? null,
            action: p.action ?? null,
          });
        }
        break;
      }
      case "warning":
      case "guardianWarning": {
        const tracker = this._findExistingTracker(p.threadId, p.turnId);
        if (tracker) {
          tracker.warnings.push(p.message || JSON.stringify(p));
        }
        break;
      }
      case "error": {
        const tracker = this._findExistingTracker(p.threadId, p.turnId);
        if (tracker) {
          tracker.errors.push(p.error?.message || p.message || JSON.stringify(p));
        }
        break;
      }
      case "thread/closed": {
        if (p.threadId) {
          this.subscribedThreads.delete(p.threadId);
        }
        break;
      }
      case "serverRequest/resolved": {
        let affectedThreadId = p.threadId ?? null;
        if (p.requestId !== undefined) {
          for (const [aprId, entry] of this.pendingApprovals.entries()) {
            if (String(entry.rpcId) === String(p.requestId)) {
              affectedThreadId = affectedThreadId || entry.params?.threadId || null;
              this.pendingApprovals.delete(aprId);
              this.resolvedApprovalHistory.set(aprId, {
                resolvedAt: Date.now(),
                method: entry.method,
                resolvedBy: "server",
              });
            }
          }
        }
        if (affectedThreadId) {
          this._maybeUnsubscribeThread(affectedThreadId);
        }
        break;
      }
      case "turn/completed": {
        const turn = p.turn || {};
        const tracker =
          this._findExistingTracker(p.threadId, turn.id) ||
          this._getOrCreateTracker(p.threadId, turn.id);
        if (tracker) {
          if (Array.isArray(turn.items)) {
            for (const item of turn.items) {
              tracker.recordItem(item);
            }
          }
          tracker.markTerminal(
            turn.status || "completed",
            turn.error ?? null,
            turn.durationMs ?? null
          );
          tracker.notifyWaiters({ outcome: "completed" });
        }
        if (p.threadId) {
          this.pendingTurnPolicyByThread.delete(p.threadId);
          this._maybeUnsubscribeThread(p.threadId);
        }
        this.touchIdleTimer();
        break;
      }
      default:
        break;
    }
  }

  _getPendingApprovalsForScope(threadId = null, turnId = null) {
    const list = [];
    for (const entry of this.pendingApprovals.values()) {
      const entryThread = entry.params?.threadId ?? null;
      const entryTurn = entry.params?.turnId ?? null;
      if (threadId && entryThread !== threadId) continue;
      if (turnId && entryTurn && entryTurn !== turnId) continue;
      list.push({
        approvalId: entry.approvalId,
        scope: entryTurn ? "turn" : "thread",
        method: entry.method,
        params: entry.params,
        createdAt: entry.createdAt,
      });
    }
    return list;
  }

  _tryAutoRespond(method, params, policy) {
    if (policy === "defer") return null;
    const isAccept = policy === "accept_for_session" || policy === "accept_once";
    const isDecline = policy === "decline";
    if (!isAccept && !isDecline) return null;

    // Never auto-accept humanCommand checkpoints; those require a real human one-time decision.
    if (method === "item/commandExecution/requestApproval" && params?.kind === "humanCommand") {
      return isDecline ? { decision: "decline" } : null;
    }

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return {
          decision: isDecline
            ? "decline"
            : policy === "accept_for_session"
              ? "acceptForSession"
              : "accept",
        };

      case "execCommandApproval":
      case "applyPatchApproval":
        return {
          decision: mapLegacyReviewDecision(
            isDecline
              ? "decline"
              : policy === "accept_for_session"
                ? "acceptForSession"
                : "accept"
          ),
        };

      case "item/permissions/requestApproval":
        if (isDecline) {
          return { permissions: {}, scope: "turn" };
        }
        return {
          permissions: {
            ...(params?.permissions?.network ? { network: params.permissions.network } : {}),
            ...(params?.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
          },
          scope: policy === "accept_for_session" ? "session" : "turn",
        };

      case "mcpServer/elicitation/request": {
        if (isDecline) {
          return { action: "decline", content: null, _meta: null };
        }
        const requiredFields = params?.requestedSchema?.required;
        const props = params?.requestedSchema?.properties;
        const hasInputs =
          params?.mode === "url" ||
          (Array.isArray(requiredFields) && requiredFields.length > 0) ||
          (props && Object.keys(props).length > 0);
        if (!hasInputs && policy === "accept_for_session") {
          return { action: "accept", content: {}, _meta: null };
        }
        return null;
      }

      case "item/tool/requestUserInput": {
        if (isDecline || params?.isBlocking === false) {
          return isDecline ? { answers: {} } : null;
        }
        return null;
      }

      default:
        return null;
    }
  }

  _handleServerRequest(conn, msg) {
    const p = msg.params || {};
    const tracker = this._findExistingTracker(p.threadId, p.turnId);
    const policy =
      tracker?.approvalHandling ||
      (p.threadId ? this.pendingTurnPolicyByThread.get(p.threadId) : null) ||
      "defer";

    const autoReply = this._tryAutoRespond(msg.method, p, policy);
    if (autoReply !== null) {
      try {
        this._writeJsonOnConn(conn, { jsonrpc: "2.0", id: msg.id, result: autoReply });
        if (tracker) {
          tracker.autoApprovedEvents.push({
            method: msg.method,
            policy,
            summary: p.command || p.reason || p.serverName || msg.method,
          });
        }
        return;
      } catch {
        // Fall through to manual queue if write failed
      }
    }

    if (
      msg.method === "account/chatgptAuthTokens/refresh" ||
      msg.method === "attestation/generate"
    ) {
      try {
        this._writeJsonOnConn(conn, {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `${msg.method} is not handled by external bridge` },
        });
      } catch {}
      return;
    }

    const approvalId = `apr_${this.nextApprovalSeq++}`;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      rpcId: msg.id,
      method: msg.method,
      params: p,
      createdAt: Date.now(),
      conn,
    });

    if (tracker) {
      tracker.notifyWaiters({ outcome: "awaiting_approval", approvalId });
    }
  }

  async safeUnsubscribe(threadId) {
    this.subscribedThreads.delete(threadId);
    const conn = this.activeConn;
    if (!threadId || !conn || conn.closed) return;
    try {
      await this._rawRequestOnConn(conn, "thread/unsubscribe", { threadId }, 5_000);
    } catch {
      // Ignore if thread was already closed or not subscribed
    }
  }

  async _waitOnExistingTracker(tracker, waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
    const existingApprovals = this._getPendingApprovalsForScope(
      tracker.threadId,
      tracker.turnId
    );
    if (tracker.isTerminal() || existingApprovals.length > 0) {
      return tracker.toSummary(existingApprovals);
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        tracker.waiters.delete(onWake);
        resolve({ outcome: "timeout" });
      }, waitTimeoutMs);

      const onWake = (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      tracker.waiters.add(onWake);
    });

    const approvalsNow = this._getPendingApprovalsForScope(tracker.threadId, tracker.turnId);
    const summary = tracker.toSummary(approvalsNow);
    if (!tracker.isTerminal() && approvalsNow.length === 0) {
      summary.status = "running_in_background";
    }
    return summary;
  }

  async getTurnStatus(threadId, turnId, waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
    if (!threadId || !turnId) {
      throw new Error("Both threadId and turnId are required.");
    }
    const tracker = this.turns.get(`${threadId}:${turnId}`);
    if (!tracker) {
      throw new Error(
        `Turn '${turnId}' on thread '${threadId}' is not active in this bridge process (it may have never been started here or already expired). Use codex_thread_read to inspect persisted history.`
      );
    }
    return this._waitOnExistingTracker(tracker, waitTimeoutMs);
  }

  async resolveComputerUseCapability(threadId, cwd) {
    const cwds = cwd ? [cwd] : [];
    const [mcpRes, skillRes, pluginRes] = await Promise.allSettled([
      this.request("mcpServerStatus/list", {
        limit: 50,
        ...(threadId ? { threadId } : {}),
      }),
      this.request("skills/list", { cwds, forceReload: false }, 15_000),
      this.request("plugin/list", { cwds }, 15_000),
    ]);

    const enabledCuPlugins = [];
    if (pluginRes.status === "fulfilled") {
      for (const mp of pluginRes.value?.marketplaces || []) {
        for (const pl of mp.plugins || []) {
          if (
            `${pl.id} ${pl.name}`.toLowerCase().includes("computer-use") &&
            pl.installed &&
            pl.enabled
          ) {
            enabledCuPlugins.push(pl.id || pl.name);
          }
        }
      }
    }

    let cuaServer = null;
    if (mcpRes.status === "fulfilled") {
      for (const s of mcpRes.value?.data || []) {
        const isCua =
          s.name === "cua_repl" ||
          String(s.pluginId || "").toLowerCase().includes("computer-use") ||
          s.name.toLowerCase().includes("computer");
        if (isCua) {
          const toolNames = Object.keys(s.tools || {});
          cuaServer = {
            name: s.name,
            pluginId: s.pluginId ?? null,
            runtimeStatus: s.runtimeStatus ?? null,
            toolNames,
            toolCount: toolNames.length,
            toolsError: s.toolsError ?? null,
          };
          if (cuaServer.toolCount > 0 && !cuaServer.toolsError) {
            break;
          }
        }
      }
    }

    let cuSkill = null;
    if (skillRes.status === "fulfilled") {
      for (const entry of skillRes.value?.data || []) {
        for (const skill of entry.skills || []) {
          const idLower = `${skill.name || ""} ${skill.pluginId || ""}`.toLowerCase();
          if (
            (idLower.includes("computer-use") || idLower.includes("computer_use")) &&
            skill.enabled
          ) {
            cuSkill = skill;
            break;
          }
        }
        if (cuSkill) break;
      }
    }

    const cuaReady = Boolean(
      cuaServer && cuaServer.toolCount > 0 && !cuaServer.toolsError
    );
    const skillReady = Boolean(cuSkill);

    return {
      ready: (enabledCuPlugins.length > 0 || skillReady) && (cuaReady || skillReady),
      mode: cuaReady ? "cua_repl" : skillReady ? "skill" : null,
      enabledPlugins: enabledCuPlugins,
      cuaServer,
      skill: cuSkill,
    };
  }

  async runTurn(options) {
    const {
      mode = "new", // "new" | "fork" | "resume"
      threadId: inputThreadId,
      prompt,
      cwd,
      title,
      sectionId,
      model,
      effort,
      sandbox,
      approvalPolicy,
      approvalsReviewer,
      approvalHandling = "defer",
      useComputerUse = false,
      skills = [],
      images = [],
      ephemeral = false,
      waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    } = options;

    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("Non-empty 'prompt' string is required.");
    }
    if (ephemeral && sectionId !== undefined && sectionId !== null) {
      throw new Error("Cannot combine ephemeral=true with sectionId (ephemeral threads cannot be placed in sections).");
    }

    await this.ensureConnected();

    // Only apply opinionated defaults on 'new'; 'fork' and 'resume' inherit the source thread's settings unless explicitly overridden.
    const effectiveSandbox = sandbox ?? (mode === "new" ? "workspace-write" : undefined);
    const effectiveApprovalPolicy =
      approvalPolicy ?? (mode === "new" ? "on-request" : undefined);
    const effectiveReviewer = approvalsReviewer ?? (mode === "new" ? "user" : undefined);

    let threadInfo;
    if (mode === "new") {
      threadInfo = await this.request("thread/start", {
        cwd: cwd || process.cwd(),
        ...(model ? { model } : {}),
        ...(effectiveSandbox !== undefined ? { sandbox: effectiveSandbox } : {}),
        ...(effectiveApprovalPolicy !== undefined
          ? { approvalPolicy: effectiveApprovalPolicy }
          : {}),
        ...(effectiveReviewer !== undefined ? { approvalsReviewer: effectiveReviewer } : {}),
        ephemeral,
      });
    } else if (mode === "fork") {
      if (!inputThreadId) {
        throw new Error("threadId is required when mode='fork'");
      }
      threadInfo = await this.request("thread/fork", {
        threadId: inputThreadId,
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(effectiveSandbox !== undefined ? { sandbox: effectiveSandbox } : {}),
        ...(effectiveApprovalPolicy !== undefined
          ? { approvalPolicy: effectiveApprovalPolicy }
          : {}),
        ...(effectiveReviewer !== undefined ? { approvalsReviewer: effectiveReviewer } : {}),
        ephemeral,
        excludeTurns: true,
      });
    } else if (mode === "resume") {
      if (!inputThreadId) {
        throw new Error("threadId is required when mode='resume'");
      }
      threadInfo = await this.request("thread/resume", {
        threadId: inputThreadId,
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(effectiveSandbox !== undefined ? { sandbox: effectiveSandbox } : {}),
        ...(effectiveApprovalPolicy !== undefined
          ? { approvalPolicy: effectiveApprovalPolicy }
          : {}),
        ...(effectiveReviewer !== undefined ? { approvalsReviewer: effectiveReviewer } : {}),
      });
    } else {
      throw new Error(`Unsupported mode '${mode}'. Expected 'new', 'fork', or 'resume'.`);
    }

    const threadId = threadInfo?.thread?.id;
    if (!threadId) {
      throw new Error("Failed to obtain threadId from codex app-server");
    }
    this.subscribedThreads.add(threadId);

    const metadataWarnings = [];
    try {
      if (title) {
        await this.request("thread/name/set", { threadId, name: title }).catch((err) => {
          metadataWarnings.push(`thread/name/set failed: ${err.message}`);
        });
      }
      if (sectionId !== undefined) {
        await this.request("thread/section/move", { threadId, sectionId }).catch((err) => {
          metadataWarnings.push(`thread/section/move failed: ${err.message}`);
        });
      }

      const inputItems = [];
      let computerUseMode = null;

      if (useComputerUse) {
        const cuCap = await this.resolveComputerUseCapability(
          threadId,
          cwd || threadInfo?.cwd
        );
        if (!cuCap.ready) {
          const reason = cuCap.cuaServer?.toolsError
            ? `cua_repl reported error: ${cuCap.cuaServer.toolsError}`
            : cuCap.enabledPlugins.length === 0
              ? "neither unified-computer-use nor computer-use plugin is enabled in ~/.codex"
              : "cua_repl exposed 0 tools and no computer-use skill was found";
          throw new Error(
            `Computer Use requested (useComputerUse=true), but it is not ready (${reason}). Enable Computer Use in Codex.app first.`
          );
        }
        computerUseMode = cuCap.mode;
        if (cuCap.skill) {
          inputItems.push({
            type: "skill",
            name: cuCap.skill.name,
            path: cuCap.skill.path,
          });
        }
      }

      if (Array.isArray(skills) && skills.length > 0) {
        const requestedSkillNames = new Set(skills);
        const skillRes = await this.request("skills/list", {
          cwds: [cwd || threadInfo?.cwd || process.cwd()],
        });
        const seenPaths = new Set(inputItems.map((i) => i.path));
        for (const entry of skillRes?.data || []) {
          for (const sk of entry.skills || []) {
            if (requestedSkillNames.has(sk.name) && !seenPaths.has(sk.path)) {
              seenPaths.add(sk.path);
              inputItems.push({ type: "skill", name: sk.name, path: sk.path });
            }
          }
        }
      }

      for (const imgPath of images) {
        inputItems.push({ type: "localImage", path: imgPath });
      }

      inputItems.push({
        type: "text",
        text: prompt,
        text_elements: [],
      });

      let disabledPluginIds = undefined;
      if (useComputerUse && Array.isArray(threadInfo?.disabledPluginIds)) {
        disabledPluginIds = threadInfo.disabledPluginIds.filter(
          (id) => !String(id).toLowerCase().includes("computer-use")
        );
      }

      if (!this._hasActiveTurnForThread(threadId)) {
        this.pendingTurnPolicyByThread.set(threadId, approvalHandling);
      }

      const turnRes = await this.request("turn/start", {
        threadId,
        input: inputItems,
        ...(disabledPluginIds !== undefined ? { disabledPluginIds } : {}),
        ...(effort ? { effort } : {}),
        ...(model ? { model } : {}),
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        ...(approvalsReviewer !== undefined ? { approvalsReviewer } : {}),
      });

      const turnId = turnRes?.turn?.id;
      if (!turnId) {
        throw new Error("codex app-server turn/start did not return a turn.id");
      }

      const tracker = this._getOrCreateTracker(threadId, turnId, approvalHandling);
      for (const mw of metadataWarnings) {
        tracker.warnings.push(mw);
      }

      const summary = await this._waitOnExistingTracker(tracker, waitTimeoutMs);
      return {
        mode,
        forkedFromThreadId: mode === "fork" ? inputThreadId : null,
        model: threadInfo?.model ?? null,
        cwd: threadInfo?.cwd ?? cwd ?? null,
        computerUseMode,
        ...summary,
      };
    } catch (err) {
      this.pendingTurnPolicyByThread.delete(threadId);
      this._maybeUnsubscribeThread(threadId);
      throw err;
    }
  }

  async interruptTurn(threadId, turnId, settleTimeoutMs = 5_000) {
    if (!threadId || !turnId) {
      throw new Error("threadId and turnId are required to interrupt a turn.");
    }
    const res = await this.request("turn/interrupt", { threadId, turnId });
    const tracker = this.turns.get(`${threadId}:${turnId}`);
    if (tracker && !tracker.isTerminal()) {
      await this._waitOnExistingTracker(tracker, settleTimeoutMs);
    }
    if (!this._hasPendingApprovalsForThread(threadId)) {
      await this.safeUnsubscribe(threadId);
    }
    return {
      interrupted: true,
      threadId,
      turnId,
      status: tracker?.status ?? "interrupted",
      result: res,
    };
  }

  async runReview({
    cwd,
    targetType = "uncommittedChanges",
    branch,
    sha,
    instructions,
    ephemeral = false,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  }) {
    await this.ensureConnected();
    const threadInfo = await this.request("thread/start", {
      cwd: cwd || process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral,
    });
    const threadId = threadInfo?.thread?.id;
    if (!threadId) {
      throw new Error("Failed to start review thread");
    }
    this.subscribedThreads.add(threadId);

    try {
      let target;
      switch (targetType) {
        case "baseBranch":
          if (!branch) throw new Error("branch is required when targetType='baseBranch'");
          target = { type: "baseBranch", branch };
          break;
        case "commit":
          if (!sha) throw new Error("sha is required when targetType='commit'");
          target = { type: "commit", sha, title: null };
          break;
        case "custom":
          if (!instructions) {
            throw new Error("instructions is required when targetType='custom'");
          }
          target = { type: "custom", instructions };
          break;
        case "uncommittedChanges":
        default:
          target = { type: "uncommittedChanges" };
          break;
      }

      this.pendingTurnPolicyByThread.set(threadId, "decline");
      const revRes = await this.request("review/start", {
        threadId,
        target,
      });
      const turnId = revRes?.turn?.id;
      const tracker = this._getOrCreateTracker(threadId, turnId, "decline");
      const summary = await this._waitOnExistingTracker(tracker, waitTimeoutMs);
      return {
        reviewThreadId: revRes?.reviewThreadId || threadId,
        target,
        ...summary,
      };
    } catch (err) {
      this.pendingTurnPolicyByThread.delete(threadId);
      this._maybeUnsubscribeThread(threadId);
      throw err;
    }
  }

  async respondToApproval({
    approvalId,
    decision,
    scope = "turn",
    permissions = null,
    content = null,
    answers = null,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  }) {
    if (!approvalId || typeof approvalId !== "string") {
      throw new Error("Non-empty 'approvalId' string is required.");
    }
    if (!VALID_DECISIONS.has(decision)) {
      throw new Error(
        `Explicit 'decision' is required and must be one of: ${Array.from(VALID_DECISIONS).join(", ")}.`
      );
    }

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      const prev = this.resolvedApprovalHistory.get(approvalId);
      if (prev) {
        throw new Error(
          `Approval '${approvalId}' (${prev.method}) was already resolved at ${new Date(prev.resolvedAt).toISOString()}.`
        );
      }
      throw new Error(
        `Approval '${approvalId}' not found. Call codex_pending_approvals to inspect active requests.`
      );
    }

    const { rpcId, method, params, conn } = pending;
    let resultPayload;

    switch (method) {
      case "item/commandExecution/requestApproval": {
        if (params?.kind === "humanCommand" && !HUMAN_COMMAND_DECISIONS.has(decision)) {
          throw new Error(
            `humanCommand checkpoint only accepts one-time decisions: accept, decline, or cancel (got '${decision}').`
          );
        }
        if (
          Array.isArray(params?.availableDecisions) &&
          params.availableDecisions.length > 0 &&
          !params.availableDecisions.includes(decision)
        ) {
          throw new Error(
            `Decision '${decision}' is not in availableDecisions (${JSON.stringify(params.availableDecisions)}).`
          );
        }
        resultPayload = { decision };
        break;
      }

      case "item/fileChange/requestApproval":
        resultPayload = { decision };
        break;

      case "execCommandApproval":
      case "applyPatchApproval":
        resultPayload = { decision: mapLegacyReviewDecision(decision) };
        break;

      case "item/permissions/requestApproval": {
        if (decision === "decline" || decision === "cancel") {
          resultPayload = { permissions: {}, scope: "turn" };
        } else {
          const granted = permissions ?? {
            ...(params?.permissions?.network ? { network: params.permissions.network } : {}),
            ...(params?.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
          };
          resultPayload = {
            permissions: granted,
            scope: decision === "acceptForSession" ? "session" : scope,
          };
        }
        break;
      }

      case "mcpServer/elicitation/request": {
        const action =
          decision === "accept" || decision === "acceptForSession"
            ? "accept"
            : decision === "cancel"
              ? "cancel"
              : "decline";
        if (action === "accept") {
          const reqFields = params?.requestedSchema?.required;
          if (Array.isArray(reqFields) && reqFields.length > 0) {
            if (!content || typeof content !== "object") {
              throw new Error(
                `MCP elicitation requires structured 'content' fields: ${reqFields.join(", ")}.`
              );
            }
            for (const rf of reqFields) {
              if (!(rf in content)) {
                throw new Error(`Missing required field '${rf}' in 'content' for MCP elicitation.`);
              }
            }
          }
        }
        resultPayload = {
          action,
          content: action === "accept" ? content ?? {} : null,
          _meta: null,
        };
        break;
      }

      case "item/tool/requestUserInput": {
        const formattedAnswers = {};
        if (decision === "accept" || decision === "acceptForSession") {
          if (!answers || typeof answers !== "object") {
            throw new Error(
              "Answering 'item/tool/requestUserInput' with accept requires an 'answers' object mapping question IDs to answers."
            );
          }
          for (const [qId, val] of Object.entries(answers)) {
            formattedAnswers[qId] = Array.isArray(val)
              ? { answers: val.map(String) }
              : { answers: [String(val)] };
          }
        }
        resultPayload = { answers: formattedAnswers };
        break;
      }

      default:
        resultPayload = content ?? { decision };
        break;
    }

    this._writeJsonOnConn(conn, { jsonrpc: "2.0", id: rpcId, result: resultPayload });
    this.pendingApprovals.delete(approvalId);
    this.resolvedApprovalHistory.set(approvalId, {
      resolvedAt: Date.now(),
      method,
      decision,
    });

    const threadId = params?.threadId ?? null;
    const turnId = params?.turnId ?? null;
    if (threadId && turnId && waitTimeoutMs > 0) {
      const tracker = this.turns.get(`${threadId}:${turnId}`);
      if (tracker) {
        const summary = await this._waitOnExistingTracker(tracker, waitTimeoutMs);
        this._maybeUnsubscribeThread(threadId);
        return summary;
      }
    }

    if (threadId) {
      this._maybeUnsubscribeThread(threadId);
    }
    return {
      resolved: true,
      approvalId,
      method,
      decision,
      scope: turnId ? "turn" : "thread",
      threadId,
      turnId,
    };
  }

  close() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const conn = this.activeConn;
    if (conn) {
      this._killConnProcess(conn);
      this._teardownConnection(conn, new Error("Client closed"));
    }
  }
}
