/* Zone D · A8 — Tool usage treemap with error-rate overlay
 *
 * Area = call count. Color = error rate [0..30%] on a CB-safe sequential scale.
 * MCP tools (mcp__<server>__<tool>) are grouped at the top level under the
 * server bucket "mcp:<server>". Bare tools (Bash, Read, Edit, ...) get their
 * own top-level tile.
 *
 * Expected input (from the main parser — see index.html ingest):
 *   window.ClaudeMeter.state.tools = [
 *     { name, ts(Date), session, project, id, durationMs, isError }
 *   ]
 *
 * Public API:
 *   window.ClaudeMeter.toolTreemap.render(mountEl)
 */
(function () {
  const NS = (window.ClaudeMeter = window.ClaudeMeter || {});
  NS.state = NS.state || {};

  // Error-rate color scale (0 → 30%), CB-safe sequential.
  const COLOR_STOPS = [
    { t: 0.00, c: [27, 158, 119] },   // teal-green
    { t: 0.10, c: [216, 179, 101] },  // ochre
    { t: 0.20, c: [230, 97, 1]   },   // orange
    { t: 0.30, c: [178, 24, 43]  },   // red
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }
  function colorForErrRate(rate) {
    const x = Math.max(0, Math.min(0.30, rate)); // clamp 0..30%
    for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
      const s = COLOR_STOPS[i], e = COLOR_STOPS[i + 1];
      if (x >= s.t && x <= e.t) {
        const f = (x - s.t) / (e.t - s.t || 1);
        const r = Math.round(lerp(s.c[0], e.c[0], f));
        const g = Math.round(lerp(s.c[1], e.c[1], f));
        const b = Math.round(lerp(s.c[2], e.c[2], f));
        return `rgb(${r},${g},${b})`;
      }
    }
    const last = COLOR_STOPS[COLOR_STOPS.length - 1].c;
    return `rgb(${last[0]},${last[1]},${last[2]})`;
  }

  function luminance(rgbStr) {
    const m = rgbStr.match(/\d+/g);
    if (!m) return 0.5;
    const [r, g, b] = m.map(Number).map(v => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  }

  function groupTools(tools) {
    // returns [{ key, calls, errs, durs:[], isMcpGroup, children? }]
    const buckets = new Map();
    for (const t of tools) {
      const name = t.name || "unknown";
      const isMcp = name.startsWith("mcp__");
      if (isMcp) {
        const parts = name.split("__");
        const server = parts[1] || "unknown";
        const subTool = parts.slice(2).join("__") || name;
        const key = `mcp:${server}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            key, label: `mcp:${server}`, calls: 0, errs: 0, durs: [],
            isMcpGroup: true, server, childMap: new Map()
          });
        }
        const g = buckets.get(key);
        g.calls++;
        if (t.isError) g.errs++;
        if (typeof t.durationMs === "number") g.durs.push(t.durationMs);
        if (!g.childMap.has(subTool)) g.childMap.set(subTool, { name: subTool, calls: 0, errs: 0 });
        const c = g.childMap.get(subTool);
        c.calls++;
        if (t.isError) c.errs++;
      } else {
        if (!buckets.has(name)) {
          buckets.set(name, {
            key: name, label: name, calls: 0, errs: 0, durs: [],
            isMcpGroup: false
          });
        }
        const b = buckets.get(name);
        b.calls++;
        if (t.isError) b.errs++;
        if (typeof t.durationMs === "number") b.durs.push(t.durationMs);
      }
    }
    const arr = [];
    for (const b of buckets.values()) {
      const durs = b.durs.slice().sort((a, z) => a - z);
      arr.push({
        key: b.key,
        name: b.label,
        calls: b.calls,
        errs: b.errs,
        errRate: b.calls ? b.errs / b.calls : 0,
        p50: percentile(durs, 0.50),
        p95: percentile(durs, 0.95),
        isMcpGroup: !!b.isMcpGroup,
        children: b.childMap ? [...b.childMap.values()].sort((a, z) => z.calls - a.calls) : null
      });
    }
    return arr.sort((a, z) => z.calls - a.calls);
  }

  // Squarified treemap (Bruls/Huijing/van Wijk 2000) — returns per-item rects.
  function squarify(items, x, y, w, h) {
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    const result = [];
    const scaled = items.map(i => ({ ref: i, v: (i.value / total) * (w * h) }));
    layout(scaled, x, y, w, h, result);
    return result;
  }

  function worst(row, side) {
    const rowSum = row.reduce((s, r) => s + r.v, 0) || 1;
    const rMax = Math.max(...row.map(r => r.v));
    const rMin = Math.min(...row.map(r => r.v));
    const s2 = side * side;
    return Math.max((s2 * rMax) / (rowSum * rowSum), (rowSum * rowSum) / (s2 * rMin));
  }

  function layout(items, x, y, w, h, out) {
    if (!items.length) return;
    const side = Math.min(w, h);
    const row = [];
    let rest = items.slice();
    while (rest.length) {
      const candidate = row.concat([rest[0]]);
      if (row.length === 0 || worst(candidate, side) <= worst(row, side)) {
        row.push(rest.shift());
      } else {
        emitRow(row, x, y, w, h, out);
        const used = row.reduce((s, r) => s + r.v, 0);
        if (w >= h) {
          const rowW = used / h;
          x += rowW; w -= rowW;
        } else {
          const rowH = used / w;
          y += rowH; h -= rowH;
        }
        row.length = 0;
      }
    }
    if (row.length) {
      emitRow(row, x, y, w, h, out);
    }
  }

  function emitRow(row, x, y, w, h, out) {
    const sum = row.reduce((s, r) => s + r.v, 0) || 1;
    if (w >= h) {
      const rowW = sum / h;
      let yi = y;
      for (const r of row) {
        const rh = r.v / rowW;
        out.push({ ref: r.ref, x, y: yi, w: rowW, h: rh });
        yi += rh;
      }
    } else {
      const rowH = sum / w;
      let xi = x;
      for (const r of row) {
        const rw = r.v / rowH;
        out.push({ ref: r.ref, x: xi, y, w: rw, h: rowH });
        xi += rw;
      }
    }
  }

  function fmtMs(n) {
    if (!n || n < 1) return "—";
    if (n < 1000) return Math.round(n) + "ms";
    return (n / 1000).toFixed(n < 10000 ? 2 : 1) + "s";
  }

  function mountScaffold(mount) {
    mount.innerHTML = `
      <div class="card big" id="zd-treemap-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">Tool usage · error-rate overlay</h2>
          <div class="zone-sub">A8 · area = calls · color = error rate (0–30%)</div>
        </div>
        <div class="treemap-wrap" id="zd-treemap-wrap">
          <svg class="treemap-svg" id="zd-treemap-svg" preserveAspectRatio="none"></svg>
          <div class="treemap-tooltip" id="zd-treemap-tt"></div>
        </div>
        <div class="treemap-legend" id="zd-treemap-legend">
          <div class="swatch-row">
            <span>Error rate</span>
            <div>
              <div class="scale"></div>
              <div class="scale-labels"><span>0%</span><span>10%</span><span>20%</span><span>30%+</span></div>
            </div>
          </div>
          <div class="swatch-row" style="margin-left:auto">
            <span class="muted">Click tile → filter · hover → details</span>
          </div>
        </div>
      </div>`;
  }

  function filterByTool(name) {
    try {
      if (NS.filterBar && typeof NS.filterBar.setTool === "function") {
        NS.filterBar.setTool(name);
        return;
      }
    } catch (_) { /* ignore */ }
    // TODO: integrate with global filter bar when Stream 5 lands.
    console.log("[tool-treemap] filter requested:", name);
  }

  function render(mount) {
    if (!mount) return;
    if (!mount.querySelector("#zd-treemap-svg")) mountScaffold(mount);
    const svg = mount.querySelector("#zd-treemap-svg");
    const wrap = mount.querySelector("#zd-treemap-wrap");
    const tt = mount.querySelector("#zd-treemap-tt");
    if (!svg || !wrap) return;

    const tools = (NS.state && NS.state.tools) || [];
    svg.innerHTML = "";
    const prevEmpty = wrap.querySelector(".treemap-empty");
    if (prevEmpty) prevEmpty.remove();

    if (!tools.length) {
      const div = document.createElement("div");
      div.className = "treemap-empty";
      div.textContent = "No tool events in current filter range.";
      wrap.appendChild(div);
      return;
    }

    const groups = groupTools(tools);
    const w = wrap.clientWidth || 600;
    const h = wrap.clientHeight || 400;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);

    const items = groups.map(g => ({ value: g.calls, meta: g }));
    const rects = squarify(items, 0, 0, w, h);

    const svgns = "http://www.w3.org/2000/svg";
    for (const r of rects) {
      const meta = r.ref.meta;
      const color = colorForErrRate(meta.errRate);
      const tile = document.createElementNS(svgns, "rect");
      tile.setAttribute("class", "treemap-tile");
      tile.setAttribute("x", r.x);
      tile.setAttribute("y", r.y);
      tile.setAttribute("width", Math.max(0, r.w - 1));
      tile.setAttribute("height", Math.max(0, r.h - 1));
      tile.setAttribute("fill", color);
      tile.setAttribute("stroke", "rgba(11,13,18,0.6)");
      tile.setAttribute("stroke-width", "1");
      tile.addEventListener("click", () => filterByTool(meta.name));
      tile.addEventListener("mousemove", (ev) => {
        const rect = wrap.getBoundingClientRect();
        tt.classList.add("show");
        tt.innerHTML =
          `<strong>${escapeHtml(meta.name)}</strong><br>` +
          `<span class="tt-row">calls: <span>${meta.calls.toLocaleString()}</span></span><br>` +
          `<span class="tt-row">errors: <span>${meta.errs} (${(meta.errRate * 100).toFixed(1)}%)</span></span><br>` +
          `<span class="tt-row">p50 dur: <span>${fmtMs(meta.p50)}</span> · p95: <span>${fmtMs(meta.p95)}</span></span>` +
          (meta.isMcpGroup && meta.children ? `<br><span class="tt-row">${meta.children.length} tool${meta.children.length === 1 ? "" : "s"} in server</span>` : "");
        let tx = ev.clientX - rect.left + 12;
        let ty = ev.clientY - rect.top + 12;
        if (tx + tt.offsetWidth > rect.width) tx = ev.clientX - rect.left - tt.offsetWidth - 12;
        if (ty + tt.offsetHeight > rect.height) ty = ev.clientY - rect.top - tt.offsetHeight - 12;
        tt.style.left = tx + "px";
        tt.style.top = ty + "px";
      });
      tile.addEventListener("mouseleave", () => tt.classList.remove("show"));
      svg.appendChild(tile);

      // Labels — only when tile is large enough.
      if (r.w > 60 && r.h > 28) {
        const lum = luminance(color);
        const labelCls = lum < 0.5 ? "treemap-label light" : "treemap-label";
        const label = document.createElementNS(svgns, "text");
        label.setAttribute("class", labelCls);
        label.setAttribute("x", r.x + 6);
        label.setAttribute("y", r.y + 16);
        label.textContent = truncate(meta.name, Math.max(4, Math.floor(r.w / 7)));
        svg.appendChild(label);
        if (r.h > 44) {
          const sub = document.createElementNS(svgns, "text");
          sub.setAttribute("class", labelCls + " sub");
          sub.setAttribute("x", r.x + 6);
          sub.setAttribute("y", r.y + 30);
          sub.textContent = `${meta.calls.toLocaleString()} · ${(meta.errRate * 100).toFixed(1)}%`;
          svg.appendChild(sub);
        }
      }
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
  }
  function truncate(s, max) {
    s = String(s);
    return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
  }

  NS.toolTreemap = { render, _colorForErrRate: colorForErrRate, _groupTools: groupTools };

  // Re-render on resize (debounced).
  let rAF = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(rAF);
    rAF = requestAnimationFrame(() => {
      const mount = document.getElementById("zoneD-treemap-mount");
      if (mount && (NS.state.tools || []).length) render(mount);
    });
  });
})();
