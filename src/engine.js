/* ════════════════════════════════════════════════════════════════════════
   AXILATTICE — In-Browser Engine
   ────────────────────────────────────────────────────────────────────────
   A dependency-free port of the backend (profiler.py + cube.py) that runs
   entirely client-side. Parses CSV → profiles schema → builds a pre-computed
   cube → answers queries as O(1) lookups. Deployable as a static site.

   Mirrors backend semantics exactly:
     - Per-dimension cardinality cutoff (50)
     - Time grain hierarchy: day → week → month → quarter → year
     - Identifier / high-cardinality exclusion
     - Pre-computed deltas + ranks
   ════════════════════════════════════════════════════════════════════════ */

export const CARDINALITY_CUTOFF   = 50;
export const ID_RATIO_THRESHOLD   = 0.85;
export const MIN_NUMERIC_UNIQUE   = 12;   // ≤ this distinct → coded categorical
export const TEXT_AVG_LEN         = 60;
const ID_NAME_HINTS = ["id","uuid","guid","key","code","ref"];
export const TIME_GRAINS = ["day","week","month","quarter","year"];

/* ─── CSV PARSER (RFC-4180-ish, handles quotes, commas, CRLF) ─────────────── */
export function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  // strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i+1];
    if (inQuotes) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r" && n === "\n") { row.push(field); rows.push(row); row=[]; field=""; i++; }
      else if (c === "\n" || c === "\r") { row.push(field); rows.push(row); row=[]; field=""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], data: [] };
  const headers = rows[0].map(h => h.trim());
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue; // blank line
    const obj = {};
    headers.forEach((h, ci) => { obj[h] = rows[r][ci] !== undefined ? rows[r][ci] : ""; });
    data.push(obj);
  }
  return { headers, data };
}

