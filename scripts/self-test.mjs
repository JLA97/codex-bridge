#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(PLUGIN_DIR, "server", "index.mjs");

test("connection isolation across delayed child exit and failed initialization", async () => {
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const origSpawn = childProcess.spawn;
  const children = [];
  let rejectInit = false;

  childProcess.spawn = () => {
    const child = new EventEmitter();
    children.push(child);
    const shouldReject = rejectInit;
    rejectInit = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(bytes, _enc, done) {
        const msg = JSON.parse(bytes.toString());
        if (msg.method === "initialize") {
          const reply = shouldReject
            ? { id: msg.id, error: { code: -32603, message: "fixture init failure" } }
            : { id: msg.id, result: { userAgent: "fixture", platformOs: "macos" } };
          queueMicrotask(() => child.stdout.write(`${JSON.stringify(reply)}\n`));
        }
        done();
      },
    });
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    return child;
  };
  syncBuiltinESMExports();

  try {
    const { CodexAppServerClient } = await import(
      `${pathToFileURL(path.join(PLUGIN_DIR, "server", "app-server-client.mjs")).href}?t=${Date.now()}`
    );

    const first = new CodexAppServerClient({ codexBin: "codex", idleShutdownMs: 0 });
    await first.ensureConnected();
    const old = first.child;
    first.close();
    await first.ensureConnected();
    const replacement = first.child;
    old.emit("exit", 0, null);
    assert.equal(first.child, replacement);
    assert.ok(first.serverInfo);
    first.close();

    const second = new CodexAppServerClient({ codexBin: "codex", idleShutdownMs: 0 });
    rejectInit = true;
    await assert.rejects(second.ensureConnected(), /fixture init failure/);
    assert.equal(children.at(-1).killed, true);
    assert.equal(second.child, null);
  } finally {
    childProcess.spawn = origSpawn;
    syncBuiltinESMExports();
    for (const c of children) {
      c.stdout.end();
      c.stderr.end();
      c.stdin.end();
    }
  }
});

test("CUA readiness check, fail-fast on broken cua_repl, fork inheritance, and approval safety", async () => {
  const { CodexAppServerClient } = await import(
    pathToFileURL(path.join(PLUGIN_DIR, "server", "app-server-client.mjs")).href
  );
  const { executeTool } = await import(
    pathToFileURL(path.join(PLUGIN_DIR, "server", "tools.mjs")).href
  );

  // Broken CUA catalog -> ready=false & fail-fast + unsubscribe
  {
    const client = new CodexAppServerClient({ idleShutdownMs: 0 });
    let unsubscribedThread = null;
    client.ensureConnected = async () => ({ codexHome: "/nonexistent" });
    client.safeUnsubscribe = async (tid) => {
      unsubscribedThread = tid;
    };
    client.request = async (method) => {
      switch (method) {
        case "getAuthStatus":
          return {};
        case "plugin/list":
          return {
            marketplaces: [
              {
                name: "openai-bundled",
                plugins: [
                  {
                    id: "unified-computer-use@openai-bundled",
                    name: "unified-computer-use",
                    installed: true,
                    enabled: true,
                  },
                ],
              },
            ],
          };
        case "skills/list":
          return { data: [{ skills: [] }] };
        case "mcpServerStatus/list":
          return { data: [{ name: "cua_repl", tools: {}, toolsError: "startup failure" }] };
        case "threadSection/list":
          return { data: [] };
        case "thread/start":
          return { thread: { id: "thr_cua_fail" }, cwd: process.cwd(), disabledPluginIds: [] };
        default:
          throw new Error(method);
      }
    };

    const caps = await executeTool(client, "codex_capabilities", {});
    assert.equal(caps.computerUse.ready, false);

    await assert.rejects(
      executeTool(client, "codex_turn_send", { prompt: "click", useComputerUse: true }),
      /not ready.*startup failure/i
    );
    assert.equal(unsubscribedThread, "thr_cua_fail");
  }

  // Approval validation, policy lock & legacy ReviewDecision mapping
  {
    const client = new CodexAppServerClient({ idleShutdownMs: 0 });
    const sent = [];
    client.activeConn = { closed: false, pendingRequests: new Map() };
    client._writeJsonOnConn = (_conn, msg) => sent.push(msg);
    client.ensureConnected = async () => ({});
    client.request = async (method) => {
      if (method === "thread/resume") return { thread: { id: "thr_1" } };
      if (method === "turn/start") return { turn: { id: "turn_1" } };
      throw new Error(method);
    };

    await client.runTurn({
      mode: "resume",
      threadId: "thr_1",
      prompt: "first",
      approvalHandling: "defer",
      waitTimeoutMs: 5,
    });
    await client.runTurn({
      mode: "resume",
      threadId: "thr_1",
      prompt: "steer",
      approvalHandling: "accept_for_session",
      waitTimeoutMs: 5,
    });

    client._handleServerRequest(client.activeConn, {
      id: 301,
      method: "item/commandExecution/requestApproval",
      params: { kind: "humanCommand", threadId: "thr_1", turnId: "turn_1", itemId: "it_1" },
    });

    const pending = client._getPendingApprovalsForScope("thr_1", "turn_1");
    assert.equal(pending.length, 1);

    await assert.rejects(
      executeTool(client, "codex_approval_respond", { approvalId: pending[0].approvalId }),
      /Missing required argument 'decision'/
    );

    await assert.rejects(
      executeTool(client, "codex_approval_respond", {
        approvalId: pending[0].approvalId,
        decision: "acceptForSession",
        waitTimeoutMs: 0,
      }),
      /humanCommand checkpoint only accepts one-time decisions/
    );

    await executeTool(client, "codex_approval_respond", {
      approvalId: pending[0].approvalId,
      decision: "accept",
      waitTimeoutMs: 0,
    });
    assert.equal(sent.at(-1).result.decision, "accept");

    await assert.rejects(
      executeTool(client, "codex_turn_status", {
        threadId: "unknown",
        turnId: "unknown",
        waitTimeoutMs: 500,
      }),
      /not active in this bridge process/
    );
  }
});

