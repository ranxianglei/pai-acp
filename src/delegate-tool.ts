import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { delegateStatusWidget } from "./fleet-widget.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { debug } from "./log.js";

const MAX_DEPTH = 2;
const SYNC_TIMEOUT_MS = 5 * 60_000;
const RESULT_SUMMARY_CHARS = 500;
const OUT_DIR = join(tmpdir(), "acp-delegate");

/** ACP context-management tools that every restricted delegate must retain
 *  so it can manage its own context under billion-context-pi. */
const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status"] as const;

/** Roles that receive a restricted tool allowlist. Worker is intentionally
 *  absent - it runs on Pi's full default toolset (all extension/custom tools
 *  stay active) so primary-task delegation is not degraded. */
const RESTRICTED_TOOLS = "read,bash,grep,find,ls";

interface AgentDef {
  prompt: string;
  tools: string;
  /** When true, the role's `tools` are passed as a `--tools` allowlist to the
   *  child process, and ACP context tools are automatically appended. When
   *  absent/false, the child runs on Pi's full default toolset. */
  restricted?: boolean;
}

// Minimal roster. The tool description lists these so the model knows how to
// pick one — no separate prompt injection needed (keeps fixed cost tiny).
const AGENTS: Record<string, AgentDef> = {
  reviewer: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a senior code reviewer with read-only access.
Read the given code and report: bugs, security/safety risks, correctness issues, and concrete improvement suggestions.
Be specific — cite file:line for every finding. Do NOT modify any files; only read and report.`,
  },
  researcher: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a code researcher with read-only access.
Investigate the codebase to answer the question thoroughly. Report findings with exact file:line references, function/type signatures, and relevant code snippets.
Do NOT modify any files; only read and report.`,
  },
  worker: {
    tools: "read,edit,write,bash",
    prompt: `You are a precise implementer.
Make exactly the requested code changes — minimal, focused, following existing project conventions (check AGENTS.md first if present).
After editing, briefly summarize what you changed and why. Do not expand scope.`,
  },
  planner: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are a technical planner with read-only access.
Analyze the task and produce a concrete, ordered step-by-step implementation plan with rationale for each step.
Cite file:line for code you reference. Do NOT modify any files; only read and propose.`,
  },
  oracle: {
    tools: RESTRICTED_TOOLS,
    restricted: true,
    prompt: `You are an expert advisor with read-only access.
Answer the question concisely with clear reasoning. Cite file:line when referencing code. Do NOT modify any files.`,
  },
};

const AGENT_NAMES = Object.keys(AGENTS);

// ─── Run registry (module-level, shared across tools) ───────────────────────

type RunStatus = "running" | "completed" | "failed" | "cancelled";

interface DelegateRun {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  exitCode?: number | null;
  child?: ChildProcess;
  result?: { code: number | null; file: string; body: string };
  consumed?: boolean;
  waiter?: () => void;
}

const runs = new Map<string, DelegateRun>();

/** Snapshot of currently-running delegate runs, for the TUI status widget. */
export function runningRunsSnapshot(): { runId: string; agent: string; task: string; startedAt: number }[] {
  const out: { runId: string; agent: string; task: string; startedAt: number }[] = [];
  for (const r of runs.values()) {
    if (r.status === "running") out.push({ runId: r.runId, agent: r.agent, task: r.task, startedAt: r.startedAt });
  }
  return out;
}

const WAIT_TIMEOUT_MS_DEFAULT = 10_000;
const WAIT_TIMEOUT_MS_MAX = 300_000;

const DelegateParams = Type.Object({
  agent: Type.String({
    description: `Role of the delegate. One of: ${AGENT_NAMES.join(", ")}. See tool description for what each does.`,
  }),
  task: Type.String({
    description: "The self-contained task to hand off. State purpose, scope, and any constraints explicitly.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the delegate (default: current project dir)." }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Model override as "provider/id" (default: inherit current model).' }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description: "If true (default), return immediately with a runId. In long-lived sessions (interactive/rpc) a short notification is injected into chat when the delegate finishes; in one-shot sessions (print/json, e.g. `pi -p` / SDK) async auto-downgrades to sync and the result is returned here. If false, always block and return the output here.",
    }),
  ),
});

type DelegateArgs = Static<typeof DelegateParams>;

const CancelParams = Type.Object({
  runId: Type.String({ description: "The runId returned by acp_delegate to cancel." }),
});

const WaitParams = Type.Object({
  runId: Type.String({ description: "The runId returned by acp_delegate to wait for." }),
  timeout: Type.Optional(
    Type.Integer({
      description: `Maximum milliseconds to block waiting for the result. Default ${WAIT_TIMEOUT_MS_DEFAULT} (10s); max ${WAIT_TIMEOUT_MS_MAX} (300s). If the delegate does not finish in time, returns "failed (not ready)" — do NOT keep waiting or retry; go do other work, and a completion notification will still be injected when it completes.`,
    }),
  ),
});

const agentListLine = (name: string): string => {
  const def = AGENTS[name];
  if (!def) return "";
  const blurb: Record<string, string> = {
    reviewer: "read-only code review (bugs/risks, file:line)",
    researcher: "read-only codebase investigation",
    worker: "make code changes (read+edit+write)",
    planner: "analyze + propose step-by-step plan (read-only)",
    oracle: "answer questions / advise (read-only)",
  };
  return `  • ${name} - ${blurb[name]} [tools: ${def.tools}${def.restricted ? " + ACP context tools" : ""}]`;
};

export function makeDelegateTool(pi: ExtensionAPI): ToolDefinition<typeof DelegateParams> {
  return {
    name: "acp_delegate",
    label: "ACP Delegate",
    description: `Hand a self-contained task to a fresh sub-agent running in a clean context (its own pi process). Use to get focused review/investigation/implementation without polluting the main context, or to run several tasks concurrently.

