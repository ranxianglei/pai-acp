import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug } from "./log.js";
import { estimateTokens, collectCoveredMessageIds } from "./tokens.js";

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const RangeSpec = Type.Object({
  startId: Type.Optional(Type.String({ description: 'Message ref, e.g. "m00005" (from the acp tag), or a block id "b3". Omit when using blockIds.' })),
  endId: Type.Optional(Type.String({ description: 'Inclusive end ref. Must be at or after startId. Omit when using blockIds.' })),
  blockIds: Type.Optional(Type.Array(Type.String(), { description: 'Explicit block ids to distill into one higher-tier block (T2/T3), e.g. ["b3","b7"]. Use for non-contiguous blocks: consumes exactly these blocks and leaves raw messages between them visible. Takes precedence over startId/endId.' })),
  summary: Type.String({ description: "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.)." }),
  topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality." })),
});

const CompressParams = Type.Object({
  topic: Type.Optional(Type.String({ description: "Fallback topic for entries without their own. Omit when each content entry specifies its own topic." })),
  content: Type.Array(RangeSpec, { description: "One or more ranges to compress. Each entry uses EITHER startId+endId (a contiguous range) OR blockIds (distill specific blocks into a higher tier). When compressing multiple unrelated ranges in one call, give each its own topic." }),
  summaryMaxChars: Type.Optional(Type.Number({ description: "Override max summary length (default max: 20000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit." })),
});

type CompressArgs = Static<typeof CompressParams>;

export function makeCompressTool(runtime: AcpRuntime): ToolDefinition<typeof CompressParams> {
  return {
    name: "compress",
    label: "Compress",
    description:
      "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). T2/T3 block distillation (non-contiguous blocks): compress({ content: [{ blockIds: [\"b3\",\"b7\"], summary }] }) — consumes exactly those blocks. Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own summary.",
    promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or { blockIds: [...], summary }, or batch",
    promptGuidelines: [
      "Each message has an acp tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
      "For T2/T3 distillation of specific blocks, use blockIds: [\"b3\",\"b7\"] — consumes exactly those blocks (non-contiguous OK).",
      "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
      "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
      "Never compress content the current step is actively using.",
    ],
    parameters: CompressParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await handleCompress(params as CompressArgs, runtime, ctx, toolCallId);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleCompress(args: CompressArgs, runtime: AcpRuntime, ctx: ExtensionContext, toolCallId?: string): Promise<string> {
  const ranges = args.content ?? [];
  if (ranges.length === 0) return "No ranges provided.";
  for (const r of ranges) {
    const hasBlockIds = r.blockIds && r.blockIds.length > 0;
    const hasRefs = r.startId && r.endId;
    if (!hasBlockIds && !hasRefs) {
      return `Each content entry needs either startId+endId or blockIds. Entry missing both (summary starts: "${r.summary.slice(0, 40)}").`;
    }
  }
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);

  const beforeTokens = estimateTokens(coreMessages, collectCoveredMessageIds(state));
  const summaryMaxChars = args.summaryMaxChars;
  const topLevelTopic = args.topic;

  debug.event("compress-in", {
    sid: ctx.sessionManager.getSessionId(),
    ranges: ranges.length,
    spans: ranges.map((r) => ({ span: r.blockIds && r.blockIds.length > 0 ? `blockIds:[${r.blockIds.join(",")}]` : `${r.startId}..${r.endId}`, summaryLen: r.summary.length, summary: r.summary, topic: r.topic ?? topLevelTopic ?? null })),
    blocksBefore: state.blocks.length,
    activeBefore: state.blocks.filter((b) => b.active).length,
    beforeMsgCount: coreMessages.length,
    beforeTokens,
  });

  const applied = runtime.core.applyCompression({
    ranges: ranges.map((r) => ({ startRef: r.startId, endRef: r.endId, blockIds: r.blockIds, summary: r.summary, topic: r.topic ?? topLevelTopic, summaryMaxChars, compressCallId: toolCallId })),
    messages: coreMessages,
    state,
    config,
  });
  await runtime.save(applied.state, ctx);
  const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;

  const afterTokens = Math.max(0, beforeTokens - tokensCompressed);

  const newBlocks = applied.state.blocks.slice(-blocksCreated);
  debug.event("compress-out", {
    sid: ctx.sessionManager.getSessionId(),
    blocksCreated,
    tokensCompressed,
    beforeTokens,
    afterTokens,
    afterMsgCount: applied.state.blocks.length,
    errors: errors.length,
    errorDetails: errors.slice(0, 3),
    blocksAfter: applied.state.blocks.length,
    activeAfter: applied.state.blocks.filter((b) => b.active).length,
    newBlocks: newBlocks.map((b) => ({ blockId: b.blockId, tier: b.tier, summaryLen: b.summary.length, directMsgCount: b.directMessageIds.length, effectiveMsgCount: b.effectiveMessageIds.length, summary: b.summary })),
  });

  const lines = [`▣ ACP | ${formatK(beforeTokens)} → ${formatK(afterTokens)} tokens (~${formatK(tokensCompressed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
  if (warnings.length > 0) lines.push("⚠️ " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  return lines.join("\n");
}
