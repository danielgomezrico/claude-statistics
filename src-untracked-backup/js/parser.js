/*
 * parser.js — JSONL ingest + per-line event extraction.
 * Public API (window.CM.parser):
 *   ingest(files, { onStatus(text), onProgress(pct0to100), onEvent(ev) })
 *                        → Promise<Event[]>  (also pushes to state.events as side effect)
 *   extractEvent(obj, proj) → Event | null
 *   walk(entry, out)        → recursively collects File[] from a DataTransferItemList entry
 *
 * Event shape: { ts:Date, model, inTok, outTok, crTok, cwTok, cost, session, project, cwd? }
 */
(function () {
  window.CM = window.CM || {};

  function extractEvent(obj, proj) {
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
    var p = window.CM.pricing.priceFor(model);
    var cost = (inTok * p.in + outTok * p.out + crTok * p.cacheRead + cwTok * p.cacheWrite) / 1e6;
    return {
      ts: new Date(ts),
      model: model,
      inTok: inTok, outTok: outTok, crTok: crTok, cwTok: cwTok,
      cost: cost,
      session: obj.sessionId || obj.session_id || '—',
      project: proj,
      cwd: obj.cwd || msg.cwd || null,
      isSidechain: obj.isSidechain === true || msg.isSidechain === true,
    };
  }

  async function walk(entry, out) {
    if (entry.isFile) {
      await new Promise(function (res) { entry.file(function (f) { out.push(f); res(); }); });
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      await new Promise(function (res) {
        var readBatch = function () {
          reader.readEntries(async function (ents) {
            if (!ents.length) return res();
            for (var i = 0; i < ents.length; i++) await walk(ents[i], out);
            readBatch();
          });
        };
        readBatch();
      });
    }
  }

  async function ingest(files, opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};
    var onProgress = opts.onProgress || function () {};

    var jsonl = files.filter(function (f) { return f.name.endsWith('.jsonl'); });
    var underProjects = jsonl.filter(function (f) {
      var p = f.webkitRelativePath || '';
      return p.indexOf('/projects/') >= 0 || p.indexOf('projects/') === 0;
    });
    if (underProjects.length) jsonl = underProjects;
    if (!jsonl.length) {
      onStatus('No .jsonl files found.');
      return [];
    }

    var state = window.CM.state;
    var t0 = performance.now();
    var total = 0, bytes = 0;
    var totalBytes = jsonl.reduce(function (s, f) { return s + f.size; }, 0);
    var events = state.raw.events;

    for (var i = 0; i < jsonl.length; i++) {
      var f = jsonl[i];
      var text = await f.text();
      var lines = text.split('\n');
      var pathParts = (f.webkitRelativePath || f.name).split('/');
      var proj = pathParts.slice(-2, -1)[0] || 'unknown';
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (!line.trim()) continue;
        var obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        var ev = extractEvent(obj, proj);
        if (ev) { events.push(ev); total++; }
      }
      bytes += f.size;
      onProgress((bytes / totalBytes) * 100);
      if (i % 25 === 0 || i === jsonl.length - 1) {
        var mb = (bytes / 1048576).toFixed(1);
        var mbTot = (totalBytes / 1048576).toFixed(1);
        onStatus('Parsing ' + (i + 1) + '/' + jsonl.length + ' files · ' + mb + '/' + mbTot + ' MB · ' + total.toLocaleString() + ' events');
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
    var secs = ((performance.now() - t0) / 1000).toFixed(1);
    onStatus('Loaded ' + total.toLocaleString() + ' events from ' + jsonl.length + ' file(s) in ' + secs + 's.');
    onProgress(100);
    state.publish('events:loaded', events);
    return events;
  }

  window.CM.parser = { ingest: ingest, walk: walk, extractEvent: extractEvent };
})();