/* ─── TYPE INFERENCE HELPERS ──────────────────────────────────────────────── */
const DATE_RE = [
  /^\d{4}-\d{2}-\d{2}$/,                         // 2024-01-31
  /^\d{4}\/\d{2}\/\d{2}$/,                       // 2024/01/31
  /^\d{2}[-/]\d{2}[-/]\d{4}$/,                   // 31-01-2024
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/,  // 2024-01-31 12:00[:00]
  /^\d{1,2}[-/][A-Za-z]{3}[-/]\d{2,4}$/,         // 31-Jan-2024
];
function looksLikeDate(vals) {
  const sample = vals.slice(0, 60).filter(v => v !== "" && v != null);
  if (sample.length < 3) return false;
  let hits = 0;
  for (const v of sample) {
    const s = String(v).trim();
    // STRICT: must match an explicit date pattern AND parse to a real date.
    // No bare Date.parse() fallback — it treats "ORD-100001", "5", etc. as dates.
    if (DATE_RE.some(re => re.test(s))) {
      const d = new Date(s.replace(/\//g, "-"));
      if (!isNaN(d) && d.getFullYear() > 1900 && d.getFullYear() < 2200) hits++;
    }
  }
  return hits / sample.length > 0.8;
}
function isNumericVal(v) {
  if (v === "" || v == null) return false;
  return !isNaN(Number(v)) && isFinite(Number(v));
}
function nameLooksLikeId(name) {
  return name.toLowerCase().split(/[_\s-]+/).some(t => ID_NAME_HINTS.includes(t));
}

/* ─── PROFILER ────────────────────────────────────────────────────────────── */
export function profile(headers, data) {
  const n = data.length;
  const dims = [], measures = [], excludedDims = [], idCols = [];
  let timeCol = null;
  const schema = {};

  for (const col of headers) {
    const raw = data.map(r => r[col]);
    const nonNull = raw.filter(v => v !== "" && v != null);
    const distinct = new Set(nonNull);
    const uniq = distinct.size;
    const ratio = n ? uniq / n : 0;
    const nullPct = n ? (1 - nonNull.length / n) * 100 : 0;
    const numericShare = nonNull.length
      ? nonNull.filter(isNumericVal).length / nonNull.length : 0;
    const isNum = numericShare > 0.95;

    let type;

    // 1. temporal (first one wins)
    if (!timeCol && looksLikeDate(nonNull)) {
      type = "temporal"; timeCol = col;
    }
    // 2. name-based identifier
    else if (nameLooksLikeId(col) && (uniq > CARDINALITY_CUTOFF || ratio >= ID_RATIO_THRESHOLD)) {
      type = "identifier"; idCols.push(col);
    }
    // 3. numeric
    else if (isNum) {
      if (uniq <= MIN_NUMERIC_UNIQUE) {
        type = "dimension";
        dims.push({ col, cardinality: uniq, coded: true,
          values: [...distinct].map(Number).sort((a,b)=>a-b).map(String) });
      } else {
        const nums = nonNull.map(Number);
        const mean = nums.reduce((a,b)=>a+b,0) / (nums.length||1);
        const std = Math.sqrt(nums.reduce((a,b)=>a+(b-mean)**2,0)/(nums.length||1));
        if (std === 0) { type = "identifier"; idCols.push(col); }
        else { type = "measure"; measures.push({ col, mean, std,
          min: Math.min(...nums), max: Math.max(...nums) }); }
      }
    }
    // 4. boolean
    else if (uniq === 2) {
      type = "dimension"; dims.push({ col, cardinality: 2, values:[...distinct] });
    }
    // 5. string
    else {
      const avgLen = nonNull.length
        ? nonNull.reduce((a,v)=>a+String(v).length,0)/nonNull.length : 0;
      if (avgLen > TEXT_AVG_LEN) { type = "text"; }
      else if (ratio >= ID_RATIO_THRESHOLD && uniq > CARDINALITY_CUTOFF) {
        type = "identifier"; idCols.push(col);
      }
      else if (uniq <= CARDINALITY_CUTOFF) {
        type = "dimension"; dims.push({ col, cardinality: uniq, values:[...distinct] });
      }
      else { type = "dim_high_card"; excludedDims.push({ col, cardinality: uniq }); }
    }

    schema[col] = { type, cardinality: uniq, nullPct: +nullPct.toFixed(1),
      sample: [...distinct].slice(0,5).map(String) };
  }

  return { dims, measures, excludedDims, idCols, timeCol,
    rowCount: n, colCount: headers.length, schema };
}

/* ─── GRAIN KEY EXTRACTION ────────────────────────────────────────────────── */
function periodKey(dateStr, grain) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  switch (grain) {
    case "day":   return dateStr.slice(0,10);
    case "week": {
      // ISO week
      const t = new Date(Date.UTC(y, d.getMonth(), d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const yStart = new Date(Date.UTC(t.getUTCFullYear(),0,1));
      const wk = Math.ceil((((t - yStart)/86400000)+1)/7);
      return `${t.getUTCFullYear()}-W${String(wk).padStart(2,"0")}`;
    }
    case "month":   return `${y}-${String(m).padStart(2,"0")}`;
    case "quarter": return `${y}-Q${Math.ceil(m/3)}`;
    case "year":    return `${y}`;
    default: return null;
  }
}

/* ─── CUBE BUILDER ────────────────────────────────────────────────────────── */
export function buildCube(data, prof) {
  const { dims, measures, timeCol } = prof;
  const cubeDims = dims.filter(d => d.cardinality <= CARDINALITY_CUTOFF);
  const measureCols = measures.map(m => m.col);

  // cube structure:
  //   cells[grain][dimCombo][periodKey][dimValueKey][measure] = {sum,count,min,max}
  //   totals[grain][periodKey][measure] = {...}
  const cube = { cells: {}, totals: {}, meta: {} };
  for (const g of TIME_GRAINS) { cube.cells[g] = {}; cube.totals[g] = {}; }

  const bump = (bucket, measure, val) => {
    let c = bucket[measure];
    if (!c) { c = bucket[measure] = { sum:0, count:0, min:Infinity, max:-Infinity }; }
    c.sum += val; c.count += 1;
    if (val < c.min) c.min = val;
    if (val > c.max) c.max = val;
  };

  // Determine which 2-way dimension pairs to precompute.
  // Guard: skip pairs whose combined cardinality is unreadably large.
  const MAX_PAIR_CELLS = 400;
  const crossPairs = [];
  for (let i = 0; i < cubeDims.length; i++) {
    for (let j = i+1; j < cubeDims.length; j++) {
      const a = cubeDims[i], b = cubeDims[j];
      if (a.cardinality * b.cardinality <= MAX_PAIR_CELLS) {
        crossPairs.push([a.col, b.col, `${a.col}|${b.col}`]);
      }
    }
  }
  cube.crossPairs = crossPairs.map(p => p[2]);

  for (const row of data) {
    if (!timeCol) continue;
    const dateStr = row[timeCol];
    if (!dateStr) continue;

    // parse measures once
    const mvals = {};
    for (const mc of measureCols) {
      const v = row[mc];
      if (v === "" || v == null || isNaN(Number(v))) continue;
      mvals[mc] = Number(v);
    }

    for (const g of TIME_GRAINS) {
      const pk = periodKey(dateStr, g);
      if (!pk) continue;

      // totals
      if (!cube.totals[g][pk]) cube.totals[g][pk] = {};
      for (const mc in mvals) bump(cube.totals[g][pk], mc, mvals[mc]);

      // single-dim cells
      for (const d of cubeDims) {
        const dv = row[d.col];
        if (dv === "" || dv == null) continue;
        const combo = d.col;
        if (!cube.cells[g][combo]) cube.cells[g][combo] = {};
        if (!cube.cells[g][combo][pk]) cube.cells[g][combo][pk] = {};
        if (!cube.cells[g][combo][pk][dv]) cube.cells[g][combo][pk][dv] = {};
        for (const mc in mvals) bump(cube.cells[g][combo][pk][dv], mc, mvals[mc]);
      }

      // 2-way cross cells (enables drill-across + correlation + "find odd ones")
      // Only at month/quarter/year — daily/weekly cross cells are slow to build,
      // huge, and rarely the grain at which cross-dimensional patterns matter.
      if (g === "month" || g === "quarter" || g === "year") {
        for (const [colA, colB, combo] of crossPairs) {
          const va = row[colA], vb = row[colB];
          if (va === "" || va == null || vb === "" || vb == null) continue;
          const key = `${va}\u241F${vb}`;
          if (!cube.cells[g][combo]) cube.cells[g][combo] = {};
          if (!cube.cells[g][combo][pk]) cube.cells[g][combo][pk] = {};
          if (!cube.cells[g][combo][pk][key]) cube.cells[g][combo][pk][key] = {};
          for (const mc in mvals) bump(cube.cells[g][combo][pk][key], mc, mvals[mc]);
        }
      }
    }
  }

  cube.meta = {
    dims: cubeDims, measures, timeCol,
    excludedDims: prof.excludedDims,
    crossPairs: cube.crossPairs,
    cellCount: countCells(cube),
  };
  return cube;
}

function countCells(cube) {
  let n = 0;
  for (const g of TIME_GRAINS) {
    n += Object.keys(cube.totals[g] || {}).length;
    for (const combo in cube.cells[g]) {
      for (const pk in cube.cells[g][combo]) {
        n += Object.keys(cube.cells[g][combo][pk]).length;
      }
    }
  }
  return n;
}

/* ─── QUERY API (O(1) lookups over the cube) ──────────────────────────────── */
function latestPeriod(cube, grain) {
  const keys = Object.keys(cube.totals[grain] || {});
  return keys.length ? keys.sort().at(-1) : null;
}
function allPeriods(cube, grain) {
  return Object.keys(cube.totals[grain] || {}).sort();
}

export function queryBreakdown(cube, dim, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return [];
  const bucket = cube.cells[grain]?.[dim]?.[pk] || {};
  const rateLike = isRateMeasure(cube, measure);
  const out = Object.entries(bucket).map(([label, cell]) => {
    const c = cell[measure];
    const value = c ? (rateLike ? c.sum / (c.count||1) : c.sum) : 0;
    return { label, value };
  }).sort((a,b) => b.value - a.value);
  return out;
}

export function queryTrend(cube, measure, grain, nPeriods=12, dim=null, dimValue=null) {
  const periods = allPeriods(cube, grain).slice(-nPeriods);
  const rateLike = isRateMeasure(cube, measure);
  return periods.map(pk => {
    let cell;
    if (dim && dimValue) cell = cube.cells[grain]?.[dim]?.[pk]?.[dimValue];
    else cell = cube.totals[grain]?.[pk];
    const c = cell?.[measure];
    const value = c ? (rateLike ? c.sum/(c.count||1) : c.sum) : 0;
    return { period: pk, value };
  });
}

export function queryTotal(cube, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return { value:0, delta:null, period:null };
  const rateLike = isRateMeasure(cube, measure);
  const c = cube.totals[grain]?.[pk]?.[measure];
  const value = c ? (rateLike ? c.sum/(c.count||1) : c.sum) : 0;
  const periods = allPeriods(cube, grain);
  const idx = periods.indexOf(pk);
  let delta = null;
  if (idx > 0) {
    const pc = cube.totals[grain]?.[periods[idx-1]]?.[measure];
    const pv = pc ? (rateLike ? pc.sum/(pc.count||1) : pc.sum) : 0;
    delta = pv ? (value - pv)/pv : null;
  }
  return { value, delta, period: pk };
}

export function queryTopK(cube, dim, measure, grain, k=5, period) {
  return queryBreakdown(cube, dim, measure, grain, period).slice(0, k);
}

export function queryDelta(cube, dim, dimValue, measure, grain) {
  const periods = allPeriods(cube, grain);
  if (periods.length < 2) return null;
  const rateLike = isRateMeasure(cube, measure);
  const get = (pk) => {
    const c = cube.cells[grain]?.[dim]?.[pk]?.[dimValue]?.[measure];
    return c ? (rateLike ? c.sum/(c.count||1) : c.sum) : 0;
  };
  const cur = get(periods.at(-1)), prev = get(periods.at(-2));
  return prev ? (cur - prev)/prev : null;
}

/* rate-like measures are averaged, not summed (margin %, ratings, delivery time) */
function isRateMeasure(cube, measure) {
  const name = measure.toLowerCase();
  if (/(pct|percent|rate|ratio|margin|rating|score|avg|mean|min$|_min|time)/.test(name)) return true;
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
   CROSS-DIMENSIONAL + CORRELATION + DRILL LATTICE
   These power drill-across, "find the odd ones", and the multi-agent system.
   ══════════════════════════════════════════════════════════════════════════ */

const SEP = "\u241F"; // unit separator used to join two dim values

/* Get the value of a measure for a specific cross cell (dimA=valA, dimB=valB). */
export function queryCrossCell(cube, dimA, dimB, valA, valB, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return 0;
  // cross combos are stored sorted by original insertion order colA|colB
  const combo = cube.crossPairs?.find(c => {
    const [a,b] = c.split("|");
    return (a===dimA && b===dimB) || (a===dimB && b===dimA);
  });
  if (!combo) return 0;
  const [firstCol] = combo.split("|");
  const key = firstCol === dimA ? `${valA}${SEP}${valB}` : `${valB}${SEP}${valA}`;
  const c = cube.cells[grain]?.[combo]?.[pk]?.[key]?.[measure];
  const rateLike = isRateMeasure(cube, measure);
  return c ? (rateLike ? c.sum/(c.count||1) : c.sum) : 0;
}

/* Full 2-way breakdown: returns [{a, b, value}] for a cross pair in a period. */
export function queryCrossBreakdown(cube, dimA, dimB, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return [];
  const combo = cube.crossPairs?.find(c => {
    const [a,b] = c.split("|");
    return (a===dimA && b===dimB) || (a===dimB && b===dimA);
  });
  if (!combo) return [];
  const [firstCol] = combo.split("|");
  const bucket = cube.cells[grain]?.[combo]?.[pk] || {};
  const rateLike = isRateMeasure(cube, measure);
  const flip = firstCol !== dimA;
  return Object.entries(bucket).map(([key, cell]) => {
    const [v1, v2] = key.split(SEP);
    const c = cell[measure];
    const value = c ? (rateLike ? c.sum/(c.count||1) : c.sum) : 0;
    return { a: flip ? v2 : v1, b: flip ? v1 : v2, value };
  }).sort((x,y)=>y.value-x.value);
}

/* CORRELATION between two measures across a dimension's values (Pearson).
   e.g. do discount and revenue move together across regions? */
export function correlate(cube, measureX, measureY, dim, grain, period) {
  const bx = queryBreakdown(cube, dim, measureX, grain, period);
  const by = queryBreakdown(cube, dim, measureY, grain, period);
  const map = {};
  bx.forEach(r => { map[r.label] = { x: r.value }; });
  by.forEach(r => { if (map[r.label]) map[r.label].y = r.value; });
  const pts = Object.values(map).filter(p => p.x != null && p.y != null);
  if (pts.length < 3) return { r: null, n: pts.length };
  const n = pts.length;
  const sx = pts.reduce((a,p)=>a+p.x,0), sy = pts.reduce((a,p)=>a+p.y,0);
  const mx = sx/n, my = sy/n;
  let num=0, dx=0, dy=0;
  pts.forEach(p => { const a=p.x-mx, b=p.y-my; num+=a*b; dx+=a*a; dy+=b*b; });
  const r = (dx && dy) ? num/Math.sqrt(dx*dy) : null;
  return { r, n };
}

/* "FIND THE ODD ONES" — anomaly localization via z-score against siblings.
   For a dimension + measure at a period, flag values whose deviation from the
   sibling mean exceeds `zThreshold` standard deviations. This is the core of
   drill-based outlier detection. */
export function findOutliers(cube, dim, measure, grain, period, zThreshold=1.5) {
  const bd = queryBreakdown(cube, dim, measure, grain, period);
  if (bd.length < 3) return { outliers: [], mean: null, std: null };
  const vals = bd.map(b=>b.value);
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  const std = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length);
  const outliers = bd.map(b => ({
    label: b.label, value: b.value,
    z: std ? (b.value-mean)/std : 0,
  })).filter(o => Math.abs(o.z) >= zThreshold)
     .sort((a,b)=>Math.abs(b.z)-Math.abs(a.z));
  return { outliers, mean, std };
}

/* DRILL LATTICE — for a measure, walk from single dim into 2-way cross to find
   WHERE an anomaly localizes. Returns the drill path with the oddest child at
   each level. This is the "insight sequence" — drill-down + drill-across. */
export function drillLocalize(cube, measure, grain, period, opts={}) {
  const pk = period || latestPeriod(cube, grain);
  const dims = cube.meta.dims.map(d=>d.col);
  const zThreshold = opts.zThreshold ?? 1.5;
  const path = [];

  // Level 1: which single dimension has the strongest outlier?
  let best = null;
  for (const dim of dims) {
    const { outliers, mean, std } = findOutliers(cube, dim, measure, grain, pk, zThreshold);
    if (outliers.length && (!best || Math.abs(outliers[0].z) > Math.abs(best.top.z))) {
      best = { dim, top: outliers[0], mean, std, all: outliers };
    }
  }
  if (!best) return { path: [], localized: null };
  path.push({
    level: 1, dim: best.dim, value: best.top.label,
    z: best.top.z, value_num: best.top.value, siblingMean: best.mean,
  });

  // Level 2: within that outlier value, drill ACROSS other dims to localize further
  let bestPair = null;
  for (const dimB of dims) {
    if (dimB === best.dim) continue;
    const combo = cube.crossPairs?.find(c => {
      const [a,b]=c.split("|");
      return (a===best.dim&&b===dimB)||(a===dimB&&b===best.dim);
    });
    if (!combo) continue;
    // Get the sub-breakdown: fix best.dim=best.top.label, vary dimB
    const cross = queryCrossBreakdown(cube, best.dim, dimB, measure, grain, pk)
      .filter(r => r.a === best.top.label);
    if (cross.length < 3) continue;
    const vals = cross.map(c=>c.value);
    const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
    const std = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length);
    const scored = cross.map(c=>({ label:c.b, value:c.value, z: std?(c.value-mean)/std:0 }))
      .sort((a,b)=>Math.abs(b.z)-Math.abs(a.z));
    if (scored.length && (!bestPair || Math.abs(scored[0].z) > Math.abs(bestPair.top.z))) {
      bestPair = { dimB, top: scored[0], mean };
    }
  }
  if (bestPair && Math.abs(bestPair.top.z) >= zThreshold) {
    path.push({
      level: 2, dim: bestPair.dimB, value: bestPair.top.label,
      z: bestPair.top.z, value_num: bestPair.top.value, siblingMean: bestPair.mean,
      parent: `${best.dim}=${best.top.label}`,
    });
  }

  const localized = path.length > 1
    ? `${path[0].dim}=${path[0].value} → ${path[1].dim}=${path[1].value}`
    : `${path[0].dim}=${path[0].value}`;
  return { path, localized };
}

/* ══════════════════════════════════════════════════════════════════════════
   CUBE TRAVERSAL + INTERESTINGNESS SCORING
   ──────────────────────────────────────────────────────────────────────────
   THE core of the product. One function walks the ENTIRE pre-computed cube —
   every measure × every dimension value × every cross-cell × the latest period
   — and scores each cell for how "interesting" (surprising) it is, combining
   three independent signals:

     1. TEMPORAL  — how far this cell's latest value deviates from its own trend
     2. SIBLING   — how far it deviates from its peers in the same dimension (z)
     3. CROSS      — how far a cross-cell deviates from what its parents predict

   Every insight the app shows — auto-discovery feed AND the query agents —
   comes from this single scored traversal. No templated reports.
   ══════════════════════════════════════════════════════════════════════════ */

// Signal 1: temporal deviation — latest value vs its own recent trajectory
function temporalScore(cube, dim, value, measure, grain) {
  const tr = queryTrend(cube, measure, grain, 12, dim, value);
  if (tr.length < 4) return { z: 0, drop: 0, latest: tr.at(-1)?.value ?? 0 };
  const hist = tr.slice(0, -1).map(t => t.value);
  const mean = hist.reduce((a,b)=>a+b,0)/hist.length;
  const std  = Math.sqrt(hist.reduce((a,b)=>a+(b-mean)**2,0)/hist.length);
  const latest = tr.at(-1).value;
  const prev = tr.at(-2).value;
  const drop = prev ? (latest - prev)/prev : 0;
  return { z: std ? (latest - mean)/std : 0, drop, latest };
}

// Signal 3: cross-cell surprise — does dimA=a × dimB=b deviate from the product
// of their marginal shares? Only valid for ADDITIVE measures (sum), because the
// independence expectation assumes values add up. Rate measures (margin %, ratings)
// are averaged and must NOT use this signal.
function crossSurprise(cube, dimA, dimB, measure, grain, period) {
  if (isRateMeasure(cube, measure)) return [];   // additive-only signal
  const cross = queryCrossBreakdown(cube, dimA, dimB, measure, grain, period);
  if (cross.length < 4) return [];
  const bdA = {}; queryBreakdown(cube, dimA, measure, grain, period).forEach(r=>bdA[r.label]=r.value);
  const bdB = {}; queryBreakdown(cube, dimB, measure, grain, period).forEach(r=>bdB[r.label]=r.value);
  const total = Object.values(bdA).reduce((a,b)=>a+b,0) || 1;
  const surprises = [];
  for (const c of cross) {
    const expected = (bdA[c.a]||0) * (bdB[c.b]||0) / total;
    if (expected <= 0) continue;
    const ratio = c.value / expected;
    const lift = Math.abs(Math.log2(ratio));
    // Guard against tiny-cell noise: require the cell to be a meaningful share
    if (c.value < total * 0.005) continue;
    surprises.push({ a:c.a, b:c.b, value:c.value, expected, ratio, lift });
  }
  return surprises.sort((x,y)=>y.lift-x.lift);
}

/* MAIN TRAVERSAL — scan the whole cube, score every cell, return ranked insights.
   Returns a flat list of scored insight objects, highest interestingness first. */
export function discoverInsights(cube, opts={}) {
  const grain = opts.grain && Object.keys(cube.totals?.[opts.grain]||{}).length>=2
    ? opts.grain
    : (["month","quarter","year"].find(g=>Object.keys(cube.totals?.[g]||{}).length>=3) || "month");
  const period = opts.period || latestPeriod(cube, grain);
  const measures = cube.meta.measures.map(m=>m.col);
  const dims = cube.meta.dims.map(d=>d.col);
  const insights = [];

  for (const measure of measures) {
    // ── Single-dimension cells: sibling + temporal signals ──
    for (const dim of dims) {
      const bd = queryBreakdown(cube, dim, measure, grain, period);
      if (bd.length < 3) continue;
      const vals = bd.map(b=>b.value);
      const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
      const std  = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length);
      for (const cell of bd) {
        const sibZ = std ? (cell.value - mean)/std : 0;
        const temp = temporalScore(cube, dim, cell.label, measure, grain);
        // Combined interestingness: sibling deviation + temporal deviation + drop magnitude
        const score = Math.abs(sibZ)*1.0 + Math.abs(temp.z)*0.8 + Math.abs(temp.drop)*3.0;
        if (score < 1.0) continue;   // skip the boring
        insights.push({
          kind: "cell",
          measure, dim, value: cell.label, grain, period,
          val: cell.value,
          sibZ, tempZ: temp.z, drop: temp.drop,
          score,
          why: buildWhy(measure, dim, cell.label, sibZ, temp),
        });
      }
    }

    // ── Cross-cells: interaction surprise ──
    for (let i=0;i<dims.length;i++){
      for (let j=i+1;j<dims.length;j++){
        const surprises = crossSurprise(cube, dims[i], dims[j], measure, grain, period);
        for (const s of surprises.slice(0,3)) {
          if (s.lift < 0.6) continue;   // ~1.5x over/under-representation
          insights.push({
            kind: "cross",
            measure, dimA:dims[i], dimB:dims[j], a:s.a, b:s.b, grain, period,
            val: s.value, expected: s.expected, ratio: s.ratio,
            score: s.lift * 2.2,
            why: `${dims[i]}=${s.a} × ${dims[j]}=${s.b} is ${s.ratio>1?"over":"under"}-represented on ${measure} ` +
                 `(${s.ratio.toFixed(1)}× vs expected if independent).`,
          });
        }
      }
    }
  }

  insights.sort((a,b)=>b.score-a.score);
  return { grain, period, insights };
}

function buildWhy(measure, dim, value, sibZ, temp) {
  const parts = [];
  if (Math.abs(sibZ) >= 1.2)
    parts.push(`sits ${Math.abs(sibZ).toFixed(1)}σ ${sibZ>0?"above":"below"} its ${dim} peers`);
  if (Math.abs(temp.drop) >= 0.15)
    parts.push(`moved ${(temp.drop*100).toFixed(0)}% vs the prior period`);
  if (Math.abs(temp.z) >= 1.2)
    parts.push(`is ${Math.abs(temp.z).toFixed(1)}σ off its own trend`);
  const body = parts.length ? parts.join(", ") : "shows mild deviation";
  return `${dim}=${value} ${body} on ${measure}.`;
}

/* Classify an insight into the taxonomy (temporal/behavioral/causal/spatial). */
export function classifyInsight(ins) {
  const spatialRe = /(region|city|state|country|geo|location|zone|area|territory|district)/i;
  if (ins.kind === "cross") return "causal";
  if (ins.dim && spatialRe.test(ins.dim)) return "spatial";
  if (Math.abs(ins.drop||0) >= 0.15 || Math.abs(ins.tempZ||0) >= 1.2) return "temporal";
  return "behavioral";
}

/* PROFILE ONE DIMENSION EXHAUSTIVELY.
   For a measure × dimension, walk EVERY distinct value inside that dimension and
   compute its true deviation. Within a single dimension the members are directly
   comparable, so the sibling z-score is statistically clean (unlike comparing
   z-scores across different dimensions). This is the deep-dive primitive. */
export function profileDimension(cube, dim, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  const bd = queryBreakdown(cube, dim, measure, grain, pk);
  if (!bd.length) return { members: [], mean: null, std: null, total: 0, dim, measure, grain, period: pk };

  const vals  = bd.map(b => b.value);
  const total = vals.reduce((a,b)=>a+b,0);
  const mean  = total / vals.length;
  const std   = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length);

  const members = bd.map((b, i) => {
    const temp = temporalScore(cube, dim, b.label, measure, grain);
    const sibZ = std ? (b.value - mean)/std : 0;
    return {
      label: b.label,
      value: b.value,
      share: total ? b.value/total : 0,
      sibZ,
      tempZ: temp.z,
      drop:  temp.drop,
      rankByValue: i + 1,
      deviation: Math.abs(sibZ) + Math.abs(temp.z)*0.8 + Math.abs(temp.drop)*3,
    };
  });

  return { members, mean, std, total, dim, measure, grain, period: pk };
}

/* Correct headline number for a card: SUM for additive measures, AVERAGE for
   rate measures (margin %, ratings, durations). Uses the cube's own totals
   bucket, which stores true sum and count. */
export function cardKpi(cube, measure, grain, period) {
  const r = queryTotal(cube, measure, grain, period);
  return r ? r.value : null;
}

/* Flag correlations that are almost certainly arithmetic, not insight —
   e.g. discount derived as a % of revenue will correlate at ~1.00. */
export function isLikelyDerived(r) {
  return r != null && Math.abs(r) >= 0.985;
}

export { latestPeriod, allPeriods, isRateMeasure };
