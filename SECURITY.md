# Security & Privacy

Claude Meter is a single-page HTML tool. It reads local JSONL logs in the browser and never transmits them anywhere.

## Threat model

- **Trust boundary:** the browser tab. All parsing, aggregation, and rendering happens in-process.
- **In scope:** data exfiltration (must be zero), tampering with bundled assets, supply-chain risks from third-party scripts.
- **Out of scope:** OS-level keyloggers, clipboard scrapers, malicious browser extensions, compromise of the user's Anthropic account.

The JSONL files dropped into the page are held in-memory only. A full page refresh discards them. No IndexedDB, no service worker, no session storage of raw events.

## Outbound network surface

**Intended outbound domains: zero.**

After the F0 (AdSense removal) and F6 (Chart.js inlining) changes, the page loads no third-party origin. Every asset is served from the same origin that serves `index.html` (GitHub Pages or your local filesystem).

| Asset | Origin | Notes |
|-------|--------|-------|
| `index.html` | same-origin | entrypoint |
| `src/vendor/chart.umd.min.js` | same-origin | bundled Chart.js 4.4.1 UMD |
| `src/css/*.css` | same-origin | styles |
| `src/js/*.js` | same-origin | parser, metrics, pricing, state, theme |

The `<a href="https://github.com/danielgomezrico/claude-statistics">` link is inert (no prefetch, no referrer leak until the user clicks it).

## How to verify

1. Open `index.html` in your browser.
2. Open DevTools → **Network** tab.
3. Hard-reload (Cmd/Ctrl+Shift+R).
4. Filter `Other` origins — the list MUST be empty. All requests should be same-origin.
5. Drop a JSONL folder. Watch the network tab stay silent while "Parsing … events" counts up. Nothing should leave the tab.
6. Optional: **Application → Storage → Clear site data** first to rule out cached third-party resources.

If you see any outbound request to a third-party origin, that is a security bug — please report it.

## Bundled asset integrity

Chart.js 4.4.1 UMD bundle is committed at `src/vendor/chart.umd.min.js`. Because it ships same-origin with the rest of the page, no Subresource Integrity (SRI) hash is needed on the `<script>` tag — the origin contract is the integrity guarantee.

For auditors who want to verify the bundle was not tampered with after download, compare with:

```
sha256sum src/vendor/chart.umd.min.js
```

The expected digest is recorded in `src/vendor/chart.umd.min.js.sha256` alongside the bundle.

Current SHA-256: `d2af8974e95271638772e9e9524db5b9a6f58d6ec2d5d781400447b4a31c681e`

Upstream source: https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js (downloaded once, then committed; never fetched at runtime).

## Reproducible build

Every push to `main` and every pull request runs the [Reproducible build workflow](.github/workflows/reproducible-build.yml). It checks out the commit, computes SHA-256 of the shipped assets in this exact order, and uploads `build-hashes.txt` as a public Actions artifact named `build-hashes-<sha>`:

```
sha256sum index.html src/vendor/chart.umd.min.js src/vendor/chart.umd.min.js.sha256 | tee build-hashes.txt
```

To verify what's served on GitHub Pages matches what's in the repo:

1. Note the commit SHA your `index.html` was built from (visible in DevTools → Network → response of `index.html` → `etag`/headers, or `git log -1 main`).
2. On the [Actions tab](https://github.com/danielgomezrico/claude-statistics/actions/workflows/reproducible-build.yml), open the run for that SHA and download the `build-hashes-<sha>` artifact.
3. Clone the same commit locally and run:
   ```
   git checkout <sha>
   ./scripts/verify-build.sh --plain
   ```
4. `diff` your local output with the unzipped `build-hashes.txt`. Empty diff = byte-for-byte parity.

`scripts/verify-build.sh` works on macOS (`shasum -a 256`) and Linux (`sha256sum`). It exits 0 on a clean checkout and non-zero if any of the listed files are missing.

If the hashes diverge, that is a security bug — please report it (see below).

## Reporting a vulnerability

Open a GitHub issue at https://github.com/danielgomezrico/claude-statistics/issues with the label `security`, or email the repository owner via the address on the GitHub profile. Please do not include raw JSONL in the report — a redacted snippet or synthetic reproduction is enough.

We aim to acknowledge reports within 7 days.
