# claude-meter CLI

Library-mode export of the same JSONL-aggregation logic used by the browser dashboard. No dependencies.

```bash
node src/cli/claude-meter.js --help
node src/cli/claude-meter.js --json > usage.json
node src/cli/claude-meter.js --path ~/.claude/projects --json
```

Output shape: `{ generatedAt, sourcePath, fileCount, totals, byModel, byProject, byDay, sessions, events }`.
