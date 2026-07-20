# Axilattice — Insight Engine

A pre-computed, voice-enabled analytics engine that runs **entirely in your browser**.
No backend. No database. No server. Just a static React site.

Upload a CSV → it profiles the schema, builds a pre-computed cube, and answers
questions instantly (voice or text). Diagnostic questions trigger an agent that
reasons step-by-step.

---

## Why this version deploys when the old one didn't

The previous package tried to deploy a Python/FastAPI backend + React frontend as
one Render service. That's fragile and unnecessary — **the engine runs in the browser**,
so there is nothing server-side to deploy. This package is a plain static site.

Two things that were silently breaking the build, now fixed:
1. Conflicting deploy configs at root + backend level → removed. One clean config each.
2. Unused imports → CRA builds run with `CI=true`, which turns lint warnings into
   hard errors. Those imports are removed, and `CI=false` is set as a safety net.

---
--

## Deploy to Vercel (recommended, easiest)

1. Push this folder to a GitHub repo.
2. Go to vercel.com → **Add New → Project** → import the repo.
3. Vercel auto-detects Create React App. Leave all settings default.
4. Click **Deploy**. Done — live in ~60 seconds.

That's it. `vercel.json` handles SPA routing.

---

## Deploy to Render (static site)

1. Push this folder to a GitHub repo.
2. Go to render.com → **New → Static Site** → connect the repo.
   (Choose **Static Site**, NOT Web Service. This is the key fix.)
3. Render reads `render.yaml` automatically. If asked, use:
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `build`
4. Click **Create Static Site**. Live in a couple of minutes.

Because it's a static site (not a web service), there are **no cold starts** —
it's always instantly available.

---

## Run locally

```bash
npm install
npm start        # opens http://localhost:3000
```

Then click "Drop a CSV to build the cube" and upload one of the sample files.

---

## Sample data

Grab the sample CSVs from the main project's `sample_data/` folder:
- `ecommerce_orders.csv`
- `quickcommerce_deliveries.csv`

Upload either one. Try:
- "revenue by region this month" (instant)
- "monthly revenue trend"
- "why did revenue drop?" (watch the agent reason)

---

## File structure

```
axilattice/
├── package.json      # dependencies + build scripts (pinned versions)
├── render.yaml       # Render static-site config
├── vercel.json       # Vercel SPA routing
├── .nvmrc            # Node version pin (20.11.1)
├── public/
│   └── index.html
└── src/
    ├── index.js      # React entry
    ├── App.js        # UI: upload, query bar, cards, agent, dashboard
    └── engine.js     # in-browser cube: parse → profile → build → query
```

No `backend/` folder. Nothing else needed.