Agents (pick by name):
${AGENT_NAMES.map(agentListLine).join("\n")}

Behavior:
• async=true (default): returns immediately with a runId. The delegate runs in the background. Call acp_delegate_wait({ runId }) to block for its result (up to a timeout); if you let the timeout lapse, or never call wait, a short completion notification (status + file path) is still injected into this chat when it finishes. In one-shot sessions (print/json) async auto-downgrades to sync so the result is returned inline within the same turn. Call acp_delegate again to launch more runs in parallel.
• async=false: blocks until the delegate finishes. The full output is saved to a file; the tool result contains the path. Use the \`read\` tool to open the file for the complete content.

There is NO non-blocking status tool. To get a delegate's result, call acp_delegate_wait with the runId — it blocks until the run finishes or the timeout elapses. Use acp_delegate_cancel only to stop a run you no longer want.

The delegate runs in its own clean pi process — it does NOT see this conversation's context. Give it everything it needs (paths, goals, constraints). Full results always go to a file so the chat context stays small.`,
    promptSnippet:
      'acp_delegate({ agent: "reviewer", task: "Review src/index.ts for race conditions" })',
    promptGuidelines: [
      "Delegate to get a focused result in a clean context, or to parallelize independent work.",
      "The sub-agent has NO access to this conversation — write a fully self-contained task.",
      "Prefer async=true and launch several; results arrive back automatically when each finishes.",
      "For changes you must apply yourself, delegate read-only investigation (reviewer/researcher/oracle) and keep the main context as the sole writer.",
    ],
    parameters: DelegateParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const args = params as DelegateArgs;
      const outcome = await runDelegate(pi, args, ctx, signal);
      return { details: undefined, content: [{ type: "text", text: outcome }] };
    },
  };
}

function formatRunResult(run: DelegateRun): string {
  const header =
    run.status === "completed"
      ? `Delegate **${run.agent}** (runId \`${run.runId}\`) completed (exit ${run.exitCode ?? "?"})${remainingLineForWait(run.runId)}`
      : `Delegate **${run.agent}** (runId \`${run.runId}\`) ${run.status} (exit ${run.exitCode ?? "?"})${remainingLineForWait(run.runId)}`;
  return formatPayload(header, run.result?.file ?? "", run.task, run.result?.body);
}

/** Count of OTHER delegates still running (excludes self), for wait-path results. */
function remainingLineForWait(selfRunId: string): string {
  const remaining = Array.from(runs.values()).filter((r) => r.status === "running" && r.runId !== selfRunId).length;
  return remaining > 0 ? ` ${remaining} delegate${remaining === 1 ? " is" : "s are"} still running.` : "";
}

