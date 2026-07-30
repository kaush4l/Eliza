// Agent telemetry, derived entirely from the traffic this page already relays.
//
// Every request the guest makes passes through docs/stack.js on the page's main
// thread, so the page sees both bodies in full: the request carries the model id,
// the message list and the tool schemas; the streamed response carries the
// tool_calls the model chose and — because hermes sends
// stream_options={"include_usage": true} — an exact usage block.
//
// That is the whole dashboard for free. The alternative sources both cost the
// guest real time: hermes' own dashboard is a uvicorn server inside the VM
// (~0.5-7s per endpoint under Bochs, and unreachable besides), and its shell
// hooks fire a synchronous fork+exec per event on the agent's critical path.
// Scraping the TUI, which this replaces, only ever guessed.
(function (root) {
  "use strict";

  function newTracker(limit) {
    var max = limit || 60;
    var t = {
      calls: [],
      stats: {
        turns: 0, apiCalls: 0,
        tin: 0, tout: 0, cached: 0,
        promptLast: 0, toolsOffered: 0,
        model: "", tools: new Map(),
      },
      begin: begin, chunk: chunk, finish: finish,
    };

    // A request body is a Uint8Array by the time stack.js hands it to fetch
    // (http_writebody accumulates the guest's bytes); a string is accepted too
    // so this is testable and safe if that ever changes.
    function begin(method, path, body, now) {
      var rec = { m: method || "GET", p: path, t0: now, dec: new TextDecoder(), buf: "" };
      var req = parseJSON(body);
      if (req) {
        if (req.model) { rec.model = req.model; t.stats.model = req.model; }
        if (Array.isArray(req.tools)) rec.toolsOffered = t.stats.toolsOffered = req.tools.length;
        if (Array.isArray(req.messages)) {
          rec.msgs = req.messages.length;
          // The turn boundary: hermes appends tool results as messages and calls
          // again, so only a trailing user message starts a new turn.
          var last = req.messages[req.messages.length - 1];
          if (last && last.role === "user") { t.stats.turns++; rec.newTurn = true; }
        }
      }
      t.stats.apiCalls++;
      t.calls.push(rec);
      while (t.calls.length > max) t.calls.shift();
      return rec;
    }

    function chunk(rec, bytes, now) {
      if (rec.ttft === undefined) rec.ttft = Math.round(now - rec.t0);
      rec.now = now; // absorb() needs it to time the first real token
      rec.chunks = (rec.chunks || 0) + 1;
      rec.buf += rec.dec.decode(bytes, { stream: true });
      var nl;
      while ((nl = rec.buf.indexOf("\n")) >= 0) {
        var line = rec.buf.slice(0, nl).trim();
        rec.buf = rec.buf.slice(nl + 1);
        if (line.slice(0, 5) === "data:") absorb(rec, line.slice(5).trim());
      }
    }

    // Non-streamed replies (GET /v1/models, or a server ignoring stream:true)
    // arrive as one JSON document with no "data:" prefix, so flush the tail
    // through the same absorber rather than losing the usage block.
    function finish(rec, now) {
      rec.total = Math.round(now - rec.t0);
      var tail = rec.buf.trim();
      if (tail && tail.charAt(0) === "{") absorb(rec, tail);
      rec.buf = "";
      // Decode speed must be measured from the first frame that carried actual
      // output, not from the first frame full stop: servers send the opening
      // role delta immediately and only then prefill, so timing from there
      // charges the whole prefill to the decode rate (measured: 6 tokens over a
      // 16s call reported as 0.4 tok/s, when decode itself took a fraction of it).
      var from = rec.tok0 !== undefined ? rec.tok0 : rec.ttft;
      if (rec.tout && from !== undefined && rec.total > from) {
        rec.rate = +(rec.tout / ((rec.total - from) / 1000)).toFixed(1);
        rec.prefill = Math.round(from);
      }
      return rec;
    }

    function absorb(rec, payload) {
      if (!payload || payload === "[DONE]") return;
      var f = parseJSON(payload);
      if (!f) return;
      var u = f.usage;
      if (u) {
        rec.tin = u.prompt_tokens || 0;
        rec.tout = u.completion_tokens || 0;
        t.stats.tin += rec.tin;
        t.stats.tout += rec.tout;
        if (rec.tin) t.stats.promptLast = rec.tin;
        var d = u.prompt_tokens_details;
        if (d && d.cached_tokens) { rec.cached = d.cached_tokens; t.stats.cached += d.cached_tokens; }
      }
      var ch = (f.choices || [])[0];
      if (!ch) return;
      var dl = ch.delta || {};
      if (rec.tok0 === undefined && rec.now !== undefined && (dl.content || dl.tool_calls)) {
        rec.tok0 = Math.round(rec.now - rec.t0); // prefill ends, decode starts
      }
      // Streamed tool calls arrive as deltas keyed by index: the name lands once,
      // the arguments accumulate. Count a tool the first time its name appears.
      var tc = dl.tool_calls || (ch.message && ch.message.tool_calls);
      if (tc) {
        for (var i = 0; i < tc.length; i++) {
          var nm = tc[i].function && tc[i].function.name;
          if (!nm) continue;
          t.stats.tools.set(nm, (t.stats.tools.get(nm) || 0) + 1);
          rec.tools = (rec.tools || []).concat(nm);
        }
      }
      if (ch.finish_reason) rec.fin = ch.finish_reason;
    }

    return t;
  }

  function parseJSON(body) {
    if (!body) return null;
    try {
      return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    } catch (e) {
      return null; // a partial frame or a non-JSON body is not an error here
    }
  }

  root.Telemetry = { newTracker: newTracker };
})(typeof window !== "undefined" ? window : globalThis);
