/*!
 * Zone C · A5 — Subagent / team cost sunburst
 * Inline SVG, 3-level: center = main thread, ring 1 = team, ring 2 = agent.
 * Data is grouped from events that carry {isSidechain, parentUuid, teamName, agentName, agentId}.
 * Click a wedge -> narrow global filter via window.ClaudeMeter.filterBar.setAgentSubtree(path)
 */
(function(){
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var FALLBACK_PALETTE = ["#d97757","#6ea8ff","#22c55e","#eab308","#a855f7","#06b6d4","#ef4444","#f97316","#14b8a6","#f472b6","#94a3b8","#84cc16"];

  function palette(){
    return (Array.isArray(window.CB_PALETTE) && window.CB_PALETTE.length) ? window.CB_PALETTE : FALLBACK_PALETTE;
  }

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }

  function eventTeam(ev){
    if (!ev.isSidechain) return "main";
    return ev.teamName || "unattributed subagents";
  }
  function eventAgent(ev){
    if (!ev.isSidechain) return "main";
    return ev.agentName || ev.agentId || "unattributed";
  }

  // Build 3-level tree: root -> team -> agent
  function buildTree(events){
    var root = { name:"root", cost:0, tokens:0, sessions:new Set(), children:new Map() };
    for (var i=0;i<events.length;i++){
      var e = events[i];
      var teamKey = eventTeam(e);
      var agentKey = eventAgent(e);
      var tok = (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0);
      root.cost += e.cost||0; root.tokens += tok; root.sessions.add(e.session);

      if (!root.children.has(teamKey)) root.children.set(teamKey, { name:teamKey, cost:0, tokens:0, sessions:new Set(), children:new Map() });
      var team = root.children.get(teamKey);
      team.cost += e.cost||0; team.tokens += tok; team.sessions.add(e.session);

      if (!team.children.has(agentKey)) team.children.set(agentKey, { name:agentKey, cost:0, tokens:0, sessions:new Set(), children:new Map() });
      var agent = team.children.get(agentKey);
      agent.cost += e.cost||0; agent.tokens += tok; agent.sessions.add(e.session);
    }
    return root;
  }

  function mapToArr(node){
    var out = { name:node.name, cost:node.cost, tokens:node.tokens, sessionCount:node.sessions.size, children:[] };
    if (node.children){
      var kids = [].concat.apply([], []);
      node.children.forEach(function(v){ kids.push(v); });
      kids.sort(function(a,b){ return b.cost - a.cost; });
      out.children = kids.map(mapToArr);
    }
    return out;
  }

  function arc(cx,cy,r0,r1,a0,a1){
    // Return SVG path string for a ring segment from angle a0..a1 (radians) between radii r0..r1
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    var x0 = cx + r1*Math.cos(a0), y0 = cy + r1*Math.sin(a0);
    var x1 = cx + r1*Math.cos(a1), y1 = cy + r1*Math.sin(a1);
    var x2 = cx + r0*Math.cos(a1), y2 = cy + r0*Math.sin(a1);
    var x3 = cx + r0*Math.cos(a0), y3 = cy + r0*Math.sin(a0);
    return "M"+x0+" "+y0+
           " A"+r1+" "+r1+" 0 "+large+" 1 "+x1+" "+y1+
           " L"+x2+" "+y2+
           " A"+r0+" "+r0+" 0 "+large+" 0 "+x3+" "+y3+
           " Z";
  }

  function shade(hex, pct){
    // Lighten (pct>0) or darken (pct<0) a hex color by percent
    var c = hex.replace("#","");
    if (c.length===3) c = c.split("").map(function(x){return x+x;}).join("");
    var r=parseInt(c.substr(0,2),16), g=parseInt(c.substr(2,2),16), b=parseInt(c.substr(4,2),16);
    var t = pct<0 ? 0 : 255;
    var p = Math.abs(pct);
    r = Math.round((t-r)*p)+r; g = Math.round((t-g)*p)+g; b = Math.round((t-b)*p)+b;
    function hx(n){ return n.toString(16).padStart(2,"0"); }
    return "#"+hx(r)+hx(g)+hx(b);
  }

  function summaryLabel(root){
    var tot = root.cost || 0.0001;
    var main = 0, team = 0, sub = 0;
    root.children.forEach(function(v){
      if (v.name === "main") main += v.cost;
      else if (v.name === "unattributed subagents") sub += v.cost;
      else team += v.cost;
    });
    var pct = function(x){ return Math.round((x/tot)*100); };
    return "Main: "+pct(main)+"% | Team: "+pct(team)+"% | Unattributed subagents: "+pct(sub)+"% of "+fmt$(tot)+" total";
  }

  function Sunburst(mountEl){
    this.mount = mountEl;
    this.drillPath = []; // [] = root view
    this.tree = null;
    this.rawRoot = null;
    this._build();
  }

  Sunburst.prototype._build = function(){
    this.mount.innerHTML = "";
    this.mount.classList.add("sb-wrap");

    this.crumbEl = document.createElement("div");
    this.crumbEl.className = "sb-breadcrumb";
    this.mount.appendChild(this.crumbEl);

    this.stageEl = document.createElement("div");
    this.stageEl.className = "sb-stage";
    this.mount.appendChild(this.stageEl);

    this.tooltip = document.createElement("div");
    this.tooltip.className = "sb-tooltip";
    this.stageEl.appendChild(this.tooltip);

    this.legendEl = document.createElement("div");
    this.legendEl.className = "sb-legend";
    this.mount.appendChild(this.legendEl);
  };

  Sunburst.prototype.render = function(events){
    if (!events || !events.length){
      this._renderEmpty("No events in current filter.");
      return;
    }
    var rawTree = buildTree(events);
    this.rawRoot = rawTree;
    var tree = mapToArr(rawTree);
    this.tree = tree;

    // Detect absence of sidechain/team content
    var sideCount = 0;
    tree.children.forEach(function(c){ if (c.name !== "main") sideCount += c.cost; });
    if (sideCount <= 0){
      this._renderEmpty('No sidechain/team events in current filter — subagent usage is rare here.');
      return;
    }

    this._renderBreadcrumb();
    this._renderSvg();
    this._renderLegend();
  };

  Sunburst.prototype._renderEmpty = function(msg){
    this.crumbEl.innerHTML = "";
    this.legendEl.innerHTML = "";
    this.stageEl.innerHTML = "";
    var e = document.createElement("div");
    e.className = "sb-empty";
    e.textContent = msg;
    this.stageEl.appendChild(e);
    // keep tooltip node for re-attach later
    this.stageEl.appendChild(this.tooltip);
  };

  Sunburst.prototype._currentNode = function(){
    var n = this.tree;
    for (var i=0;i<this.drillPath.length;i++){
      var name = this.drillPath[i];
      var child = (n.children||[]).find(function(c){ return c.name === name; });
      if (!child) return n;
      n = child;
    }
    return n;
  };

  Sunburst.prototype._renderBreadcrumb = function(){
    this.crumbEl.innerHTML = "";
    var self = this;
    var rootCrumb = document.createElement("span");
    rootCrumb.className = "sb-crumb";
    rootCrumb.textContent = "All";
    rootCrumb.addEventListener("click", function(){ self.drillPath = []; self._renderBreadcrumb(); self._renderSvg(); self._propagate(); });
    this.crumbEl.appendChild(rootCrumb);
    for (var i=0;i<this.drillPath.length;i++){
      (function(idx){
        var sep = document.createElement("span"); sep.className="sb-sep"; sep.textContent=" / ";
        self.crumbEl.appendChild(sep);
        var c = document.createElement("span");
        c.className = "sb-crumb"; c.textContent = self.drillPath[idx];
        c.addEventListener("click", function(){ self.drillPath = self.drillPath.slice(0, idx+1); self._renderBreadcrumb(); self._renderSvg(); self._propagate(); });
        self.crumbEl.appendChild(c);
      })(i);
    }
  };

  Sunburst.prototype._propagate = function(){
    var cm = window.ClaudeMeter;
    if (cm && cm.filterBar && typeof cm.filterBar.setAgentSubtree === "function"){
      try { cm.filterBar.setAgentSubtree(this.drillPath.slice()); } catch(e){ console.warn("[sunburst] filterBar.setAgentSubtree failed", e); }
    } else {
      console.log("[sunburst TODO] ClaudeMeter.filterBar.setAgentSubtree not available; drill path =", this.drillPath.slice());
    }
  };

  Sunburst.prototype._renderSvg = function(){
    // Clear stage but keep tooltip
    while (this.stageEl.firstChild){ this.stageEl.removeChild(this.stageEl.firstChild); }
    this.stageEl.appendChild(this.tooltip);

    var focus = this._currentNode();
    var size = 340, cx = size/2, cy = size/2;
    var rCenter = 42, rInner = 80, rMid = 140, rOuter = 160;

    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 "+size+" "+size);
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", summaryLabel(this.rawRoot));
    this.stageEl.appendChild(svg);

    var self = this;
    var pal = palette();

    var totalCost = focus.cost || 0.0001;

    // Ring 1: team-level (direct children of focus)
    var a0 = -Math.PI/2;
    var children = focus.children || [];
    children.forEach(function(team, i){
      var sweep = (team.cost / totalCost) * Math.PI * 2;
      if (sweep <= 0) return;
      var a1 = a0 + sweep;
      var color = pal[i % pal.length];

      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", arc(cx,cy, rInner, rMid, a0, a1));
      p.setAttribute("fill", color);
      p.setAttribute("class", "sb-wedge");
      p.setAttribute("data-name", team.name);
      p.setAttribute("data-depth", "team");
      p.addEventListener("mousemove", function(ev){ self._showTip(ev, team); });
      p.addEventListener("mouseleave", function(){ self._hideTip(); });
      p.addEventListener("click", function(){ self._onWedgeClick(team); });
      svg.appendChild(p);

      // Ring 2: agent-level
      var sa0 = a0;
      var gchildren = team.children || [];
      // If team is "main", its children are typically a single "main" agent — render same-color.
      gchildren.forEach(function(agent, j){
        var asweep = (agent.cost / (team.cost||0.0001)) * sweep;
        if (asweep <= 0) return;
        var sa1 = sa0 + asweep;
        var shadePct = 0.12 + (j % 5)*0.08;
        var acolor = shade(color, -shadePct);
        var pa = document.createElementNS(NS, "path");
        pa.setAttribute("d", arc(cx,cy, rMid, rOuter, sa0, sa1));
        pa.setAttribute("fill", acolor);
        pa.setAttribute("class", "sb-wedge");
        pa.setAttribute("data-name", agent.name);
        pa.setAttribute("data-depth", "agent");
        pa.addEventListener("mousemove", function(ev){ self._showTip(ev, agent); });
        pa.addEventListener("mouseleave", function(){ self._hideTip(); });
        pa.addEventListener("click", function(){ self._onWedgeClick(agent, team); });
        svg.appendChild(pa);
        sa0 = sa1;
      });

      a0 = a1;
    });

    // Center disc
    var centerCircle = document.createElementNS(NS, "circle");
    centerCircle.setAttribute("cx", cx); centerCircle.setAttribute("cy", cy); centerCircle.setAttribute("r", rCenter);
    centerCircle.setAttribute("fill", "var(--panel2,#171b24)");
    centerCircle.setAttribute("stroke", "var(--border,#262b38)");
    svg.appendChild(centerCircle);

    var centerLabel = document.createElementNS(NS, "text");
    centerLabel.setAttribute("x", cx); centerLabel.setAttribute("y", cy - 6);
    centerLabel.setAttribute("class", "sb-center-label");
    centerLabel.textContent = this.drillPath.length ? this.drillPath[this.drillPath.length-1] : "main thread";
    if (centerLabel.textContent.length > 14) centerLabel.textContent = centerLabel.textContent.slice(0,13)+"…";
    svg.appendChild(centerLabel);

    var centerSub = document.createElementNS(NS, "text");
    centerSub.setAttribute("x", cx); centerSub.setAttribute("y", cy + 10);
    centerSub.setAttribute("class", "sb-center-sub");
    centerSub.textContent = fmt$(focus.cost);
    svg.appendChild(centerSub);
  };

  Sunburst.prototype._renderLegend = function(){
    this.legendEl.innerHTML = "";
    var focus = this._currentNode();
    var pal = palette();
    var children = (focus.children||[]).slice(0, 12);
    var totalCost = focus.cost || 0.0001;
    children.forEach(function(c, i){
      var pct = Math.round((c.cost/totalCost)*100);
      var item = document.createElement("span");
      var dot = document.createElement("span");
      dot.className = "sb-dot";
      dot.style.background = pal[i % pal.length];
      item.appendChild(dot);
      item.appendChild(document.createTextNode(c.name + " (" + pct + "%)"));
      this.legendEl.appendChild(item);
    }, this);
  };

  Sunburst.prototype._onWedgeClick = function(node, teamContext){
    // Drill: if clicking team ring, push team name. If clicking agent ring, push team and agent.
    if (this.drillPath.length === 0){
      // Currently at root; "node" is either team level or agent level depending on depth
      if (teamContext){
        this.drillPath = [teamContext.name, node.name];
      } else {
        this.drillPath = [node.name];
      }
    } else if (this.drillPath.length === 1){
      // Currently focused on a team; any wedge click is an agent
      this.drillPath = [this.drillPath[0], node.name];
    } else {
      // At agent level already — noop
    }
    this._renderBreadcrumb();
    this._renderSvg();
    this._renderLegend();
    this._propagate();
  };

  Sunburst.prototype._showTip = function(ev, node){
    var tt = this.tooltip;
    tt.innerHTML =
      '<div class="sb-tt-title">'+escapeHtml(node.name)+'</div>'+
      '<div class="sb-tt-row">Cost: '+fmt$(node.cost)+'</div>'+
      '<div class="sb-tt-row">Tokens: '+fmtTok(node.tokens)+'</div>'+
      '<div class="sb-tt-row">Sessions: '+(node.sessionCount||0)+'</div>';
    var rect = this.stageEl.getBoundingClientRect();
    var x = ev.clientX - rect.left + 12;
    var y = ev.clientY - rect.top + 12;
    // keep within stage width
    if (x + 180 > rect.width) x = rect.width - 180;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
    tt.classList.add("show");
  };

  Sunburst.prototype._hideTip = function(){ this.tooltip.classList.remove("show"); };

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }

  // Public API
  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.sunburst = {
    create: function(mountEl){ return new Sunburst(mountEl); }
  };

})();
