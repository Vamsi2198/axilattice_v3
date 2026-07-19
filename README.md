# Axilattice Insight Engine

Pre-computed analytics engine: Cube + Voice + NLU.  
Connect data → cube builds once → every question is a lookup.

---

## Architecture

```
frontend/ (React + Recharts)     → Vercel
backend/  (FastAPI + DuckDB)     → Render
```

### Core Design Decisions

| Problem in v3           | Fix in v1                                              |
|-------------------------|--------------------------------------------------------|
| Cardinality on cross-product | Per-dimension cutoff (default 50) in `profiler.py` |
| Time as categorical dim | 5 separate grain passes (day/week/month/quarter/year) |
| Keyword NLU              | Claude API intent parser with schema context          |
| Ephemeral in-memory cube | DuckDB persisted to disk on Render                    |
| No pre-computed deltas   | LAG window function baked into `axl_deltas` table     |

---

## Deploy Backend (Render)

1. Push `backend/` to a GitHub repo
2. Create a new **Web Service** on [render.com](https://render.com)
3. Connect your repo → Render auto-detects `render.yaml`
4. Add env var: `ANTHROPIC_API_KEY = sk-ant-...`
5. Deploy → note your service URL: `https://axilattice-backend.onrender.com`

---

## Deploy Frontend (Vercel)

1. Push `frontend/` to GitHub
2. Import project on [vercel.com](https://vercel.com)
3. Add env var: `REACT_APP_API_URL = https://axilattice-backend.onrender.com`
4. Update `vercel.json` → replace `your-backend.onrender.com` with your Render URL
5. Deploy

---

## Local Development

```bash
# Backend
cd backend
pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-ant-... uvicorn main:app --reload

# Frontend
cd frontend
npm install
REACT_APP_API_URL=http://localhost:8000 npm start
```

---

## Query Endpoints

| Endpoint              | Method | Description                          |
|-----------------------|--------|--------------------------------------|
| `/upload`             | POST   | Upload CSV/Excel/Parquet, build cube |
| `/query`              | POST   | NLU → cube lookup → card payload     |
| `/suggest`            | GET    | Contextual query suggestions         |
| `/schema`             | GET    | Schema + cube build status           |
| `/periods/{grain}`    | GET    | Available period keys                |
| `/dashboard`          | POST   | Save dashboard                       |
| `/dashboard/{id}`     | GET    | Load dashboard                       |
| `/health`             | GET    | Status check                         |

---

## Cube Design

The cube is a DuckDB table (`axl_cube`) with this schema:

```
grain       VARCHAR   -- day | week | month | quarter | year
period_key  VARCHAR   -- 2024-01 | 2024-Q1 | 2024 etc.
dim_combo   VARCHAR   -- region | region|category | __total__
dim_json    VARCHAR   -- {"region": "North"}
measure     VARCHAR   -- revenue | units | margin
val_sum     DOUBLE
val_count   BIGINT
val_min     DOUBLE
val_max     DOUBLE
val_mean    DOUBLE
val_stddev  DOUBLE
```

Deltas (period-over-period %) are pre-computed via `axl_deltas` using a LAG window.

---

## Cardinality Cutoff

Dimensions with > 50 distinct values are excluded from the cube (configurable in `profiler.py`).  
They remain queryable via DuckDB SQL fallback in `CubeEngine._raw()`.

**Why 50?** A bar chart with > 50 bars is unreadable. A cube cell for a dimension with 10,000 values wastes memory and produces noise, not insight.

---

## Roadmap

- [ ] Anomaly detection on cube deltas (±2σ auto-flag)
- [ ] Incremental CDC append (`CubeEngine.append()` is built, wire up `/append` endpoint)
- [ ] Multi-tenant (key cube by session token)
- [ ] Alert engine (threshold watchers on cube cells)
- [ ] Embedded iframe mode (drop into any BI tool)
"# axilattice_v3" 
