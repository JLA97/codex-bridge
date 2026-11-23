import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

function detectBundledComputerUse(codexHome) {
  if (!codexHome) return { cacheExists: false, packages: {} };
  const packages = {};
  for (const pkgName of ["unified-computer-use", "computer-use"]) {
    const base = path.join(codexHome, "plugins", "cache", "openai-bundled", pkgName);
    if (!existsSync(base)) {
      packages[pkgName] = { exists: false, versions: [] };
      continue;
    }
    try {
      const versions = readdirSync(base).filter((n) => !n.startsWith("."));
      packages[pkgName] = { exists: versions.length > 0, basePath: base, versions };
    } catch {
      packages[pkgName] = { exists: true, basePath: base, versions: [] };
    }
  }
  return {
    cacheExists: Object.values(packages).some((p) => p.exists),
    packages,
  };
}

function summarizeTurnItems(items = []) {
  const messages = [];
  const commands = [];
  const fileChanges = [];
  const mcpCalls = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "userMessage") {
      const texts = (item.content || [])
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "skill") return `[skill:${c.name}]`;
          if (c.type === "localImage") return `[image:${c.path}]`;
          return `[${c.type}]`;
        })
        .join(" ");
      messages.push({ role: "user", text: texts });
    } else if (item.type === "agentMessage") {
      messages.push({ role: "assistant", text: item.text });
    } else if (item.type === "commandExecution") {
      commands.push({
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode ?? null,
      });
    } else if (item.type === "fileChange") {
      fileChanges.push({
        status: item.status,
        files: (item.changes || []).map((ch) => ch.path || ch),
      });
    } else if (item.type === "mcpToolCall") {
      mcpCalls.push({
        server: item.server,
        pluginId: item.pluginId ?? null,
        tool: item.tool,
        status: item.status,
      });
    }
  }
  return { messages, commands, fileChanges, mcpCalls };
}

