// node tests/relay-stream.test.mjs
//
// Drives the page-side relay in docs/stack.js the way c2w-net-proxy does, with a
// stubbed streaming fetch, and asserts the two properties the LLM path depends
// on: body chunks reach the guest as they arrive (not one burst at the end), and
// EOF is signalled exactly once, after the last byte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
globalThis.self = globalThis; // stack.js reads self.__guestURLMap
new Function(readFileSync(join(here, "..", "docs", "stack.js"), "utf8") + "\nglobalThis.connect = connect;")();

const CHUNKS = ["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"];
const GAP_MS = 40;

globalThis.fetch = async (url) => {
  assert.equal(url, "http://127.0.0.1:8873/v1/chat/completions", "sentinel should be rewritten");
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (i < CHUNKS.length) c.enqueue(new TextEncoder().encode(CHUNKS[i++]));
          else c.close();
          resolve();
        }, GAP_MS);
      });
    },
  });
  return new Response(body, { status: 200, statusText: "OK" });
};

self.__guestURLMap = [["http://llm.eliza.internal/v1", "http://127.0.0.1:8873/v1"]];

const shared = new SharedArrayBuffer(12 + 4096);
const ctrl = new Int32Array(shared, 0, 1);
const status = new Int32Array(shared, 4, 1);
const len = new Int32Array(shared, 8, 1);
const data = new Uint8Array(shared, 12);
const handle = connect("vm", shared,
                       { sendbuf: { buf: new Uint8Array(0) }, recvbuf: { buf: new Uint8Array(0) } },
                       { buf: new Uint8Array(0), done: false });

// Mimic the proxy's synchronous call convention: post, then wait for the notify.
function call(req) {
  Atomics.store(ctrl, 0, 0);
  handle({ data: req });
  return (async () => {
    while (Atomics.load(ctrl, 0) === 0) await new Promise((r) => setTimeout(r, 1));
    // `first` is streamData[0], which the boolean replies (http_isreadable) use
    // instead of streamLen.
    return { status: status[0], len: len[0], first: data[0], data: data.slice(0, len[0]) };
  })();
}

const enc = (s) => new TextEncoder().encode(s);
const id = (await call({
  type: "http_send",
  address: enc("http://llm.eliza.internal/v1/chat/completions"),
  req: enc(JSON.stringify({ method: "POST", headers: {} })),
})).status;
assert.ok(id >= 0, "http_send must return a connection id");

await call({ type: "http_writebody", id, body: enc('{"stream":true}'), isEOF: true });

for (;;) {
  const r = await call({ type: "http_isreadable", id });
  if (r.first === 1) break;
  await new Promise((res) => setTimeout(res, 5));
}
let head = "";
for (;;) {
  const r = await call({ type: "http_recv", id, len: 4096 });
  head += new TextDecoder().decode(r.data);
  if (r.status === 1) break;
}
assert.equal(JSON.parse(head).status, 200, "response headers must reach the guest");

const arrivals = [];
let body = "";
const t0 = Date.now();
for (;;) {
  const r = await call({ type: "http_readbody", id, len: 4096 });
  if (r.len > 0) {
    body += new TextDecoder().decode(r.data);
    arrivals.push(Date.now() - t0);
  }
  if (r.status === 1) break;
  assert.ok(Date.now() - t0 < 10000, "body read must not hang");
}

assert.equal(body, CHUNKS.join(""), "every byte must be relayed once, in order");
assert.ok(arrivals.length >= CHUNKS.length,
          `chunks must be delivered incrementally, got ${arrivals.length} deliveries: ${arrivals}`);
assert.ok(arrivals[arrivals.length - 1] - arrivals[0] >= GAP_MS,
          `deliveries must be spread over the stream, not buffered: ${arrivals}`);

const after = await call({ type: "http_readbody", id, len: 4096 });
assert.equal(after.status, -1, "the connection must be gone after EOF");

console.log(`ok — ${arrivals.length} incremental deliveries at +${arrivals.join("ms, +")}ms, EOF once`);
