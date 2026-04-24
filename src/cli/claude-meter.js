#!/usr/bin/env node
/* claude-meter — F18 library-mode CLI export.
 *
 * Walks a Claude projects dir (default: ~/.claude/projects), parses all
 * *.jsonl files using the shared parser-core, and prints JSON aggregates
 * identical in shape to the browser's "Export all" output.
 *
 * Usage:
 *   node src/cli/claude-meter.js [--json] [--path ~/.claude/projects] [--help]
 */

"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");

var parser = require("../js/parser-core.js");

function parseArgs(argv){
  var out = { json: false, path: null, help: false };
  for (var i=0; i<argv.length; i++){
    var a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--path" || a === "-p"){
      out.path = argv[++i];
    } else if (a.indexOf("--path=") === 0){
      out.path = a.slice(7);
    }
  }
  return out;
}

function usage(){
  return [
    "claude-meter — JSON export of ~/.claude/projects usage.",
    "",
    "Usage:",
    "  claude-meter [--json] [--path <dir>]",
    "",
    "Options:",
    "  --json           Emit JSON (default when stdout is not a TTY).",
    "  --path <dir>     Path to projects dir (default: ~/.claude/projects).",
    "  -h, --help       Show this help and exit.",
    "",
    "Example:",
    "  claude-meter --json > usage.json",
    "",
    "Output shape:",
    "  { generatedAt, sourcePath, totals, byModel, byProject, byDay, sessions, events }",
  ].join("\n");
}

function walkJsonl(dir, out){
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch(_) { return; }
  for (var i=0;i<entries.length;i++){
    var ent = entries[i];
    var p = path.join(dir, ent.name);
    if (ent.isDirectory()){ walkJsonl(p, out); }
    else if (ent.isFile() && ent.name.endsWith(".jsonl")){ out.push(p); }
  }
}

function projectNameFor(filePath, rootPath){
  // Claude stores files as <projects>/<encoded-cwd>/<session>.jsonl
  // Use the first segment under rootPath.
  var rel = path.relative(rootPath, filePath);
  var parts = rel.split(path.sep);
  return parts[0] || "unknown";
}

function main(){
  var args = parseArgs(process.argv.slice(2));
  if (args.help){
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }

  var root = args.path || path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)){
    process.stderr.write("claude-meter: path does not exist: " + root + "\n");
    process.stderr.write("Hint: pass --path to point at a custom location.\n");
    process.exit(2);
  }

  var files = [];
  walkJsonl(root, files);

  var events = [];
  for (var i=0;i<files.length;i++){
    var f = files[i];
    var text; try { text = fs.readFileSync(f, "utf8"); } catch(e){ continue; }
    var proj = projectNameFor(f, root);
    var evs = parser.parseJsonlText(text, proj);
    for (var j=0;j<evs.length;j++) events.push(evs[j]);
  }

  var agg = parser.aggregate(events);
  var report = {
    generatedAt: new Date().toISOString(),
    sourcePath: root,
    fileCount: files.length,
    totals: agg.totals,
    byModel: agg.byModel,
    byProject: agg.byProject,
    byDay: agg.byDay,
    sessions: agg.sessions,
    events: events,
  };

  // If --json OR stdout is piped, emit JSON. Else a short human summary.
  var wantJson = args.json || !process.stdout.isTTY;
  if (wantJson){
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    var t = agg.totals;
    process.stdout.write([
      "claude-meter — " + files.length + " files, " + events.length + " events",
      "  total cost:     $" + (t.cost||0).toFixed(2),
      "  total tokens:   " + (t.inTok + t.outTok + t.crTok + t.cwTok).toLocaleString(),
      "  messages:       " + t.messages,
      "  sessions:       " + t.sessions,
      "",
      "Re-run with --json to emit full JSON.",
    ].join("\n") + "\n");
  }
}

main();