test("MCP protocol negotiation, split Content-Length framing, and CLI guardrails", async () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function openMcp() {
    const child = spawn(process.execPath, [SERVER_ENTRY, "--mcp"], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    const closed = once(child, "close");
    return {
      child,
      async finish() {
        child.stdin.end();
        const [code] = await closed;
        assert.equal(code, 0, err);
        return out;
      },
    };
  }

  try {
    // Unknown version negotiates to 2025-03-26
    {
      const { child, finish } = openMcp();
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        })}\n`
      );
      const res = JSON.parse((await finish()).trim());
      assert.equal(res.result.protocolVersion, "2025-03-26");
    }

    // Split Content-Length prefix
    {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      const { child, finish } = openMcp();
      await once(child, "spawn");
      child.stdin.write(frame.slice(0, 6));
      await delay(50);
      child.stdin.write(frame.slice(6));
      const raw = await finish();
      assert.match(raw, /^Content-Length: \d+\r\n\r\n\{/);
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("Windows spawn spec resolution, PATH precedence, .cmd quoting, and env preservation", async () => {
  const { resolveCodexSpawnSpec, buildChildEnv } = await import(
    pathToFileURL(path.join(PLUGIN_DIR, "server", "app-server-client.mjs")).href
  );

  // 1. PATH takes precedence over APPDATA\npm fallback (e.g. nvm/scoop/native codex.exe)
  {
    const existing = new Set([
      "C:\\Tools\\Codex\\codex.exe",
      "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    ]);
    const spec = resolveCodexSpawnSpec(null, [], {
      platform: "win32",
      env: {
        PATH: '"C:\\Tools\\Codex";C:\\Users\\Alice\\AppData\\Roaming\\npm',
        APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      },
      existsSync: (p) => existing.has(p),
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    assert.equal(spec.command, "C:\\Tools\\Codex\\codex.exe");
    assert.deepEqual(spec.args, ["app-server", "--stdio"]);
    assert.equal(spec.displayBin, "C:\\Tools\\Codex\\codex.exe");
    assert.equal(spec.windowsVerbatimArguments, undefined);
  }

  // 2. npm codex.cmd on PATH resolves sibling codex.js and runs via node execPath
  {
    const npmDir = "C:\\Users\\Alice Smith\\AppData\\Roaming\\npm";
    const cmdPath = `${npmDir}\\codex.cmd`;
    const jsPath = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const existing = new Set([cmdPath, jsPath]);
    const spec = resolveCodexSpawnSpec(null, [], {
      platform: "win32",
      env: { PATH: npmDir, APPDATA: "C:\\Users\\Alice Smith\\AppData\\Roaming" },
      existsSync: (p) => existing.has(p),
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    assert.equal(spec.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(spec.args, [jsPath, "app-server", "--stdio"]);
    assert.equal(spec.displayBin, jsPath);
  }

  // 3. Fallback to APPDATA\npm codex.js when PATH does not contain codex
  {
    const jsPath =
      "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    const existing = new Set([jsPath]);
    const spec = resolveCodexSpawnSpec(null, [], {
      platform: "win32",
      env: { PATH: "C:\\Windows\\System32", APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
      existsSync: (p) => existing.has(p),
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    });
    assert.equal(spec.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(spec.args, [jsPath, "app-server", "--stdio"]);
  }

  // 4. .cmd fallback with spaces in path and args uses outer-quoted /s /c + windowsVerbatimArguments
  {
    const cmdPath = "C:\\Program Files\\Custom Codex\\codex.cmd";
    const existing = new Set([cmdPath]);
    const spec = resolveCodexSpawnSpec(cmdPath, ["--profile", "my work"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      existsSync: (p) => existing.has(p),
    });
    assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(spec.args, [
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\Custom Codex\\codex.cmd" app-server --stdio --profile "my work""',
    ]);
    assert.equal(spec.windowsVerbatimArguments, true);
    assert.equal(spec.displayBin, cmdPath);
  }

  // 5. Missing backslash CODEX_BIN throws immediately
  assert.throws(
    () =>
      resolveCodexSpawnSpec("C:\\Missing\\codex.exe", [], {
        platform: "win32",
        env: {},
        existsSync: () => false,
      }),
    /Configured CODEX_BIN path does not exist/
  );

  // 6. buildChildEnv preserves Windows PATH without ':' splitting
  {
    const winPath = "C:\\Program Files\\nodejs;C:\\Users\\Alice\\AppData\\Roaming\\npm";
    const env = buildChildEnv(
      { EXTRA_FLAG: "1" },
      { platform: "win32", env: { PATH: winPath } }
    );
    assert.equal(env.PATH, winPath);
    assert.equal(env.EXTRA_FLAG, "1");
  }
});
