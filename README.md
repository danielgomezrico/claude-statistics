# Claude Statistics Dashboard

Self-contained HTML dashboard that parses local Claude Code JSONL logs and visualizes usage, cost, and subscription ROI. Runs entirely in the browser — no data leaves your machine.

## Usage

1. Open `index.html` in any modern browser (or visit the GitHub Pages deployment).
2. Click the dropzone (or drag) and select `~/.claude/` (or `~/.claude/projects/`).
   - `Cmd+Shift+.` in the Finder file picker reveals hidden folders.
   - Or hit **See demo with sample data** to explore with synthetic usage.
3. Pick your subscription tier in the top-right selector.
4. Watch the progress bar while events parse in a few seconds.

The dashboard only reads files under `projects/` — plugin caches and other JSONL in `.claude/` are ignored.

## What you see

### KPIs (top row)

- **Total cost (API eq.)** — what the API would have charged at pay-per-token list prices for every message in the logs.
- **Sessions** — distinct session IDs found.
- **Tokens** — total input + output + cache read + cache write.
- **Subscription ROI (this month)** — `current-month API-equivalent / monthly subscription × 100%`. Over 100% means the subscription is extracting more value than you pay.

### Time-series charts

- **Spend over time** — bar chart with hourly / daily / weekly / monthly toggle.
- **Cost composition** — same buckets, stacked by input · output · cache read · cache write. Reveals which token category drives cost.
- **Cumulative spend vs subscription** — running API-equivalent total vs running subscription cost. The widening gap is captured value.
- **Models over time** — stacked bar per bucket by model id.
- **Cache hit ratio over time** — `cache_read / (cache_read + fresh input + cache write)`. Higher = more leverage per message.

### Activity patterns

- **Hour-of-day** — total spend per hour across all days (local tz).
- **Day-of-week** — total spend per weekday.
- **Activity heatmap** — 7×24 grid, darker = more spend. Reveals working rhythm at a glance.

### Attribution

- **Cost split by model** — doughnut of total spend per model across the whole range.
- **Top 10 sessions by cost** — horizontal bar showing the most expensive sessions (project · session-id).
- **Monthly summary vs subscription** — table with messages, token categories, API cost, subscription paid, net delta per month.
- **Top projects** — table sorted by cost showing sessions, messages, tokens.

### Pricing (editable)

Collapsible panel at the bottom with per-million-token rates for Opus / Sonnet / Haiku (plus a default fallback). Edit any value and every chart recomputes instantly.

## Example output

For a heavy Claude Code user over two months:

```
Total cost (API eq.)    $24,366.89
Sessions                1,181
Messages                197,100
Tokens                  13.07B   (in 5.5M · out 41.9M · cache r/w 12.31B / 711M)
Subscription ROI        7,783%   of $100/mo (Max 5×) — worth it
```

Interpretation: 78× the value of the flat $100 subscription. Cache reads dominate token count (~94% of all tokens) but cost-wise are cheap (~$0.30/M for Sonnet), so the bulk of API-equivalent cost comes from output and cache-write tokens.

## Notes

- "API cost" is always hypothetical — it's what the API would have billed at list price. Real spend is the flat subscription fee.
- Treat the ROI as a ceiling, not savings. Self-throttling and prompt optimization would lower the API equivalent in practice.
- Only Claude Code JSONL is parsed. Claude.ai web subscription usage is not logged locally and isn't counted.
- Pricing defaults target end-2025 list prices; edit the panel if rates change.

## Files

- `index.html` — the whole app, single file, no external data dependencies (one CDN import for Chart.js).
- `README.md` — this file.
- `LICENSE` — MIT.

## License

MIT — see [LICENSE](LICENSE).
