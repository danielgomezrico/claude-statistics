/* alert-2x.js — Wave 3 D1 / F20
 * Persona: David (CFO). Pain: surprise spend spikes.
 * Compares trailing-24h spend vs trailing-7d-mean. If today > threshold × mean, surfaces banner.
 * NO outbound HTTP — opens mailto: only. localStorage-backed config + last-notified gate.
 * Public API: window.ClaudeMeter.alert2x = { mount(el), check(events), getConfig(), setConfig(c) }
 */
(function(){
  window.ClaudeMeter = window.ClaudeMeter || {};

  var KEY_CFG = "cm.alert.2x";
  var KEY_LAST = "cm.alert.lastNotified";
  var DEFAULT = { enabled:true, email:"", threshold:2.0 };

  function getConfig(){
    try { var raw = localStorage.getItem(KEY_CFG); if (raw) return Object.assign({}, DEFAULT, JSON.parse(raw)); } catch(e){}
    return Object.assign({}, DEFAULT);
  }
  function setConfig(c){
    try { localStorage.setItem(KEY_CFG, JSON.stringify(c||{})); } catch(e){}
  }
  function dayKey(d){ var x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); }
  function todayKey(){ return dayKey(new Date()); }

  function compute(events){
    if (!events || !events.length) return null;
    var now = Date.now();
    var d24 = now - 86400000;
    var d7 = now - 7*86400000;
    var costToday = 0, cost7d = 0;
    for (var i=0;i<events.length;i++){
      var t = +events[i].ts;
      if (t >= d24) costToday += events[i].cost || 0;
      if (t >= d7 && t < d24) cost7d += events[i].cost || 0;
    }
    var mean = cost7d / 6; // 6 prior full days (excluding last 24h)
    return { costToday: costToday, mean7: mean, ratio: mean > 0 ? costToday/mean : 0 };
  }

  function buildMailto(stats, cfg){
    var subj = encodeURIComponent("Claude Meter alert: spend " + stats.ratio.toFixed(2) + "× your 7-day average");
    var url = (typeof location !== "undefined" ? location.href : "");
    var body = encodeURIComponent(
      "Heads-up — Claude Meter detected a spend spike.\n\n" +
      "Trailing-24h spend : $" + stats.costToday.toFixed(2) + "\n" +
      "Trailing-7d mean   : $" + stats.mean7.toFixed(2) + "\n" +
      "Ratio              : " + stats.ratio.toFixed(2) + "× (threshold " + cfg.threshold.toFixed(2) + "×)\n\n" +
      "Open the dashboard locally:\n" + url + "\n\n" +
      "(Generated locally by Claude Meter — no data left your machine.)"
    );
    var to = cfg.email ? encodeURIComponent(cfg.email) : "";
    return "mailto:" + to + "?subject=" + subj + "&body=" + body;
  }

  var rootEl = null;

  function ensureMount(){
    if (rootEl) return rootEl;
    rootEl = document.getElementById("cmAlert2x");
    if (rootEl) return rootEl;
    rootEl = document.createElement("div");
    rootEl.id = "cmAlert2x";
    rootEl.className = "cm-alert-2x";
    var main = document.querySelector("main");
    if (main && main.parentNode) main.parentNode.insertBefore(rootEl, main);
    else document.body.insertBefore(rootEl, document.body.firstChild);
    return rootEl;
  }

  function render(stats, cfg){
    var el = ensureMount();
    el.innerHTML = "";
    var msg = document.createElement("div");
    msg.className = "cm-alert-msg";
    msg.innerHTML = "<strong>Heads-up:</strong> today's spend is <strong>" +
      stats.ratio.toFixed(2) + "×</strong> your 7-day average ($" +
      stats.costToday.toFixed(2) + " vs $" + stats.mean7.toFixed(2) + " avg).";
    var actions = document.createElement("div");
    actions.className = "cm-alert-actions";
    var mailBtn = document.createElement("a");
    mailBtn.className = "cm-alert-btn";
    mailBtn.href = buildMailto(stats, cfg);
    mailBtn.textContent = "Email me a copy";
    var cfgBtn = document.createElement("button");
    cfgBtn.type = "button"; cfgBtn.className = "cm-alert-btn"; cfgBtn.textContent = "Settings";
    var dismiss = document.createElement("button");
    dismiss.type = "button"; dismiss.className = "cm-alert-btn dismiss"; dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", function(){
      try { localStorage.setItem(KEY_LAST, String(todayKey())); } catch(e){}
      el.classList.remove("show");
    });
    actions.appendChild(mailBtn);
    actions.appendChild(cfgBtn);
    actions.appendChild(dismiss);
    el.appendChild(msg);
    el.appendChild(actions);

    var settings = document.createElement("div");
    settings.className = "cm-alert-settings";
    var lblOn = document.createElement("label");
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = cfg.enabled !== false;
    lblOn.appendChild(cb); lblOn.appendChild(document.createTextNode(" Enabled"));
    var lblEmail = document.createElement("label");
    var em = document.createElement("input"); em.type = "email"; em.placeholder = "you@example.com"; em.value = cfg.email||"";
    lblEmail.appendChild(document.createTextNode("Email: ")); lblEmail.appendChild(em);
    var lblThr = document.createElement("label");
    var thr = document.createElement("input"); thr.type = "number"; thr.step = "0.1"; thr.min = "1"; thr.value = cfg.threshold;
    lblThr.appendChild(document.createTextNode("Threshold (× 7d avg): ")); lblThr.appendChild(thr);
    var save = document.createElement("button");
    save.type = "button"; save.className = "cm-alert-btn"; save.textContent = "Save";
    save.addEventListener("click", function(){
      var n = parseFloat(thr.value); if (!(n >= 1)) n = DEFAULT.threshold;
      setConfig({ enabled: cb.checked, email: em.value.trim(), threshold: n });
      settings.classList.remove("open");
      mailBtn.href = buildMailto(stats, getConfig());
    });
    settings.appendChild(lblOn); settings.appendChild(lblEmail); settings.appendChild(lblThr); settings.appendChild(save);
    el.appendChild(settings);
    cfgBtn.addEventListener("click", function(){ settings.classList.toggle("open"); });
    el.classList.add("show");
  }

  function shouldShow(stats, cfg){
    if (!cfg || cfg.enabled === false) return false;
    if (!(stats && stats.mean7 > 0)) return false;
    if (stats.ratio < (cfg.threshold || 2)) return false;
    var last = 0;
    try { last = parseInt(localStorage.getItem(KEY_LAST)||"0", 10) || 0; } catch(e){}
    if (last >= todayKey()) return false; // already notified today
    return true;
  }

  function check(events){
    var cfg = getConfig();
    var stats = compute(events);
    if (!stats) { hide(); return null; }
    if (!shouldShow(stats, cfg)) {
      // If config disabled, hide entirely. If just suppressed today, also hide.
      hide();
      return stats;
    }
    render(stats, cfg);
    return stats;
  }

  function hide(){
    var el = document.getElementById("cmAlert2x");
    if (el) el.classList.remove("show");
  }

  function mount(){
    ensureMount();
    if (window.ClaudeMeter && window.ClaudeMeter.filterBar) {
      try {
        window.ClaudeMeter.filterBar.onChange(function(){
          var st = (window.STATE && window.STATE.events) || [];
          var fb = window.ClaudeMeter.filterBar; if (fb) st = fb.applyFilters(st);
          check(st);
        });
      } catch(e){}
    }
  }

  window.ClaudeMeter.alert2x = {
    mount: mount, check: check, compute: compute,
    getConfig: getConfig, setConfig: setConfig, _shouldShow: shouldShow,
  };
})();
