# Browser render check (বার্ষিক উত্তরণ)

Real headless-Chrome verification of the annual-promotion rules. It renders the app
and measures what a teacher actually sees: computed colours, banner text, Topbar
badges and the promotion modal's layout.

```bash
npm run verify:render
```

Screenshots land in `scripts/browser/shots/` as proof.

## No live data

Every request to `*.firebaseio.com`, `*.firebaseapp.com` and Google's identity
toolkit is **aborted** by the check, so the app behaves exactly like an offline
teacher's browser: it paints from the local `resultweb:firebase-cache:*` snapshot
that `seed.mjs` writes before the first paint. The run can never read or write
Firebase data.

## Files

| File | Purpose |
|------|---------|
| `render-check.mjs` | The runner: builds, serves `dist-render-check`, drives Chrome, asserts |
| `seed.mjs` | Sample tenant + three years (2029 past / 2030 active / 2031 future) |
| `modalEntry.jsx` | Mounts **only** `AutoPromotionModal` with a controlled promotion log |
| `vite.render.config.mjs` | Two-page build (`index.html` + `modal-check.html`) |
| `/modal-check.html` | The harness page (project root — Vite resolves entries from there) |
| `shots/` | Screenshots taken by the run |

## What is asserted (47 checks)

1. **Active year** — no banner, no "শুধু দেখা" chip, Topbar shows the active year.
2. **Topbar list** — past ⇒ `লক`, active ⇒ `সক্রিয়`, future ⇒ `নির্বাচন করুন`
   (a future year is *never* marked `লক`).
3. **Past year** — the banner says "… সালের কার্যক্রম সম্পূর্ণ — শুধু দেখা যাবে…";
   its computed background is white/neutral and its text black; **every** text node
   in `main` is neutral; no coloured background and no gradient survives.
4. **Future year** — no banner, the shell is not `locked-view`, the text is still
   colourful and the class tabs are editable.
5. **Promotion modal** — the default class is the first unpromoted one, the six-row
   status list marks exactly the promoted class `সম্পূর্ণ`, the locked panel shows
   "আনলক করুন" and "আনলক করেছেন: <name> • <date> • <email>", and "উত্তরণ কার্যকর"
   opens a **centred** `role="alertdialog"` over a `position: fixed` overlay.

## Requirements

- Google Chrome (or Edge) installed — the check drives the system browser through
  `playwright-core`, so no browser download is needed.
- `playwright-core` is a verification-only tool, not an application dependency:
  `npm install --no-save playwright-core`.