export function makeDelegateWaitTool(_pi: ExtensionAPI): ToolDefinition<typeof WaitParams> {
  return {
    name: "acp_delegate_wait",
    label: "ACP Delegate Wait",
    description:
      "Block until an acp_delegate async run finishes, then return its result (status + file path). This is the ONLY way to fetch a delegate's result — there is no non-blocking status tool, so you cannot poll. Default timeout is 10s (max 300s). If the delegate finishes within the timeout, its result is returned here (same format as a sync delegate). If it times out, the run keeps going in the background and you should STOP waiting — do not retry in a loop; go do other work, and a completion notification will still be injected into the chat when it finishes.",
    promptSnippet: 'acp_delegate_wait({ runId: "del_..." })',
    promptGuidelines: [
      "Use this to fetch a delegate's result instead of polling a status tool.",
      "If it times out, do NOT retry — go do other work and let the background notification reach you.",
    ],
    parameters: WaitParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const args = params as { runId: string; timeout?: number };
      const run = runs.get(args.runId);
      if (!run) {
        return { details: undefined, content: [{ type: "text", text: `No delegate run with runId \`${args.runId}\`. It may have already been reported or never existed.` }] };
      }
      // Already finished (e.g. the model calls wait after the injected
      // notification, or the run was cancelled).
      if (run.status === "cancelled") {
        run.consumed = true;
        return { details: undefined, content: [{ type: "text", text: `Delegate \`${args.runId}\` was cancelled (no result).${remainingLineForWait(args.runId)}` }] };
      }
      if (run.status !== "running") {
        // status is only flipped together with result (see close handler), so
        // a non-running, non-cancelled run always has a result. Guard anyway.
        run.consumed = true;
        if (!run.result) {
          return { details: undefined, content: [{ type: "text", text: `Delegate \`${args.runId}\` finished but no result is available (persist error).` }] };
        }
        return { details: undefined, content: [{ type: "text", text: formatRunResult(run) }] };
      }
      const timeoutMs = Math.min(
        Math.max(args.timeout ?? WAIT_TIMEOUT_MS_DEFAULT, 1_000),
        WAIT_TIMEOUT_MS_MAX,
      );
      // Refuse to park a second waiter on the same run: a second wait would
      // overwrite run.waiter and orphan the first wait's listener/timer.
      if (run.waiter) {
        return { details: undefined, content: [{ type: "text", text: `Delegate \`${args.runId}\` already has a wait in progress; do not wait on it twice.` }] };
      }
      // Park a waiter; the close handler resolves it (and the result is owned
      // by this tool, so no injection duplicates it).
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (text: string) => {
          if (settled) return;
          settled = true;
          run.waiter = undefined;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ details: undefined, content: [{ type: "text", text }] });
        };
        const onAbort = () => {
          finish(`Aborted; delegate \`${args.runId}\` is still running in the background. A notification will be injected when it finishes.`);
        };
        run.waiter = () => {
          run.consumed = true; // we own the result; suppress injection
          if (run.status === "cancelled") {
            // Same message as the cancel-then-wait early-return path, for consistency.
            // Don't go through formatRunResult — cancelled runs have no result, and
            // formatPayload would render a misleading "could not be persisted" line.
            finish(`Delegate \`${run.runId}\` was cancelled (no result).${remainingLineForWait(run.runId)}`);
            return;
          }
          finish(formatRunResult(run));
        };
        signal?.addEventListener("abort", onAbort);
        timer = setTimeout(
          () => finish(`Failed: delegate \`${args.runId}\` result not ready after ${Math.round(timeoutMs / 1000)}s. Do NOT keep waiting or retry — go do other work now. The run continues in the background and a completion notification (with the result file path) will be injected into the chat when it finishes.`),
          timeoutMs,
        );
      });
    },
  };
}

export function makeDelegateCancelTool(_pi: ExtensionAPI): ToolDefinition<typeof CancelParams> {
  return {
    name: "acp_delegate_cancel",
    label: "ACP Delegate Cancel",
    description:
      "Cancel a background delegate (acp_delegate async run) by runId. Sends SIGTERM to the sub-agent process.",
    promptSnippet: 'acp_delegate_cancel({ runId: "del_..." })',
    promptGuidelines: [],
    parameters: CancelParams,
    async execute(toolCallId, params): Promise<AgentToolResult<unknown>> {
      const { runId } = params as Static<typeof CancelParams>;
      const run = runs.get(runId);
      if (!run) {
        return {
          details: undefined,
          content: [{ type: "text", text: `Unknown runId "${runId}".` }],
        };
      }
      if (run.status !== "running") {
        return {
          details: undefined,
          content: [{ type: "text", text: `Run ${runId} already ${run.status} (no action).` }],
        };
      }
      run.status = "cancelled";
      run.consumed = true; // suppress injection; the waiter (if any) gets cancelled status
      try {
        run.child?.kill("SIGTERM");
      } catch (err) {
        debug.event("delegate-cancel-kill-error", { runId, error: String(err) });
      }
      delegateStatusWidget.poke();
      return {
        details: undefined,
        content: [{ type: "text", text: `Cancelled ${runId} (${run.agent}).` }],
      };
    },
  };
}

