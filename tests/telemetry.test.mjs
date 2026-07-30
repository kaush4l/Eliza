// Asserts the dashboard reads a real hermes turn correctly out of relayed
// traffic: token usage from the trailing usage frame, tool calls from streamed
// deltas (which carry the name once and the arguments over many chunks), and a
// turn counted only when the last message is the user's.
//
//   node tests/telemetry.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "docs", "telemetry.js"), "utf8");
const { newTracker } = new Function(src + "\nreturn globalThis.Telemetry;")();

const enc = new TextEncoder();
const t = newTracker();

// --- a first turn: user message, 5 tool schemas offered, one tool call back ---
const req1 = JSON.stringify({
  model: "gemma-4-12B-it-qat-mxfp8",
  stream: true,
  tools: [{}, {}, {}, {}, {}],
  messages: [{ role: "system", content: "…" }, { role: "user", content: "list my todos" }],
});
const rec1 = t.begin("POST", "/v1/chat/completions", enc.encode(req1), 0);
assert.equal(rec1.newTurn, true, "a trailing user message starts a turn");
assert.equal(rec1.toolsOffered, 5);
assert.equal(rec1.model, "gemma-4-12B-it-qat-mxfp8");

// The name arrives in one delta, the arguments dribble in across three more.
const frames = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"todo","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"act"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ion\\":\\"list\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":6970,"completion_tokens":42,' +
    '"prompt_tokens_details":{"cached_tokens":6144}}}\n\n',
  "data: [DONE]\n\n",
];
// The opening role delta lands at once; the server then prefills for ~8s before
// the first real token. Timed naively that whole gap is charged to decode.
const at = [100, 8000, 8050, 8100, 8150, 8200, 8250];
frames.forEach((f, i) => t.chunk(rec1, enc.encode(f), at[i]));
t.finish(rec1, 8300);

assert.equal(rec1.ttft, 100, "first byte measured from the first chunk");
assert.equal(rec1.tok0, 8000, "decode clock starts at the first content/tool_call delta");
assert.equal(rec1.prefill, 8000);
// 42 tokens over the 300ms after prefill, not over the whole 8.3s call.
assert.equal(rec1.rate, 140, "rate excludes prefill");
assert.equal(rec1.fin, "tool_calls");
assert.equal(rec1.tin, 6970);
assert.equal(rec1.tout, 42);
assert.equal(rec1.cached, 6144);
assert.deepEqual(rec1.tools, ["todo"], "a tool is counted once, not once per argument delta");
assert.equal(t.stats.tools.get("todo"), 1);
assert.equal(t.stats.turns, 1);
assert.ok(rec1.rate > 0, "output tok/s derived from ttft..end");

// --- the follow-up call carrying the tool result must NOT count as a turn ---
const req2 = JSON.stringify({
  model: "gemma-4-12B-it-qat-mxfp8",
  stream: true,
  tools: [{}, {}, {}, {}, {}],
  messages: [
    { role: "system", content: "…" },
    { role: "user", content: "list my todos" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "todo", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "{\"todos\":[]}" },
  ],
});
const rec2 = t.begin("POST", "/v1/chat/completions", enc.encode(req2), 600);
assert.equal(rec2.newTurn, undefined, "a trailing tool message continues the same turn");
assert.equal(t.stats.turns, 1);

// A frame split across two chunks mid-JSON must still parse once reassembled.
const whole = 'data: {"choices":[{"index":0,"delta":{"content":"nothing pending"},' +
  '"finish_reason":"stop"}],"usage":{"prompt_tokens":7100,"completion_tokens":8}}\n\n';
t.chunk(rec2, enc.encode(whole.slice(0, 40)), 650);
t.chunk(rec2, enc.encode(whole.slice(40)), 700);
t.finish(rec2, 750);
assert.equal(rec2.fin, "stop");
assert.equal(rec2.tin, 7100);
assert.equal(t.stats.tin, 6970 + 7100, "usage accumulates across calls");
assert.equal(t.stats.tout, 42 + 8);
assert.equal(t.stats.promptLast, 7100, "context used tracks the newest prompt");

// --- a non-streamed reply (GET /v1/models) must not throw or invent usage ---
const rec3 = t.begin("GET", "/v1/models", null, 800);
t.chunk(rec3, enc.encode('{"object":"list","data":[{"id":"m","max_model_len":8192}]}'), 810);
t.finish(rec3, 820);
assert.equal(rec3.tin, undefined);
assert.equal(t.stats.apiCalls, 3);

// --- the call log is bounded ---
const small = newTracker(3);
for (let i = 0; i < 10; i++) small.begin("POST", "/v1/chat/completions", null, i);
assert.equal(small.calls.length, 3);
assert.equal(small.stats.apiCalls, 10, "the counter is not bounded by the log");

console.log("telemetry.test.mjs: all assertions passed");
