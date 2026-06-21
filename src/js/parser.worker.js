/*
 * parser.worker.js — JSONL parsing on a Web Worker (Wave 3 / perf).
 *
 * Loaded as a classic worker via `new Worker('src/js/parser.worker.js')`.
 *
 * Messages:
 *   in:  { type:'parse', files: [{ name, relPath, text }], pricing: [...] }
 *   out: { type:'progress', filesDone, filesTotal, eventsSoFar, bytesDone, bytesTotal }
 *        { type:'events', batch: [...] }              (streamed in chunks)
 *        { type:'done', total }
 *        { type:'error', message }
 */

// Try to import the shared parser-core; fall back to inlined logic if blocked
// (some hosts disallow importScripts in Workers).
var coreReady = false;
var core = null;
try {
  importScripts('parser-core.js');
  if (typeof self.ClaudeMeter !== 'undefined' && self.ClaudeMeter.parserCore) {
    core = self.ClaudeMeter.parserCore;
    coreReady = true;
  }
} catch (e) {
  // Will fall through to inline parser below.
}

var DEFAULT_PRICING = [
  { match: 'opus',   in:  5.00, out: 25.00, cacheRead: 0.50, cacheWrite:  6.25 },
  { match: 'sonnet', in:  3.00, out: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  { match: 'haiku',  in:  1.00, out:  5.00, cacheRead: 0.10, cacheWrite:  1.25 },
  { match: '',       in:  3.00, out: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
];

// Mirror of deriveProject() in index.html: Claude Cowork transcripts live under
// an opaque encoded folder, so group them as "cowork"; Claude Code transcripts
// use the second-to-last path segment (the url-encoded project dir).
function deriveProject(relPath, name) {
  var p = relPath || name || '';
  if (p.indexOf('local-agent-mode-sessions') >= 0) return 'cowork';
  return p.split('/').slice(-2, -1)[0] || 'unknown';
}

function priceFor(pricing, model) {
  var m = (model || '').toLowerCase();
  for (var i = 0; i < pricing.length; i++) {
    var p = pricing[i];
    if (p.match && m.indexOf(p.match) >= 0) return p;
  }
  return pricing[pricing.length - 1];
}

// Inline event extractor — extended schema (matches the inline extractEvent in
// index.html so downstream Zone C/D modules keep working when the worker path
// is taken).
function extractEvent(obj, proj, pricing) {
  var msg = obj.message || obj;
  var usage = msg && msg.usage;
  if (!usage) return null;
  var ts = obj.timestamp || msg.timestamp || obj.createdAt;
  if (!ts) return null;
  var model = msg.model || obj.model || 'unknown';
  var inTok = usage.input_tokens || 0;
  var outTok = usage.output_tokens || 0;
  var crTok = usage.cache_read_input_tokens || 0;
  var cwTok = usage.cache_creation_input_tokens || 0;
  if (!(inTok || outTok || crTok || cwTok)) return null;
  var p = priceFor(pricing, model);
  var cost = (inTok * p.in + outTok * p.out + crTok * p.cacheRead + cwTok * p.cacheWrite) / 1e6;
  var toolCalls = null;
  var content = msg && msg.content;
  if (Array.isArray(content)) {
    toolCalls = {};
    for (var k = 0; k < content.length; k++) {
      var c = content[k];
      if (c && c.type === 'tool_use' && c.name) {
        toolCalls[c.name] = (toolCalls[c.name] || 0) + 1;
      }
    }
  }
  var stopReason = msg && (msg.stop_reason || msg.stopReason);
  return {
    ts: new Date(ts).toISOString(),  // worker can't structured-clone Date safely across all browsers — main thread re-hydrates.
    model: model, inTok: inTok, outTok: outTok, crTok: crTok, cwTok: cwTok, cost: cost,
    session: obj.sessionId || obj.session_id || '—',
    project: proj,
    cwd: obj.cwd || msg.cwd || '',
    gitBranch: obj.gitBranch || msg.gitBranch || '',
    uuid: obj.uuid || null,
    parentUuid: obj.parentUuid || obj.logicalParentUuid || null,
    isSidechain: !!obj.isSidechain,
    teamName: obj.teamName || null,
    agentName: obj.agentName || null,
    agentId: obj.agentId || null,
    stopReason: stopReason || null,
    toolCalls: toolCalls,
  };
}

var streamPricing = DEFAULT_PRICING;
var streamBatch = [];
var streamTotal = 0;
var STREAM_BATCH_SIZE = 1000;

function flushStreamBatch() {
  if (streamBatch.length) {
    self.postMessage({ type: 'events', batch: streamBatch });
    streamBatch = [];
  }
}

function processFile(name, relPath, text) {
  var proj = deriveProject(relPath, name);
  var lines = text.split('\n');
  for (var j = 0; j < lines.length; j++) {
    var line = lines[j];
    if (!line || !line.trim()) continue;
    var obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    var ev = extractEvent(obj, proj, streamPricing);
    if (!ev) continue;
    streamBatch.push(ev); streamTotal++;
    if (streamBatch.length >= STREAM_BATCH_SIZE) flushStreamBatch();
  }
}

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    if (msg.type === 'init') {
      streamPricing = msg.pricing || DEFAULT_PRICING;
      streamBatch = [];
      streamTotal = 0;
    } else if (msg.type === 'file') {
      processFile(msg.name, msg.relPath, msg.text || '');
    } else if (msg.type === 'finish') {
      flushStreamBatch();
      self.postMessage({ type: 'done', total: streamTotal });
    } else if (msg.type === 'parse') {
      // Legacy bulk path — still supported for callers that fit in a single message.
      var files = msg.files || [];
      var pricing = msg.pricing || DEFAULT_PRICING;
      parseAll(files, pricing);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function parseAll(files, pricing) {
  var total = 0;
  var totalBytes = files.reduce(function (s, f) { return s + (f.size || (f.text ? f.text.length : 0)); }, 0);
  var bytesDone = 0;
  var BATCH = 1000;
  var batch = [];

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var text = f.text || '';
    var proj = deriveProject(f.relPath, f.name);
    var lines = text.split('\n');
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (!line || !line.trim()) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      var ev = extractEvent(obj, proj, pricing);
      if (!ev) continue;
      batch.push(ev); total++;
      if (batch.length >= BATCH) {
        self.postMessage({ type: 'events', batch: batch });
        batch = [];
      }
    }
    bytesDone += (f.size || text.length || 0);
    self.postMessage({
      type: 'progress',
      filesDone: i + 1,
      filesTotal: files.length,
      eventsSoFar: total,
      bytesDone: bytesDone,
      bytesTotal: totalBytes,
    });
  }
  if (batch.length) self.postMessage({ type: 'events', batch: batch });
  self.postMessage({ type: 'done', total: total });
}