export const TOOL_DEFINITIONS = [
  {
    name: "codex_capabilities",
    description:
      "Inspect local Codex App Server version/binary, auth state, bundled plugins, macOS Computer Use (`unified-computer-use` / `cua_repl`) readiness, loaded skills, MCP servers, and Codex Desktop sidebar sections.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Optional working directory to evaluate workspace-scoped skills and plugins.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_thread_list",
    description:
      "List persisted Codex App / CLI threads from the shared Codex store without locking any session. Supports pagination (`cursor`), filtering by `cwd`, `searchTerm`, Codex Desktop sidebar `sectionId`, or `archived` status.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Exact working directory filter (optional).",
        },
        searchTerm: {
          type: "string",
          description: "Substring search on thread title/preview.",
        },
        sectionId: {
          type: ["string", "null"],
          description: "Filter by Codex Desktop sidebar section ID, or null for unsectioned.",
        },
        archived: {
          type: "boolean",
          description: "If true, list archived threads; defaults to false (active threads).",
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned as nextCursor from a previous call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Number of threads to return (default 15).",
        },
        sortKey: {
          type: "string",
          enum: ["updated_at", "created_at", "recency_at", "section_position"],
          description: "Sort field (default 'updated_at').",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_thread_read",
    description:
      "Read a Codex thread's persisted metadata and paginated turns cleanly without calling thread/resume (never triggers 'Conversation opened in another application' lock in Codex Desktop).",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Target Codex thread UUID.",
        },
        cursor: {
          type: "string",
          description: "Pagination cursor returned as nextCursor from a previous call.",
        },
        turnLimit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum recent turns to retrieve (default 5).",
        },
        itemsView: {
          type: "string",
          enum: ["summary", "full"],
          description: "Detail level for turn items (default 'full').",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_turn_send",
    description:
      "Send a task/turn to Codex via codex app-server. Supports creating a new thread ('new'), branching from persisted Codex Desktop history ('fork'), or continuing an idle thread ('resume'). Supports macOS Computer Use (`useComputerUse: true`) and interactive approval forwarding (`approvalHandling: 'defer'`). Returns `running_in_background` after `waitTimeoutMs` (default 45000ms) with `threadId` and `turnId` for `codex_turn_status`.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["new", "fork", "resume"],
          description:
            "Thread mode: 'new' starts a fresh thread (default), 'fork' branches from threadId's persisted history without locking the original in Codex Desktop, 'resume' appends to an idle threadId.",
        },
        threadId: {
          type: "string",
          description: "Source or target threadId (required for 'fork' and 'resume').",
        },
        prompt: {
          type: "string",
          description: "Task instructions or message to send to Codex.",
        },
        cwd: {
          type: "string",
          description: "Absolute working directory (e.g. a dedicated git worktree path).",
        },
        title: {
          type: "string",
          description: "Optional display title to assign to the Codex thread.",
        },
        sectionId: {
          type: "string",
          description: "Optional Codex Desktop sidebar section ID to place the thread into.",
        },
        useComputerUse: {
          type: "boolean",
          description:
            "Verify and enable Codex macOS Computer Use (`unified-computer-use` / `cua_repl` or `computer-use` skill). Fails fast if Computer Use is not ready.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Optional extra Codex skill names to attach to this turn.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Optional local image paths to attach as visual input.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description:
            "Sandbox mode override. Defaults to 'workspace-write' on 'new', or inherits thread setting on 'fork'/'resume'.",
        },
        approvalPolicy: {
          type: "string",
          enum: ["untrusted", "on-request", "never"],
          description:
            "Approval policy override. Defaults to 'on-request' on 'new', or inherits thread setting on 'fork'/'resume'.",
        },
        approvalsReviewer: {
          type: "string",
          enum: ["user", "guardian_subagent", "auto_review"],
          description:
            "Approval reviewer override. Defaults to 'user' on 'new', or inherits thread setting on 'fork'/'resume'.",
        },
        approvalHandling: {
          type: "string",
          enum: ["defer", "accept_once", "accept_for_session", "decline"],
          description:
            "How this bridge handles approval callbacks: 'defer' (default) pauses and returns pendingApprovals to caller; 'accept_once'/'accept_for_session' auto-approves; 'decline' rejects escalations.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description: "Optional reasoning effort override.",
        },
        ephemeral: {
          type: "boolean",
          description: "If true, do not persist this thread to Codex Desktop history.",
        },
        waitTimeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description:
            "Milliseconds to wait before returning running_in_background (default 45000, safely below MCP host timeout).",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_turn_status",
    description:
      "Wait on an active Codex turn started in this MCP session (when codex_turn_send returned 'running_in_background').",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        turnId: { type: "string" },
        waitTimeoutMs: {
          type: "integer",
          minimum: 500,
          maximum: 120000,
          description: "How long to wait for completion or next approval (default 45000).",
        },
      },
      required: ["threadId", "turnId"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_turn_interrupt",
    description:
      "Interrupt/cancel a running Codex turn, wait briefly for its terminal event, and release the thread subscription.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        turnId: { type: "string" },
      },
      required: ["threadId", "turnId"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_pending_approvals",
    description:
      "List any pending command, file-change, permission, Computer Use / MCP elicitation, or user-input requests waiting for a decision.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Optional filter by threadId.",
        },
        turnId: {
          type: "string",
          description: "Optional filter by turnId.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_approval_respond",
    description:
      "Respond to a pending Codex approval/elicitation request (from pendingApprovals) and resume waiting for the turn outcome.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: {
          type: "string",
          description: "The approvalId (e.g. 'apr_1') returned in pendingApprovals.",
        },
        decision: {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"],
          description: "Explicit approval decision (required).",
        },
        scope: {
          type: "string",
          enum: ["turn", "session"],
          description: "Grant scope when approving item/permissions/requestApproval.",
        },
        content: {
          type: "object",
          description: "Required structured form payload when accepting an mcpServer/elicitation/request with required fields.",
        },
        answers: {
          type: "object",
          description:
            "Required map of { questionId: answerStringOrArray } when accepting item/tool/requestUserInput.",
        },
        waitTimeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: 120000,
          description: "Milliseconds to wait for turn completion after sending decision (default 45000).",
        },
      },
      required: ["approvalId", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_review_start",
    description:
      "Run Codex's native code review engine (`review/start`) on uncommitted changes, a base branch, a specific commit, or custom instructions.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Repository directory to review.",
        },
        targetType: {
          type: "string",
          enum: ["uncommittedChanges", "baseBranch", "commit", "custom"],
          description: "What to review (default 'uncommittedChanges').",
        },
        branch: {
          type: "string",
          description: "Base branch name when targetType='baseBranch'.",
        },
        sha: {
          type: "string",
          description: "Commit SHA when targetType='commit'.",
        },
        instructions: {
          type: "string",
          description: "Custom review instructions when targetType='custom'.",
        },
        ephemeral: {
          type: "boolean",
          description: "If true, do not persist the review thread in Codex Desktop (default false).",
        },
        waitTimeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Milliseconds to wait before returning running_in_background (default 45000).",
        },
      },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_thread_organize",
    description:
      "Rename a Codex thread, move it into/out of a Codex Desktop sidebar section, or archive/unarchive it. Reports per-operation status.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        name: {
          type: "string",
          description: "New thread title.",
        },
        sectionId: {
          type: ["string", "null"],
          description: "Target Codex Desktop sectionId, or null to remove from section.",
        },
        archive: {
          type: "boolean",
          description: "True to archive thread, false to unarchive.",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
];

