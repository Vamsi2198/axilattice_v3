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
    }
  }

  cube.meta = {
    dims: cubeDims, measures, timeCol,
    excludedDims: prof.excludedDims,
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
function measureAgg(cell, measure) {
  // returns the value for a measure — sum for additive, mean for rate-like
  const c = cell?.[measure];
  if (!c) return 0;
  // heuristic: margin/rate/pct/rating/min → mean; else sum
  return c.sum; // default sum; rate handling done by caller via cube.meta
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

export { latestPeriod, allPeriods, isRateMeasure };
