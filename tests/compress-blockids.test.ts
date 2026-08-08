import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFileSync } from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
import { Value } from "typebox/value";
import { createAcpExtension } from "../src/index.js";

const STATE_FILE = "/tmp/pai-acp-blockids-it.session.json";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

async function cleanState() {
  await rmAsync(`${STATE_FILE}.acp.json`, { force: true });
}

function readState(): any {
  return JSON.parse(readFileSync(`${STATE_FILE}.acp.json`, "utf8"));
}

function fakeCtx(entries: any[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

async function fireCtx(handlers: Map<string, ((event: any, ctx: any) => any)[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

async function setup(entries: any[]) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const ctx = fakeCtx(entries);
  await fireCtx(handlers, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  return { compressTool, ctx, handlers };
}

function resultText(res: any): string {
  return (res.content[0] as any).text as string;
}

const big = (n: string) => `detailed message ${n} ` + "x".repeat(3000);

function twelveBigEntries() {
  return [
    userMsg("e1", big("one")), userMsg("e2", big("two")),
    userMsg("e3", big("three")),
    userMsg("e4", big("four")), userMsg("e5", big("five")),
    userMsg("e6", big("six")), userMsg("e7", big("seven")), userMsg("e8", big("eight")),
    userMsg("e9", big("nine")), userMsg("e10", big("ten")), userMsg("e11", big("eleven")), userMsg("e12", big("twelve")),
  ];
}

test("schema accepts a blockIds-only content entry (startId/endId now optional)", async () => {
  await cleanState();
  const { compressTool } = await setup([userMsg("e1", "hi")]);
  const params = compressTool.parameters;
  assert.ok(
    Value.Check(params, { content: [{ blockIds: ["b1", "b2"], summary: "distilled summary of the two blocks" }] }),
    "blockIds-only entry should validate (startId/endId optional)",
  );
  assert.ok(
    Value.Check(params, { content: [{ startId: "m00001", endId: "m00002", summary: "range summary covering the early messages" }] }),
    "classic startId/endId entry should still validate",
  );
});

test("compress blockIds distills specific non-contiguous blocks into a higher tier", async () => {
  await cleanState();
  const { compressTool, ctx } = await setup(twelveBigEntries());

  await compressTool.execute("tc1", { content: [{ startId: "m00001", endId: "m00002", summary: "Block one: early setup and initialization of the test session harness." }] }, undefined, undefined, ctx);
  await compressTool.execute("tc2", { content: [{ startId: "m00004", endId: "m00005", summary: "Block two: configuration work and parameter tuning for the pipeline." }] }, undefined, undefined, ctx);

  const res = await compressTool.execute("tc3", { content: [{ blockIds: ["b1", "b2"], summary: "Distilled tier-2 summary combining blocks one and two into a higher tier." }] }, undefined, undefined, ctx);
  const text = resultText(res);
  assert.match(text, /\d+ block/, "blockIds distillation should create a higher-tier block");
  assert.doesNotMatch(text, /error/i, "blockIds distillation should not error");

  const state = readState();
  const t2 = state.blocks.filter((b: any) => b.tier === 2 && b.active);
  assert.equal(t2.length, 1, "exactly one active T2 block created");
  const b1 = state.blocks.find((b: any) => b.blockId === "b1");
  const b2 = state.blocks.find((b: any) => b.blockId === "b2");
  assert.equal(b1.active, false, "source block b1 must be consumed (inactive)");
  assert.equal(b2.active, false, "source block b2 must be consumed (inactive)");
  const eff = t2[0].effectiveMessageIds.sort();
  assert.deepEqual(eff, ["e1", "e2", "e4", "e5"], "T2 effective messages = exactly the two source blocks' messages");
  assert.ok(!t2[0].effectiveMessageIds.includes("e3"), "intervening entry e3 must stay visible (not folded into T2)");
  assert.ok(t2[0].directBlockIds.includes("b1") && t2[0].directBlockIds.includes("b2"), "T2 block references its source blocks");
});

test("boundary-less entry (no startId/endId/blockIds) returns a clear handler error", async () => {
  await cleanState();
  const { compressTool, ctx } = await setup(twelveBigEntries());
  const res = await compressTool.execute("tc1", { content: [{ summary: "an entry with no boundary source whatsoever" }] }, undefined, undefined, ctx);
  const text = resultText(res);
  assert.match(text, /needs either startId\+endId or blockIds/i, "handler should reject boundary-less entries with a clear message");
});