const SCHEMA_BY_TOOL = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t.inputSchema]));

export function validateToolArgs(name, args) {
  const schema = SCHEMA_BY_TOOL.get(name);
  if (!schema) {
    throw new Error(`Unknown tool '${name}'`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Arguments for '${name}' must be a JSON object.`);
  }
  for (const reqKey of schema.required || []) {
    if (args[reqKey] === undefined || args[reqKey] === null) {
      throw new Error(`Missing required argument '${reqKey}' for tool '${name}'.`);
    }
  }
  const props = schema.properties || {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const propSchema = props[k];
    if (!propSchema && schema.additionalProperties === false) {
      throw new Error(`Unknown argument '${k}' for tool '${name}'.`);
    }
    if (propSchema?.enum && !propSchema.enum.includes(v)) {
      throw new Error(
        `Invalid value '${v}' for '${k}' in '${name}'. Allowed: ${propSchema.enum.join(", ")}.`
      );
    }
  }
}

export async function executeTool(client, name, rawArgs = {}) {
  const args = rawArgs ?? {};
  validateToolArgs(name, args);

  switch (name) {
    case "codex_capabilities": {
      const info = await client.ensureConnected();
      const cwds = args.cwd ? [args.cwd] : [process.cwd()];

      const [authRes, pluginsRes, skillsRes, mcpRes, sectionsRes, cuCheck] =
        await Promise.allSettled([
          client.request("getAuthStatus", {}),
          client.request("plugin/list", { cwds }),
          client.request("skills/list", { cwds, forceReload: false }),
          client.request("mcpServerStatus/list", { limit: 50 }),
          client.request("threadSection/list", { limit: 100 }),
          client.resolveComputerUseCapability(null, args.cwd || process.cwd()),
        ]);

      const plugins = [];
      if (pluginsRes.status === "fulfilled") {
        for (const mp of pluginsRes.value?.marketplaces || []) {
          for (const pl of mp.plugins || []) {
            plugins.push({
              id: pl.id,
              name: pl.name,
              installed: pl.installed,
              enabled: pl.enabled,
              localVersion: pl.localVersion,
              marketplace: mp.name,
            });
          }
        }
      }

      const skills = [];
      if (skillsRes.status === "fulfilled") {
        for (const entry of skillsRes.value?.data || []) {
          for (const sk of entry.skills || []) {
            skills.push({
              name: sk.name,
              enabled: sk.enabled,
              scope: sk.scope,
              pluginId: sk.pluginId,
              path: sk.path,
            });
          }
        }
      }

      const mcpServers =
        mcpRes.status === "fulfilled"
          ? (mcpRes.value?.data || []).map((s) => {
              const toolNames = Object.keys(s.tools || {});
              return {
                name: s.name,
                pluginId: s.pluginId ?? null,
                runtimeStatus: s.runtimeStatus ?? null,
                authStatus: s.authStatus ?? null,
                toolCount: toolNames.length,
                toolsError: s.toolsError ?? null,
                ...(toolNames.length <= 10 ? { tools: toolNames } : {}),
              };
            })
          : [];

      const bundledCu = detectBundledComputerUse(info?.codexHome);
      const cuResolved =
        cuCheck.status === "fulfilled"
          ? cuCheck.value
          : { ready: false, mode: null, error: cuCheck.reason?.message };

      return {
        serverInfo: info,
        humanCommandApprovalsSupported: true,
        auth: authRes.status === "fulfilled" ? authRes.value : { error: authRes.reason?.message },
        computerUse: {
          ...cuResolved,
          bundledCache: bundledCu,
        },
        mcpServers,
        sections: sectionsRes.status === "fulfilled" ? sectionsRes.value?.data || [] : [],
        installedOrEnabledPlugins: plugins.filter((p) => p.installed || p.enabled),
        skillCount: skills.length,
        skillsSample: skills.slice(0, 30),
      };
    }

    case "codex_thread_list": {
      const [listRes, sectionsRes] = await Promise.all([
        client.request("thread/list", {
          limit: args.limit ?? 15,
          sortKey: args.sortKey ?? "updated_at",
          sortDirection: "desc",
          archived: args.archived ?? false,
          useStateDbOnly: true,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.searchTerm ? { searchTerm: args.searchTerm } : {}),
          ...(args.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
        }),
        client.request("threadSection/list", { limit: 100 }).catch(() => ({ data: [] })),
      ]);

      const sectionMap = new Map(
        (sectionsRes?.data || []).map((sec) => [sec.id, sec.name || sec.title || sec.id])
      );

      return {
        snapshotSource: "persisted_state_db",
        count: (listRes?.data || []).length,
        nextCursor: listRes?.nextCursor ?? null,
        threads: (listRes?.data || []).map((t) => ({
          id: t.id,
          name: t.name ?? null,
          preview: t.preview,
          cwd: t.cwd,
          model: t.model,
          status: t.status,
          section: t.section,
          sectionName:
            t.section?.name ??
            (t.section?.id ? sectionMap.get(t.section.id) ?? null : null),
          forkedFromId: t.forkedFromId,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          originator: t.originator,
        })),
      };
    }

    case "codex_thread_read": {
      const [metaRes, turnsRes] = await Promise.all([
        client.request("thread/read", {
          threadId: args.threadId,
          includeTurns: false,
        }),
        client.request("thread/turns/list", {
          threadId: args.threadId,
          limit: args.turnLimit ?? 5,
          sortDirection: "desc",
          itemsView: args.itemsView ?? "full",
          ...(args.cursor ? { cursor: args.cursor } : {}),
        }),
      ]);

      const thread = metaRes?.thread || {};
      const turnsChronological = [...(turnsRes?.data || [])].reverse();
      return {
        snapshotSource: "persisted_rollout_history",
        thread: {
          id: thread.id,
          name: thread.name ?? null,
          preview: thread.preview,
          cwd: thread.cwd,
          model: thread.model,
          status: thread.status,
          section: thread.section,
          sectionName: thread.section?.name ?? null,
          forkedFromId: thread.forkedFromId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        },
        turnCountReturned: turnsChronological.length,
        nextCursor: turnsRes?.nextCursor ?? null,
        turns: turnsChronological.map((turn) => ({
          id: turn.id,
          status: turn.status,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          durationMs: turn.durationMs,
          error: turn.error,
          ...summarizeTurnItems(turn.items || []),
        })),
      };
    }

    case "codex_turn_send": {
      return client.runTurn(args);
    }

    case "codex_turn_status": {
      return client.getTurnStatus(
        args.threadId,
        args.turnId,
        args.waitTimeoutMs ?? 45_000
      );
    }

    case "codex_turn_interrupt": {
      return client.interruptTurn(args.threadId, args.turnId);
    }

    case "codex_pending_approvals": {
      return {
        pendingApprovals: client._getPendingApprovalsForScope(
          args.threadId || null,
          args.turnId || null
        ),
      };
    }

    case "codex_approval_respond": {
      return client.respondToApproval(args);
    }

    case "codex_review_start": {
      return client.runReview(args);
    }

    case "codex_thread_organize": {
      if (
        typeof args.name !== "string" &&
        args.sectionId === undefined &&
        typeof args.archive !== "boolean"
      ) {
        throw new Error(
          "Provide at least one action field for codex_thread_organize: 'name', 'sectionId', or 'archive'."
        );
      }

      const operations = {};
      let anyFailed = false;

      if (typeof args.name === "string") {
        try {
          const res = await client.request("thread/name/set", {
            threadId: args.threadId,
            name: args.name,
          });
          operations.rename = { ok: true, result: res };
        } catch (err) {
          anyFailed = true;
          operations.rename = { ok: false, error: err.message };
        }
      }

      if (args.sectionId !== undefined) {
        try {
          const res = await client.request("thread/section/move", {
            threadId: args.threadId,
            sectionId: args.sectionId,
          });
          operations.sectionMove = { ok: true, result: res };
        } catch (err) {
          anyFailed = true;
          operations.sectionMove = { ok: false, error: err.message };
        }
      }

      if (typeof args.archive === "boolean") {
        try {
          const res = await client.request(
            args.archive ? "thread/archive" : "thread/unarchive",
            { threadId: args.threadId }
          );
          operations.archive = { ok: true, result: res };
        } catch (err) {
          anyFailed = true;
          operations.archive = { ok: false, error: err.message };
        }
      }

      return {
        threadId: args.threadId,
        partialFailure: anyFailed,
        operations,
      };
    }

    default:
      throw new Error(`Unknown tool '${name}'`);
  }
}