async function runDelegate(
  pi: ExtensionAPI,
  args: DelegateArgs,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const agent = AGENTS[args.agent];
  if (!agent) {
    return `Unknown agent "${args.agent}". Choose one of: ${AGENT_NAMES.join(", ")}.`;
  }
  const parentDepth = Number(process.env.PI_ACP_DELEGATE_DEPTH ?? "0");
  if (Number.isNaN(parentDepth) || parentDepth >= MAX_DEPTH) {
    return `Delegate nesting limit reached (depth ${parentDepth}, max ${MAX_DEPTH}). The delegate cannot spawn further delegates.`;
  }
  if (!args.task || !args.task.trim()) {
    return `Task must be a non-empty string. Got: ${JSON.stringify(args.task).slice(0, 60)}`;
  }

  const cwd = args.cwd && args.cwd.trim() ? args.cwd : ctx.cwd;
  const childEnv = {
    ...process.env,
    PI_ACP_DELEGATE_DEPTH: String(parentDepth + 1),
  };

  const { cliArgs, tmpDir } = await buildChildArgs(args, agent.prompt, ctx);
  // One-shot modes (print/json = `pi -p` / SDK) exit after one turn, so async
  // injection (a follow-up turn) is never observed. Downgrade to sync there:
  // the result returns as the tool result within the same turn. Long-lived
  // modes (tui/rpc) keep true async + injection (consumed by the main loop).
  const requestedAsync = args.async !== false;
  const isAsync = requestedAsync && ctx.mode !== "print" && ctx.mode !== "json";
  if (requestedAsync && !isAsync) {
    debug.event("delegate-async-downgraded", { reason: `mode=${ctx.mode}` });
  }
  debug.event("delegate-spawn", { agent: args.agent, cwd, async: isAsync, cliArgs });

  // Spawn a child pi process using the SAME binary that is currently running.
  // Hardcoding "pi" breaks under renamed forks (e.g. pi-stable whose bin is
  // "pi-stable"). process.execPath is the Node binary, process.argv[1] is the
  // cli.js entrypoint of the currently running pi — together they always point
  // at the right executable regardless of how it was installed.
  const child = spawn(process.execPath, [process.argv[1]!, ...cliArgs], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  }) as ChildProcess;
  // Pass the task via stdin (not argv) so tasks starting with `-` are not
  // mis-parsed as CLI options. pi reads piped stdin as the prompt in print mode.
  // N1: a fast-exiting child (bad provider, ENOENT, SIGTERM) closes the pipe
  // before we finish writing → EPIPE → 'error' on stdin. Without a listener
  // that becomes an uncaughtException and can crash the host pi. Attach an
  // error listener so the event is swallowed and logged.
  child.stdin?.once("error", (e: Error) => {
    debug.event("delegate-stdin-error", { runId: "pre-spawn", error: String(e) });
  });
  child.stdin?.end(args.task);

  // stdout/stderr buffering is only needed by the async path (the sync path
  // attaches its own listeners in waitForChild). Attach lazily to avoid double
  // buffering in sync mode.
  let stdoutChunks: Buffer[] = [];
  let stderrText = "";

  const runId = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();

  if (isAsync) {
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });
    const run: DelegateRun = {
      runId,
      agent: args.agent,
      task: args.task,
      cwd,
      startedAt,
      status: "running",
      child,
    };
    runs.set(runId, run);
    delegateStatusWidget.poke();

    child.on("close", (code) => {
      void cleanupTmp(tmpDir);
      const output = Buffer.concat(stdoutChunks).toString("utf8").trim();
      run.exitCode = code;
      const body = code === 0 ? (output || "(no output)") : (stderrText.trim() || output || "(no output)");
      // N2: cancelled runs never persist a result — wake a parked waiter (if any)
      // and stop. status stays "cancelled" (set by cancel), so wait cannot
      // mistake it for a finished-with-result run.
      if (run.status === "cancelled") {
        run.finishedAt = Date.now();
        debug.event("delegate-done", { runId, code, status: run.status, injected: false, outLen: output.length });
        run.waiter?.();
        delegateStatusWidget.poke();
        return;
      }
      void persistResult(runId, body)
        .then((file) => {
          // Atomically flip status + result together: until this point the run
          // is still "running" to any observer, so a concurrent wait cannot
          // see "finished but result missing".
          run.result = { code, file, body };
          run.status = code === 0 ? "completed" : "failed";
          run.finishedAt = Date.now();
          // If a wait is parked on this run, wake it — it owns the result now
          // (and marks consumed so we don't double-deliver by injecting).
          if (run.waiter) {
            debug.event("delegate-done", { runId, code, status: run.status, injected: false, via: "wait", outLen: output.length, file });
            run.waiter();
            delegateStatusWidget.poke();
            return;
          }
          // If a wait already returned this result, skip the injection.
          if (run.consumed) {
            debug.event("delegate-done", { runId, code, status: run.status, injected: false, via: "consumed", outLen: output.length, file });
            delegateStatusWidget.poke();
            return;
          }
          const injected = injectResult(pi, args.agent, runId, args.task, code, file);
          debug.event("delegate-done", { runId, code, status: run.status, injected, outLen: output.length, file });
          delegateStatusWidget.poke();
        })
        .catch((err) => {
          // Persist failed — still need to finalize so a waiter doesn't hang.
          run.status = "failed";
          run.finishedAt = Date.now();
          debug.event("delegate-done-error", { runId, error: String(err) });
          run.waiter?.();
          delegateStatusWidget.poke();
        });
    });
    child.on("error", (err) => {
      void cleanupTmp(tmpDir);
      // Spawn-level error (e.g. EPIPE on a fast-exiting child, ENOENT).
      // Node does not guarantee a follow-up close, so finalize here too:
      // atomically set status + a synthetic result, and wake a parked waiter.
      // The settled guard in close (if it does fire) prevents double-finalize.
      if (run.status === "running" || run.status === "cancelled") {
        run.status = run.status === "cancelled" ? "cancelled" : "failed";
        run.finishedAt = Date.now();
        run.result = { code: null, file: "", body: `spawn error: ${String(err)}` };
        debug.event("delegate-spawn-error", { runId, error: String(err) });
        run.waiter?.();
        delegateStatusWidget.poke();
      }
    });
    // Detach so the child survives the tool returning. Injection is best-effort:
    // the close handler calls sendUserMessage (fire-and-forget) to notify the
    // parent chat; interactive/rpc sessions consume it via their main loop.
    child.unref();
    return [
      `Delegated to **${args.agent}** (runId \`${runId}\`).`,
      `Task: ${truncate(args.task, 160)}`,
      `Running in the background at \`${cwd}\`.`,
      ``,
      `Call acp_delegate_wait({ runId: "${runId}" }) to block for the result (default 10s timeout). If the wait times out, or you skip it, a completion notification (with the result file path) is still injected here automatically when the delegate finishes — so you may also just continue other work now and let the result find you.`,
    ].join("\n");
  }

  // Sync: block until the child finishes (bounded by a timeout).
  const result = await waitForChild(child, signal);
  void cleanupTmp(tmpDir);
  const body =
    result.timedOut || result.code !== 0
      ? (result.stderr.trim() || "(no stderr)")
      : (result.stdout || "(no output)");
  const file = await persistResult(runId, body);
  return formatSyncResult(args.agent, runId, args.task, result, file);
}

