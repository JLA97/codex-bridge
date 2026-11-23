#!/usr/bin/env node
import { CodexAppServerClient } from "./app-server-client.mjs";
import { TOOL_DEFINITIONS, executeTool } from "./tools.mjs";

const SERVER_NAME = "codex-bridge";
const SERVER_VERSION = "0.2.0";
const SUPPORTED_MCP_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PREFERRED_FALLBACK_PROTOCOL = "2025-03-26";
const MAX_MCP_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB cap

const STATEFUL_MCP_ONLY_TOOLS = new Set([
  "codex_turn_status",
  "codex_pending_approvals",
  "codex_approval_respond",
]);

function negotiateProtocolVersion(requested) {
  if (typeof requested === "string" && SUPPORTED_MCP_PROTOCOLS.includes(requested)) {
    return requested;
  }
  return PREFERRED_FALLBACK_PROTOCOL;
}

/**
 * Stdio MCP server supporting standard newline-delimited JSON (MCP stdio spec)
 * and split-safe Content-Length header framing.
 */
function startMcpServer() {
  const client = new CodexAppServerClient();
  let framingMode = null; // "jsonl" | "content-length"
  let buffer = Buffer.alloc(0);

  let inFlight = 0;
  let pendingWrites = 0;
  let stdinEnded = false;

  const maybeFinishAfterEnd = () => {
    if (stdinEnded && inFlight === 0 && pendingWrites === 0) {
      client.close();
      process.exit(0);
    }
  };

  function sendMcpMessage(payload) {
    const json = JSON.stringify(payload);
    const wire =
      framingMode === "content-length"
        ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
        : `${json}\n`;
    pendingWrites++;
    process.stdout.write(wire, () => {
      pendingWrites--;
      maybeFinishAfterEnd();
    });
  }

  function dispatchMcpMessage(msg) {
    inFlight++;
    Promise.resolve(handleMcpRequest(msg)).finally(() => {
      inFlight--;
      maybeFinishAfterEnd();
    });
  }

  async function handleMcpRequest(msg) {
    if (!msg || typeof msg !== "object") return;

    // Notifications from MCP host (e.g. notifications/initialized, notifications/cancelled)
    // Note: notifications/cancelled intentionally does not kill the underlying Codex turn;
    // callers use codex_turn_interrupt explicitly when they want to abort Codex execution.
    if (msg.id === undefined) {
      return;
    }

    const { id, method, params } = msg;
    try {
      switch (method) {
        case "initialize": {
          const negotiated = negotiateProtocolVersion(params?.protocolVersion);
          sendMcpMessage({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: negotiated,
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION,
              },
            },
          });
          return;
        }

        case "ping": {
          sendMcpMessage({ jsonrpc: "2.0", id, result: {} });
          return;
        }

        case "tools/list": {
          sendMcpMessage({
            jsonrpc: "2.0",
            id,
            result: {
              tools: TOOL_DEFINITIONS,
            },
          });
          return;
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments ?? {};
          try {
            const output = await executeTool(client, toolName, toolArgs);
            sendMcpMessage({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(output, null, 2),
                  },
                ],
                isError: false,
              },
            });
          } catch (toolErr) {
            sendMcpMessage({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        error: toolErr.message || String(toolErr),
                        rpcError: toolErr.rpcError ?? null,
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              },
            });
          }
          return;
        }

        case "resources/list": {
          sendMcpMessage({ jsonrpc: "2.0", id, result: { resources: [] } });
          return;
        }

        case "prompts/list": {
          sendMcpMessage({ jsonrpc: "2.0", id, result: { prompts: [] } });
          return;
        }

        default: {
          sendMcpMessage({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
        }
      }
    } catch (err) {
      sendMcpMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err.message || String(err),
        },
      });
    }
  }

  function detectFramingIfNeeded() {
    if (framingMode) return true;
    // Trim leading whitespace bytes before inspecting prefix
    let start = 0;
    while (
      start < buffer.length &&
      (buffer[start] === 0x20 ||
        buffer[start] === 0x09 ||
        buffer[start] === 0x0d ||
        buffer[start] === 0x0a)
    ) {
      start++;
    }
    if (start > 0) {
      buffer = buffer.subarray(start);
    }
    if (buffer.length === 0) return false;

    if (buffer[0] === 0x7b /* '{' */) {
      framingMode = "jsonl";
      return true;
    }

    const headerPrefix = "content-length:";
    const slice = buffer
      .subarray(0, Math.min(buffer.length, headerPrefix.length))
      .toString("utf8")
      .toLowerCase();

    if (headerPrefix.startsWith(slice)) {
      if (slice.length < headerPrefix.length) {
        // Partial "Content-Length:" header split across chunks — wait for remaining bytes
        return false;
      }
      framingMode = "content-length";
      return true;
    }

    framingMode = "jsonl";
    return true;
  }

  function drainBuffer() {
    if (buffer.length > MAX_MCP_BUFFER_BYTES) {
      buffer = Buffer.alloc(0);
      sendMcpMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Incoming MCP frame exceeded ${MAX_MCP_BUFFER_BYTES} bytes limit.`,
        },
      });
      return;
    }

    while (buffer.length > 0) {
      if (!detectFramingIfNeeded()) {
        return;
      }

      if (framingMode === "content-length") {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const bodyLen = Number(match[1]);
        if (bodyLen > MAX_MCP_BUFFER_BYTES) {
          buffer = Buffer.alloc(0);
          return;
        }
        const totalLen = headerEnd + 4 + bodyLen;
        if (buffer.length < totalLen) return;
        const jsonSlice = buffer.subarray(headerEnd + 4, totalLen).toString("utf8");
        buffer = buffer.subarray(totalLen);
        try {
          dispatchMcpMessage(JSON.parse(jsonSlice));
        } catch {}
      } else {
        const nlIdx = buffer.indexOf(0x0a); // \n
        if (nlIdx === -1) return;
        const line = buffer.subarray(0, nlIdx).toString("utf8").trim();
        buffer = buffer.subarray(nlIdx + 1);
        if (!line) continue;
        try {
          dispatchMcpMessage(JSON.parse(line));
        } catch {}
      }
    }
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drainBuffer();
  });

  const cleanup = () => {
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeFinishAfterEnd();
  });
}

function printCliHelp() {
  console.log(`codex-bridge v${SERVER_VERSION} — Codex App Server MCP & One-Shot CLI Bridge

Usage:
  node index.mjs --mcp                        Run persistent MCP stdio server (supports approvals & polling)
  node index.mjs call <toolName> [jsonArgs]   Run a self-contained one-shot tool call and output JSON
  node index.mjs tools                        List available tool schemas as JSON

One-Shot CLI Shortcuts:
  node index.mjs capabilities [cwd]
  node index.mjs threads [limit] [searchTerm]
  node index.mjs read <threadId> [turnLimit]
  node index.mjs send <prompt> [--cwd DIR] [--fork THREAD_ID] [--computer-use] [--guardian | --auto-approve]

Note: Interactive approval pause/resume ('defer') and cross-call turn polling require the persistent MCP server.
`);
}

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printCliHelp();
    return;
  }
  if (cmd === "tools") {
    console.log(JSON.stringify(TOOL_DEFINITIONS, null, 2));
    return;
  }

  const client = new CodexAppServerClient({ idleShutdownMs: 0 });
  try {
    let result;
    if (cmd === "call") {
      const [toolName, rawJson] = rest;
      if (!toolName) throw new Error("Missing <toolName>. Run with 'tools' to list.");
      if (STATEFUL_MCP_ONLY_TOOLS.has(toolName)) {
        throw new Error(
          `Tool '${toolName}' requires in-memory state across calls and can only be used via the persistent MCP server ('codex-bridge_app-server'), not one-shot CLI.`
        );
      }
      const parsed = rawJson ? JSON.parse(rawJson) : {};
      if (toolName === "codex_turn_send" && (!parsed.approvalHandling || parsed.approvalHandling === "defer")) {
        throw new Error(
          "One-shot CLI 'codex_turn_send' cannot pause across invocations with approvalHandling='defer'. Use the persistent MCP server for interactive approvals, or explicitly pass approvalHandling='decline' | 'accept_once' | 'accept_for_session' (or approvalsReviewer='guardian_subagent')."
        );
      }
      result = await executeTool(client, toolName, parsed);
    } else if (cmd === "capabilities") {
      result = await executeTool(client, "codex_capabilities", {
        ...(rest[0] ? { cwd: rest[0] } : {}),
      });
    } else if (cmd === "threads") {
      result = await executeTool(client, "codex_thread_list", {
        limit: rest[0] ? Number(rest[0]) : 15,
        ...(rest[1] ? { searchTerm: rest[1] } : {}),
      });
    } else if (cmd === "read") {
      if (!rest[0]) throw new Error("Usage: read <threadId> [turnLimit]");
      result = await executeTool(client, "codex_thread_read", {
        threadId: rest[0],
        turnLimit: rest[1] ? Number(rest[1]) : 5,
      });
    } else if (cmd === "send") {
      const promptParts = [];
      const opts = {
        mode: "new",
        approvalHandling: "decline",
        waitTimeoutMs: 120_000,
      };
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--cwd" && rest[i + 1]) {
          opts.cwd = rest[++i];
        } else if (arg === "--fork" && rest[i + 1]) {
          opts.mode = "fork";
          opts.threadId = rest[++i];
        } else if (arg === "--resume" && rest[i + 1]) {
          opts.mode = "resume";
          opts.threadId = rest[++i];
        } else if (arg === "--computer-use") {
          opts.useComputerUse = true;
        } else if (arg === "--auto-approve") {
          opts.approvalHandling = "accept_for_session";
        } else if (arg === "--guardian") {
          opts.approvalsReviewer = "guardian_subagent";
        } else {
          promptParts.push(arg);
        }
      }
      opts.prompt = promptParts.join(" ").trim();
      if (!opts.prompt) throw new Error("Missing prompt text for 'send'");
      result = await executeTool(client, "codex_turn_send", opts);
      if (result.status === "running_in_background" || result.status === "awaiting_approval") {
        result.cliLifecycleWarning =
          "One-shot CLI process is exiting and closing its local app-server instance. Use the persistent MCP server for long-running polling or interactive approvals.";
      }
    } else {
      throw new Error(`Unknown subcommand '${cmd}'. Run with --help for usage.`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          error: err.message || String(err),
          rpcError: err.rpcError ?? null,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--mcp") {
  startMcpServer();
} else {
  runCli(args);
}