export async function buildChildArgs(
  args: DelegateArgs,
  rolePrompt: string,
  ctx: ExtensionContext,
): Promise<{ cliArgs: string[]; tmpDir: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "acp-delegate-"));
  // Combine the role prompt with a small framing instruction so the child
  // treats the positional message as the task to execute.
  const promptFile = join(tmpDir, "role.md");
  await writeFile(promptFile, `${rolePrompt}\n\n---\n\nComplete the task below.`, "utf8");

  const cliArgs = ["-p", "--no-session", "--append-system-prompt", promptFile];

  // Restricted roles receive a tailored --tools allowlist. Worker and
  // unknown agents are left on Pi's full default toolset (all extension/
  // custom tools stay active). The allowlist is a *soft guardrail*: it
  // prevents accidental edit/write by read-only roles, but bash can bypass
  // it - this is not a security boundary.
  const agentDef = AGENTS[args.agent];
  if (agentDef?.restricted) {
    const merged = [...new Set([...agentDef.tools.split(",").map(s => s.trim()), ...ACP_TOOLS])];
    cliArgs.push("--tools", merged.join(","));
  }

  if (args.model && args.model.includes("/")) {
    const [providerId, ...rest] = args.model.split("/");
    const modelId = rest.join("/");
    cliArgs.push("--provider", providerId!, "--model", modelId);
  } else if (ctx.model) {
    // Inherit the parent's current model so the delegate runs on the same one.
    cliArgs.push("--provider", ctx.model.provider, "--model", ctx.model.id);
  }

  return { cliArgs, tmpDir };
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function waitForChild(child: ChildProcess, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stderrText = "";
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => {
      stderrText += c.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: "", stderr: stderrText, timedOut: true });
    }, SYNC_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(r: ChildResult) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    }

    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: stderrText,
        timedOut: false,
      });
    });
    child.on("error", (err) => {
      finish({ code: null, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

function formatSyncResult(agent: string, runId: string, task: string, r: ChildResult, file: string): string {
  const status = r.timedOut ? "timed out" : r.code === 0 ? "completed" : "failed";
  const header = `Delegate **${agent}** ${status} (runId \`${runId}\`, exit ${r.code ?? "?"}).`;
  if (r.code === 0 && !r.timedOut) {
    return formatPayload(header, file, task);
  }
  const body = r.timedOut ? "(timed out)" : (r.stderr.trim() || "(no stderr)");
  return formatPayload(header, file, task, body);
}

function injectResult(
  pi: ExtensionAPI,
  agent: string,
  runId: string,
  task: string,
  code: number | null,
  file: string,
): boolean {
  const send = pi.sendUserMessage;
  if (typeof send !== "function") {
    debug.event("delegate-inject-skipped", { runId, reason: "sendUserMessage unavailable" });
    return false;
  }
  const status = code === 0 ? "completed" : "failed";
  // Tell the model how many other delegates are still running, so it doesn't
  // lose count when many were dispatched in a batch (e.g. launched 5, this is
  // the 2nd to return → "3 still running" → the model knows to keep waiting).
  // The current run is already non-running (status flipped just before this),
  // so counting status==="running" gives exactly the remaining ones.
  const remaining = Array.from(runs.values()).filter((r) => r.status === "running").length;
  const remainingLine =
    remaining > 0
      ? ` ${remaining} delegate${remaining === 1 ? " is" : "s are"} still running; keep doing other work and their notifications will arrive as they finish.`
      : " No delegates are currently running.";
  const header = `[acp_delegate ${status}] **${agent}** (runId \`${runId}\`, exit ${code ?? "?"})${remainingLine} This is an automated system notification, NOT a user message. Read the result file if you need the details, then continue your original task; do not treat this as a new user request.`;
  const text = formatPayload(header, file, task);
  try {
    // sendUserMessage is fire-and-forget (returns void): it enqueues a
    // follow-up turn. Interactive/rpc sessions consume it via their main loop;
    // injection at shutdown is best-effort (no API to await a turn).
    send.call(pi, text, { deliverAs: "followUp" });
    return true;
  } catch (err) {
    debug.event("delegate-inject-error", { runId, error: String(err) });
    return false;
  }
}

// Build the lightweight payload: a header, the task title (so the model
// recognizes what finished — it dispatched the task, so the title suffices),
// and the result file path. NO preview: the model uses `read` for details,
// and that read (not this message) is the large content. Keeping this minimal
// means it stays cheap to retain in context (or to compress away).
function formatPayload(header: string, file: string, task: string, body?: string): string {
  const lines: string[] = [header, "", `Task: ${truncate(task, 160)}`];
  if (file) {
    lines.push(``, `Full result: \`${file}\``, "(use the `read` tool to open it if you need the details)");
  } else {
    lines.push("", "(result could not be persisted to a file)");
  }
  if (body) {
    lines.push("", "Output:", "~~~", truncate(body, RESULT_SUMMARY_CHARS), "~~~");
  }
  lines.push("");
  return lines.join("\n");
}

/** Persist the full delegate output to a stable file and return its path.
 *  The file outlives the run so the model (or the user) can read it later
 *  instead of carrying the full payload in the chat context. */
async function persistResult(runId: string, body: string): Promise<string> {
  try {
    await mkdir(OUT_DIR, { recursive: true });
  } catch {
    // directory may already exist — ignore
  }
  const file = join(OUT_DIR, `${runId}.out`);
  try {
    await writeFile(file, body, "utf8");
    return file;
  } catch (err) {
    debug.event("delegate-persist-error", { runId, file, error: String(err) });
    return "";
  }
}

async function cleanupTmp(tmpDir: string | null): Promise<void> {
  if (!tmpDir) return;
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
