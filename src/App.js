import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  parseCSV, profile, buildCube,
  queryBreakdown, queryTrend, queryTotal, queryTopK, queryDelta,
  latestPeriod, findOutliers, drillLocalize, correlate,
} from "./engine";

/* ════════════════════════════════════════════════════════════════════════
   AXILATTICE — Insight Engine + Agent Router
   Real in-browser cube (engine.js). Upload any CSV → profile → build cube →
   O(1) query. No backend required. Deployable as a static site.
   ════════════════════════════════════════════════════════════════════════ */

// ─── DESIGN TOKENS ──────────────────────────────────────────────────────────
const T = {
  bg0:"#06070a", bg1:"#0c0e14", bg2:"#11141d", bg3:"#161a25",
  border:"#1c2133", borderHi:"#28304a",
  amber:"#f59e0b", amberDim:"#78490a", amberGlow:"#f59e0b22",
  blue:"#3b82f6", green:"#10b981", red:"#ef4444",
  purple:"#8b5cf6", cyan:"#06b6d4", pink:"#ec4899",
  text:"#e2e8f0", textMid:"#8892a4", textDim:"#3d4a60", textFaint:"#1e2535",
  mono:"'IBM Plex Mono', monospace", sans:"'Syne', sans-serif",
};
const PALETTE = [T.amber, T.blue, T.green, T.purple, T.cyan, T.pink, "#f97316", "#a3e635"];

// ─── FORMATTERS ──────────────────────────────────────────────────────────────
function fmtKpi(v) {
  if (v == null || isNaN(v)) return "—";
  if (Math.abs(v) >= 1e6) return `${(v/1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v/1e3).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/* Responsive breakpoint hook — drives mobile vs desktop layout */
function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

/* ════════════════════════════════════════════════════════════════════════
   NLU — intent parser (rule-based; swap for Claude API later)
   Now schema-aware: uses the ACTUAL dims/measures from the uploaded file.
   ════════════════════════════════════════════════════════════════════════ */
function parseIntent(text, schema) {
  const q = text.toLowerCase();
  const dims     = schema.dims.map(d => d.col);
  const measures = schema.measures.map(m => m.col);

  // measure — match by name or common synonyms
  let measure = measures[0];
  for (const m of measures) {
    const mn = m.toLowerCase();
    if (q.includes(mn) || q.includes(mn.replace(/_/g," "))) { measure = m; break; }
  }
  if (/\b(sales|gmv|revenue|top ?line)\b/.test(q)) {
    const rev = measures.find(m => /revenue|sales|gmv|value|amount/i.test(m));
    if (rev) measure = rev;
  }

  // dimension — match by name
  let dimension = null;
  for (const d of dims) {
    const dn = d.toLowerCase();
    if (q.includes(dn) || q.includes(dn.replace(/_/g," "))) { dimension = d; break; }
  }

  // grain
  let grain = "month";
  if (/\bdai|day\b/.test(q)) grain = "day";
  else if (/week/.test(q)) grain = "week";
  else if (/quarter|qoq/.test(q)) grain = "quarter";
  else if (/year|annual|yoy/.test(q)) grain = "year";

  // insight type + agent selection
  let insight_type = "breakdown";
  let agent = null;

  // Agent triggers (each maps to one of the 4 agents)
  if (/\b(scan|survey|overview|what.?s notable|anything interesting|what stands out|explore)\b/.test(q)) {
    insight_type = "agent"; agent = "scan";
  } else if (/\b(deep ?dive|analyze|break down .* across|all grains|across time|full analysis)\b/.test(q)) {
    insight_type = "agent"; agent = "deepdive";
  } else if (/\b(correlat|relationship|move together|linked|odd one|outlier|find the odd)\b/.test(q)) {
    insight_type = "agent"; agent = "correlate";
  } else if (/\b(why|explain|reason|cause|diagnos|root|drop|decline|fell|worse|spike|anomal|drill|localize|where)\b/.test(q)) {
    insight_type = "agent"; agent = "drill";
  } else if (/trend|over time|trajectory|history/.test(q)) {
    insight_type = "trend";
  } else if (/\btop|best|rank|highest|lowest|worst\b/.test(q)) {
    insight_type = "topk";
  } else if (/total|overall|sum|grand/.test(q)) {
    insight_type = "total";
  } else if (!dimension) {
    insight_type = "trend";
  }

  let k = 5; const km = q.match(/top\s+(\d+)/); if (km) k = +km[1];

  // Agents that need a dimension default to the first
  if (agent && ["drill","deepdive"].includes(agent) && !dimension) dimension = dims[0];

  const title = text.length > 52 ? text.slice(0,50)+"…" : text;
  return { insight_type, agent, measure, dimension, grain, k, title };
}

/* ════════════════════════════════════════════════════════════════════════
   AGENT ROUTER
   ════════════════════════════════════════════════════════════════════════ */
function routeQuery(intent) {
  return intent.insight_type === "agent" ? "agent" : "fast";
}

// FAST PATH — one cube lookup → card
function fastPathCard(cube, intent) {
  const { insight_type, measure, dimension, grain, k } = intent;
  const selPeriod = intent.period || null;   // user-selected period, if any
  let chart_data = [], kpi = null, delta = null, chart_type = "bar", period = selPeriod || latestPeriod(cube, grain);
  const nPeriods = { day:30, week:16, month:12, quarter:8, year:5 }[grain] || 12;

  if (insight_type === "trend" || (!dimension && insight_type !== "total")) {
    chart_data = queryTrend(cube, measure, grain, nPeriods);
    chart_type = "area";
    kpi = chart_data.at(-1)?.value;
    const prev = chart_data.at(-2)?.value;
    delta = prev ? (kpi - prev)/prev : null;
  } else if (insight_type === "total") {
    const r = queryTotal(cube, measure, grain, selPeriod);
    kpi = r.value; delta = r.delta; period = r.period;
    chart_data = queryTrend(cube, measure, grain, nPeriods); chart_type = "area";
  } else if (insight_type === "topk") {
    chart_data = queryTopK(cube, dimension, measure, grain, k, selPeriod);
    chart_type = "bar"; kpi = chart_data[0]?.value;
    delta = queryDelta(cube, dimension, chart_data[0]?.label, measure, grain);
  } else { // breakdown
    chart_data = queryBreakdown(cube, dimension, measure, grain, selPeriod);
    chart_type = chart_data.length <= 5 ? "pie" : "bar";
    kpi = chart_data.reduce((s,d)=>s+d.value, 0);
    delta = queryDelta(cube, dimension, chart_data[0]?.label, measure, grain);
  }

  return {
    id: Math.random().toString(36).slice(2,8),
    title: intent.title, insight_type, measure, dimension, grain,
    chart_type, chart_data, kpi, delta, period,
    summary: makeSummary(insight_type, measure, chart_data, kpi, delta, grain),
    via: "fast",
  };
}

function makeSummary(itype, measure, data, kpi, delta, grain) {
  const dstr = delta != null ? ` (${delta>0?"up":"down"} ${Math.abs(delta*100).toFixed(1)}% vs prior ${grain})` : "";
  if (itype === "trend" && data.length) {
    const f = data[0].value || 1, l = data.at(-1).value, chg = (l-f)/f*100;
    return `${measure} ${chg>=0?"grew":"declined"} ${Math.abs(chg).toFixed(1)}% over the period. Latest: ${fmtKpi(l)}${dstr}.`;
  }
  if (itype === "total") return `Total ${measure}: ${fmtKpi(kpi)}${dstr}.`;
  if (itype === "topk" && data.length) return `#1 is ${data[0].label} at ${fmtKpi(data[0].value)}${dstr}.`;
  if (data.length) {
    const top = data[0], tot = data.reduce((s,d)=>s+d.value,0), pct = tot?(top.value/tot*100):0;
    const tail = data.length>1 ? ` ${data.at(-1).label} is lowest at ${fmtKpi(data.at(-1).value)}.` : "";
    return `${top.label} leads with ${fmtKpi(top.value)} (${pct.toFixed(0)}% of total).${tail}`;
  }
  return `${measure} insight computed.`;
}

// AGENT — OODA loop over the real cube
/* ════════════════════════════════════════════════════════════════════════
   MULTI-AGENT SYSTEM
   Four distinct agents, each with a different job, plus an insight taxonomy.
   All reasoning is deterministic math over the cube (fast, in-browser, free).
   ────────────────────────────────────────────────────────────────────────
   AGENTS:
     scan      → (a) survey ALL dims × measures, surface what's notable
     deepdive  → (b) one selected dim + measure, across ALL time grains
     drill     → (c) narrow single-dim → multi-dim for a measure over time
                     (drill-down + drill-across; "the insight sequence")
     correlate → (d) find measures/dims that move together + the odd ones
   ════════════════════════════════════════════════════════════════════════ */

const INSIGHT_TYPES = {
  temporal:   { label:"Temporal",   supported:true,  desc:"trends, seasonality, growth over time" },
  behavioral: { label:"Behavioral", supported:true,  desc:"how segments/dimensions differ in behavior" },
  causal:     { label:"Causal",     supported:true,  desc:"drill-down root cause, what drives a shift" },
  spatial:    { label:"Spatial",    supported:true,  desc:"geographic / regional distribution" },
  network:    { label:"Network",    supported:false, desc:"relationships between entities — needs graph/edge data" },
  sentiment:  { label:"Sentiment",  supported:false, desc:"opinion/emotion — needs text or review data" },
  industry:   { label:"Industry",   supported:false, desc:"benchmarking vs peers — needs external market data" },
};

// Detect if a dimension is spatial (used to tag spatial insights)
// eslint-disable-next-line no-unused-vars
function isSpatialDim(name) {
  return /(region|city|state|country|geo|location|zone|area|territory|district)/i.test(name);
}

async function stepper(onStep) {
  const trace = [];
  return async (phase, label, detail) => {
    trace.push({ phase, label, detail });
    onStep([...trace]);
    await new Promise(r => setTimeout(r, 550));
    return trace;
  };
}

const newId = () => Math.random().toString(36).slice(2,8);

/* Pick a working grain: prefer the requested one, but fall back to whatever the
   cube actually has periods for. Prevents agents from assuming "month" exists. */
function resolveGrain(cube, requested) {
  const order = ["month","quarter","year","week","day"];
  const has = (g) => Object.keys(cube.totals?.[g] || {}).length >= 2;
  if (requested && has(requested)) return requested;
  for (const g of order) if (has(g)) return g;
  return requested || "month";
}
// How many periods to show for a given grain (adapts lookback to grain)
function lookbackFor(grain) {
  return { day:30, week:16, month:12, quarter:8, year:5 }[grain] || 12;
}

/* ── AGENT (a): SCAN — survey everything, surface the top 3 notable ───────── */
async function agentScan(cube, intent, onStep) {
  const step = await stepper(onStep);
  const measure = intent.measure;
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || null;   // null → latest inside engine
  const dims = cube.meta.dims.map(d=>d.col);
  let trace;

  await step("OBSERVE", "Survey all dimensions",
    `Scanning ${dims.length} dimensions against ${measure} at ${grain} grain to find where variation concentrates.`);

  // Collect ALL outliers across all dimensions, then take the global top 3
  const all = [];
  for (const dim of dims) {
    const { outliers, mean } = findOutliers(cube, dim, measure, grain, period, 1.0);
    for (const o of outliers) all.push({ dim, ...o, siblingMean: mean });
  }
  all.sort((a,b)=>Math.abs(b.z)-Math.abs(a.z));
  const top3 = all.slice(0,3);

  await step("ORIENT", "Rank dimensions by anomaly strength",
    top3.length
      ? `Top signals: ${top3.map(f=>`${f.dim}=${f.label} (${f.z>0?"+":""}${f.z.toFixed(1)}σ)`).join(", ")}.`
      : `No dimension shows a strong outlier — ${measure} is evenly distributed.`);

  const top = top3[0];
  await step("DECIDE", "Select the standout",
    top ? `${top.dim}=${top.label} is the strongest of ${all.length} flagged cells.`
        : `Presenting the top-level trend as the headline.`);

  trace = await step("ACT", "Assemble overview + runner-ups",
    top ? `Headline plus two runner-ups assembled for comparison.`
        : `Overview assembled from total trend.`);

  const chart_data = top ? queryBreakdown(cube, top.dim, measure, grain, period) : queryTrend(cube, measure, grain, lookbackFor(grain));
  const summary = top
    ? `Overview (top 3): ` + top3.map((f,i)=>
        `${i+1}) ${f.dim}=${f.label} at ${fmtKpi(f.value)} (${Math.abs(f.z).toFixed(1)}σ ${f.z>0?"above":"below"} peers)`
      ).join("; ") + `. Strongest lead: ${top.dim}=${top.label}.`
    : `Overview: ${measure} is evenly spread across dimensions with no dominant outlier this period.`;

  return {
    id:newId(), title:intent.title, insight_type:"scan", insightClass:"behavioral",
    measure, dimension: top?.dim||null, grain, period,
    chart_type: top?"bar":"area", chart_data,
    kpi: top?top.value:queryTotal(cube,measure,grain,period).value,
    delta:null, period_key: period || latestPeriod(cube,grain),
    findings: top3,
    summary, via:"agent", agent:"scan", trace,
  };
}

/* ── AGENT (b): DEEP-DIVE — one dim+measure across all grains ─────────────── */
async function agentDeepDive(cube, intent, onStep) {
  const step = await stepper(onStep);
  const measure = intent.measure;
  const dim = intent.dimension || cube.meta.dims[0]?.col;
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || null;
  let trace;

  await step("OBSERVE", `Load ${dim} × ${measure}`,
    `Pulling ${measure} broken down by ${dim} at ${grain} grain as the base view.`);

  // Compare across whatever coarser grains the cube has
  const grainsToCheck = ["month","quarter","year"].filter(g => Object.keys(cube.totals?.[g]||{}).length >= 2);
  const grainViews = {};
  for (const g of grainsToCheck) grainViews[g] = queryBreakdown(cube, dim, measure, g);

  await step("ORIENT", "Compare across time grains",
    `Computed ${dim} breakdown at ${grainsToCheck.join(", ")} to test whether the ranking holds across horizons.`);

  // Rank stability of the leader across grains
  const leaders = Object.entries(grainViews).map(([g,bd])=>({g, leader:bd[0]?.label}));
  const stable = leaders.length>1 && leaders.every(l=>l.leader===leaders[0].leader);
  await step("DECIDE", "Assess consistency",
    stable ? `${leaders[0].leader} leads ${measure} at every grain — a durable pattern.`
           : `The ${measure} leader shifts across grains — horizon-dependent.`);

  trace = await step("ACT", "Build deep-dive (top 3)",
    `Surfacing the ${grain}-grain breakdown with the top 3 values and the cross-grain note.`);

  const bd = queryBreakdown(cube, dim, measure, grain, period);
  const tot = bd.reduce((s,d)=>s+d.value,0);
  const top3 = bd.slice(0,3);
  const summary = bd.length
    ? `Top 3 ${dim} by ${measure}: ` + top3.map((r,i)=>
        `${i+1}) ${r.label} ${fmtKpi(r.value)} (${tot?((r.value/tot)*100).toFixed(0):0}%)`
      ).join(", ") + `. ${stable?`Ranking holds across ${grainsToCheck.join("/")} — a stable structural pattern.`:`Note: leader shifts at coarser grains, so this is horizon-sensitive.`}`
    : `No ${measure} data for ${dim}.`;

  return {
    id:newId(), title:intent.title, insight_type:"deepdive", insightClass:"behavioral",
    measure, dimension:dim, grain, period,
    chart_type: bd.length<=5?"pie":"bar", chart_data:bd,
    kpi: tot, delta:null, period_key: period || latestPeriod(cube,grain),
    findings: top3,
    summary, via:"agent", agent:"deepdive", trace,
  };
}

/* ── AGENT (c): DRILL — single-dim → multi-dim localization ───────────────── */
async function agentDrill(cube, intent, onStep) {
  const step = await stepper(onStep);
  const measure = intent.measure;
  const grain = resolveGrain(cube, intent.grain);
  let trace;

  const totalTrend = queryTrend(cube, measure, grain, lookbackFor(grain));
  // If user pinned a period, probe that; else find the biggest total move
  let probe = intent.period, worstDrop = 0;
  if (!probe) {
    for (let i=1;i<totalTrend.length;i++){
      const d = totalTrend[i-1].value ? (totalTrend[i].value-totalTrend[i-1].value)/totalTrend[i-1].value : 0;
      if (d < worstDrop){ worstDrop=d; probe=totalTrend[i].period; }
    }
    probe = probe || latestPeriod(cube,grain);
  }

  await step("OBSERVE", `Locate the inflection in ${measure}`,
    intent.period ? `Investigating the selected period ${probe}.`
      : worstDrop ? `Biggest total move is at ${probe} (${(worstDrop*100).toFixed(1)}%). Investigating that period.`
                  : `No sharp total move; examining ${probe}.`);

  await step("ORIENT", "Drill down — test each dimension",
    `Running outlier detection across every dimension at ${probe} to find where the movement concentrates.`);

  const drill = drillLocalize(cube, measure, grain, probe, { zThreshold:1.0 });

  await step("DECIDE", "Drill across — narrow within the outlier",
    drill.path.length>1
      ? `${drill.path[0].dim}=${drill.path[0].value} is the primary driver. Drilling across into ${drill.path[1].dim} to localize further.`
      : drill.path.length
        ? `${drill.path[0].dim}=${drill.path[0].value} is the driver; no secondary dimension sharpens it.`
        : `Movement is distributed — no single cell dominates.`);

  trace = await step("ACT", "Confirm the localized cell",
    drill.localized ? `Localized to: ${drill.localized}.` : `Could not localize to one cell — the effect is broad.`);

  const focusDim = drill.path[0]?.dim, focusVal = drill.path[0]?.value;
  const chart_data = focusDim ? queryTrend(cube, measure, grain, lookbackFor(grain), focusDim, focusVal) : totalTrend;

  const summary = drill.path.length
    ? `Drill sequence: ${measure} movement at ${probe} localizes to ${drill.localized}. ` +
      `${drill.path.length>1 ? `Single-dimension (${drill.path[0].dim}=${drill.path[0].value}) narrows further crossed with ${drill.path[1].dim}=${drill.path[1].value} — that intersection is the tightest explanation.` : `This dimension alone explains the shift.`}`
    : `${measure} moved at ${probe} but the cause is distributed across cells.`;

  return {
    id:newId(), title:intent.title, insight_type:"drill", insightClass:"causal",
    measure, dimension:focusDim, grain, period:intent.period||null,
    chart_type:"area", chart_data,
    kpi: chart_data.at(-1)?.value, delta: worstDrop || null,
    period_key: probe, drillPath: drill.path, localized: drill.localized,
    summary, via:"agent", agent:"drill", trace,
  };
}

/* ── AGENT (d): CORRELATE — find measures that move together + odd ones ───── */
async function agentCorrelate(cube, intent, onStep) {
  const step = await stepper(onStep);
  const measures = cube.meta.measures.map(m=>m.col);
  const dims = cube.meta.dims.map(d=>d.col);
  const anchor = intent.measure;
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || null;
  const dim = intent.dimension || dims[0];
  let trace;

  await step("OBSERVE", "Set up correlation matrix",
    `Testing how ${anchor} co-moves with other measures across ${dim} at ${grain} grain.`);

  const correlations = [];
  for (const m of measures) {
    if (m === anchor) continue;
    const { r, n } = correlate(cube, anchor, m, dim, grain, period);
    if (r != null) correlations.push({ measure:m, r, n });
  }
  correlations.sort((a,b)=>Math.abs(b.r)-Math.abs(a.r));
  const top3corr = correlations.slice(0,3);

  await step("ORIENT", "Rank by correlation strength (top 3)",
    top3corr.length
      ? top3corr.map(c=>`${anchor}↔${c.measure} r=${c.r.toFixed(2)}`).join(", ")
      : `Only one measure — no cross-measure correlation possible.`);

  const { outliers } = findOutliers(cube, dim, anchor, grain, period, 1.0);
  const top3odd = outliers.slice(0,3);
  await step("DECIDE", "Find the odd ones (top 3)",
    top3odd.length
      ? `Outliers breaking the pattern: ${top3odd.map(o=>`${o.label} (${o.z>0?"+":""}${o.z.toFixed(1)}σ)`).join(", ")}.`
      : `No ${dim} breaks the ${anchor} pattern — the relationship is uniform.`);

  trace = await step("ACT", "Assemble correlation insight",
    `Pairing the top correlations with the flagged outliers.`);

  const top = top3corr[0];
  const chart_data = queryBreakdown(cube, dim, anchor, grain, period);
  const oddTxt = top3odd.length ? ` Odd ones out: ${top3odd.map(o=>`${o.label} (${Math.abs(o.z).toFixed(1)}σ)`).join(", ")}.` : "";
  const corrTxt = top
    ? `Top correlations with ${anchor}: ` + top3corr.map(c=>
        `${c.measure} (r=${c.r.toFixed(2)}, ${Math.abs(c.r)>0.7?"strong":Math.abs(c.r)>0.4?"moderate":"weak"})`
      ).join(", ") + `.`
    : `Only one measure available — no cross-measure correlation possible.`;

  return {
    id:newId(), title:intent.title, insight_type:"correlate", insightClass:"behavioral",
    measure:anchor, dimension:dim, grain, period,
    chart_type:"bar", chart_data,
    kpi: chart_data.reduce((s,d)=>s+d.value,0), delta:null,
    period_key: period || latestPeriod(cube,grain),
    correlations:top3corr, outliers:top3odd,
    summary: corrTxt + oddTxt, via:"agent", agent:"correlate", trace,
  };
}

// Dispatcher — routes an intent to the right agent
async function runAgent(cube, intent, onStep) {
  const which = intent.agent || "drill";
  if (which === "scan")      return agentScan(cube, intent, onStep);
  if (which === "deepdive")  return agentDeepDive(cube, intent, onStep);
  if (which === "correlate") return agentCorrelate(cube, intent, onStep);
  return agentDrill(cube, intent, onStep);   // default: drill (root-cause)
}


/* ════════════════════════════════════════════════════════════════════════
   CHART — mount-guarded container (THE display-bug fix)
   ResponsiveContainer returns 0×0 on first paint inside grid cells.
   We wait one frame + observe size before rendering the chart.
   ════════════════════════════════════════════════════════════════════════ */
function SafeChart({ height=120, children }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Defer one frame so the grid cell has a measured width
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={ref} style={{ height, width:"100%", margin:"0 -4px" }}>
      {ready ? (
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      ) : (
        <div style={{ height, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ width:16, height:16, border:`2px solid ${T.border}`, borderTopColor:T.amber,
            borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
        </div>
      )}
    </div>
  );
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  const s = typeof v==="number" && v>500 ? fmtKpi(v) : v?.toLocaleString?.() ?? v;
  return (
    <div style={{ background:T.bg3, border:`1px solid ${T.border}`, borderRadius:6, padding:"7px 11px",
      fontSize:11, fontFamily:T.mono, color:T.textMid }}>
      <div style={{ color:T.textDim, marginBottom:2 }}>{label}</div>
      <div style={{ color:payload[0]?.color||T.amber }}>{s}</div>
    </div>
  );
}

function renderChart(card) {
  const data = card.chart_data || [];
  if (!data.length) return null;
  const mColor = { revenue:T.amber, units:T.blue, margin:T.green }[card.measure] || T.amber;

  if (card.chart_type==="area") {
    return (
      <AreaChart data={data} margin={{ top:4, right:6, left:6, bottom:0 }}>
        <defs>
          <linearGradient id={`g${card.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor={mColor} stopOpacity={0.3}/>
            <stop offset="100%" stopColor={mColor} stopOpacity={0.02}/>
          </linearGradient>
        </defs>
        <XAxis dataKey="period" tick={{fontSize:8, fill:T.textDim}} axisLine={false} tickLine={false}
          tickFormatter={v=>v?.slice?.(-2)??v} interval="preserveStartEnd"/>
        <YAxis hide domain={["auto","auto"]}/>
        <Tooltip content={<ChartTip/>}/>
        <Area type="monotone" dataKey="value" stroke={mColor} strokeWidth={1.6}
          fill={`url(#g${card.id})`} dot={false} isAnimationActive={false}/>
      </AreaChart>
    );
  }
  if (card.chart_type==="pie") {
    return (
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" outerRadius={48} innerRadius={26}
          dataKey="value" nameKey="label" paddingAngle={2} isAnimationActive={false}>
          {data.map((_,i)=><Cell key={i} fill={PALETTE[i%PALETTE.length]}/>)}
        </Pie>
        <Tooltip content={<ChartTip/>}/>
      </PieChart>
    );
  }
  return (
    <BarChart data={data} barCategoryGap="28%" margin={{ top:4, right:6, left:6, bottom:0 }}>
      <XAxis dataKey="label" tick={{fontSize:8, fill:T.textDim}} axisLine={false} tickLine={false}
        tickFormatter={v=> v&&v.length>10 ? v.slice(0,9)+"…":v}/>
      <YAxis hide/>
      <Tooltip content={<ChartTip/>}/>
      <Bar dataKey="value" radius={[3,3,0,0]} isAnimationActive={false}>
        {data.map((_,i)=><Cell key={i} fill={PALETTE[i%PALETTE.length]} fillOpacity={0.85}/>)}
      </Bar>
    </BarChart>
  );
}

// ─── DELTA BADGE ─────────────────────────────────────────────────────────────
function Delta({ value }) {
  if (value==null) return null;
  const up=value>0, pct=(Math.abs(value)*100).toFixed(1);
  return (
    <span style={{ fontFamily:T.mono, fontSize:11, padding:"2px 8px", borderRadius:3, marginLeft:8,
      background: up?`${T.green}22`:`${T.red}22`, color: up?T.green:T.red }}>
      {up?"▲":"▼"} {pct}%
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   AGENT TRACE — visible OODA reasoning
   ════════════════════════════════════════════════════════════════════════ */
const PHASE_COLOR = { OBSERVE:T.cyan, ORIENT:T.blue, DECIDE:T.purple, ACT:T.amber };
function AgentTrace({ trace, live }) {
  if (!trace?.length) return null;
  return (
    <div style={{ background:T.bg1, border:`1px solid ${T.border}`, borderRadius:8, padding:14, marginBottom:16 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
        <span style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim, fontWeight:600 }}>
          Agent Reasoning · OODA Loop
        </span>
        {live && <span style={{ width:6, height:6, borderRadius:"50%", background:T.amber,
          animation:"pulse 1s infinite" }}/>}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {trace.map((s,i)=>(
          <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
            <span style={{ fontFamily:T.mono, fontSize:9, fontWeight:600, letterSpacing:"1px",
              color:PHASE_COLOR[s.phase]||T.amber, minWidth:58, paddingTop:1 }}>
              {s.phase}
            </span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, color:T.text, fontWeight:500 }}>{s.label}</div>
              <div style={{ fontSize:11, color:T.textMid, marginTop:2, lineHeight:1.5 }}>{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   INSIGHT CARD
   ════════════════════════════════════════════════════════════════════════ */
function InsightCard({ card, pinned, onPin, onSpeak }) {
  const isPinned = pinned.some(p=>p.id===card.id);
  const chart = useMemo(()=>renderChart(card), [card]);
  return (
    <div style={{ background:T.bg2, border:`1px solid ${isPinned?`${T.amber}50`:T.border}`,
      borderRadius:10, padding:18, display:"flex", flexDirection:"column", gap:12,
      transition:"border-color 0.2s" }}>
      {/* header */}
      <div style={{ display:"flex", justifyContent:"space-between", gap:8, alignItems:"flex-start" }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ fontSize:13, fontWeight:600, color:T.text, lineHeight:1.4 }}>{card.title}</div>
            {card.via==="agent" && (
              <span style={{ fontSize:8, fontFamily:T.mono, color:T.purple, background:`${T.purple}20`,
                border:`1px solid ${T.purple}40`, borderRadius:3, padding:"1px 5px", letterSpacing:"0.5px" }}>
                AGENT
              </span>
            )}
          </div>
          <div style={{ fontSize:9, color:T.textDim, marginTop:3, letterSpacing:"0.5px" }}>
            {card.grain?.toUpperCase()} · {card.dimension||"TOTAL"} · {card.measure?.toUpperCase()}
          </div>
        </div>
        <div style={{ display:"flex", gap:4 }}>
          <button onClick={()=>onPin(card)} title={isPinned?"Unpin":"Pin"}
            style={{ width:28, height:28, borderRadius:5, cursor:"pointer", fontSize:13,
              border:`1px solid ${isPinned?T.amber:T.border}`,
              background:isPinned?T.amber:"transparent", color:isPinned?T.bg0:T.textDim,
              display:"flex", alignItems:"center", justifyContent:"center" }}>
            {isPinned?"◉":"◎"}
          </button>
          <button onClick={()=>onSpeak(card.summary)} title="Read aloud"
            style={{ width:28, height:28, borderRadius:5, cursor:"pointer", fontSize:12,
              border:`1px solid ${T.border}`, background:"transparent", color:T.textDim,
              display:"flex", alignItems:"center", justifyContent:"center" }}>
            🔊
          </button>
        </div>
      </div>
      {/* kpi */}
      {card.kpi!=null && (
        <div style={{ display:"flex", alignItems:"baseline", gap:2 }}>
          <span style={{ fontFamily:T.mono, fontSize:26, fontWeight:500, color:T.text }}>{fmtKpi(card.kpi)}</span>
          <Delta value={card.delta}/>
        </div>
      )}
      {/* chart */}
      {chart && <SafeChart height={120}>{chart}</SafeChart>}
      {/* summary */}
      {card.summary && (
        <div style={{ fontSize:11, color:T.textMid, lineHeight:1.65, paddingTop:10,
          borderTop:`1px solid ${T.border}` }}>
          {card.summary}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   VOICE
   ════════════════════════════════════════════════════════════════════════ */
function useVoice({ onTranscript, onError }) {
  const recogRef = useRef(null);
  const [listening,setListening] = useState(false);
  const [interim,setInterim] = useState("");
  const start = useCallback(()=>{
    const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    if (!SR){ onError?.("Voice needs Chrome or Edge."); return; }
    const r = new SR(); r.continuous=false; r.interimResults=true; r.lang=navigator.language||"en-US";
    r.onresult=(e)=>{ let f="",it=""; for(const res of e.results){ if(res.isFinal)f+=res[0].transcript; else it+=res[0].transcript; }
      setInterim(it); if(f){ setInterim(""); onTranscript(f.trim()); } };
    r.onerror=(e)=>{ setListening(false); onError?.(e.error); };
    r.onend=()=>{ setListening(false); setInterim(""); };
    r.start(); recogRef.current=r; setListening(true);
  },[onTranscript,onError]);
  const stop = useCallback(()=>{ recogRef.current?.stop(); setListening(false); },[]);
  const speak = useCallback((text)=>{ if(!window.speechSynthesis||!text)return;
    window.speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(text.slice(0,300)); u.rate=1.1;
    window.speechSynthesis.speak(u); },[]);
  return { listening, interim, start, stop, speak };
}

/* ════════════════════════════════════════════════════════════════════════
   DASHBOARD PANEL
   ════════════════════════════════════════════════════════════════════════ */
const LAYOUTS = [
  {id:"grid",icon:"⊞",label:"Grid"},{id:"featured",icon:"◫",label:"Featured"},
  {id:"list",icon:"≡",label:"List"},{id:"split",icon:"◧",label:"Split"},
];
function DashboardPanel({ pinned, onUnpin }) {
  const [name,setName]=useState("My Dashboard");
  const [layout,setLayout]=useState("grid");
  const [saved,setSaved]=useState(false);
  const [url,setUrl]=useState("");
  const save=()=>{ const id=Math.random().toString(36).slice(2,10);
    setUrl(`${window.location.origin}/dashboard/${id}`); setSaved(true); };
  return (
    <aside style={{ width:240, flexShrink:0, background:T.bg1, borderLeft:`1px solid ${T.border}`,
      padding:"20px 16px", overflowY:"auto", display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim, fontWeight:600 }}>
        Dashboard · {pinned.length} pinned
      </div>
      <input value={name} onChange={e=>{setName(e.target.value); setSaved(false);}}
        placeholder="Dashboard name…"
        style={{ background:T.bg3, border:`1px solid ${T.border}`, borderRadius:5, padding:"7px 10px",
          color:T.text, fontFamily:T.sans, fontSize:12, outline:"none" }}/>
      {pinned.length===0 ? (
        <div style={{ fontSize:11, color:T.textFaint, textAlign:"center", padding:"20px 0", lineHeight:1.7 }}>
          Pin insight cards<br/>using ◎ to build<br/>your dashboard
        </div>
      ) : (
        <>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {pinned.map(p=>(
              <div key={p.id} style={{ background:T.bg3, border:`1px solid ${T.border}`, borderRadius:6, padding:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", gap:4, alignItems:"center" }}>
                  <div style={{ fontSize:11, color:T.textMid, fontWeight:500, flex:1, overflow:"hidden",
                    textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.title}</div>
                  <button onClick={()=>onUnpin(p.id)} style={{ width:18, height:18, borderRadius:4,
                    border:`1px solid ${T.border}`, background:"transparent", color:T.textDim, cursor:"pointer",
                    fontSize:10, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                </div>
                <div style={{ fontFamily:T.mono, fontSize:13, color:T.amber, marginTop:4 }}>
                  {fmtKpi(p.kpi)} <Delta value={p.delta}/>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim, fontWeight:600 }}>Layout</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5 }}>
            {LAYOUTS.map(l=>(
              <button key={l.id} onClick={()=>setLayout(l.id)}
                style={{ padding:"8px 4px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:T.sans,
                  border:`1px solid ${layout===l.id?`${T.amber}70`:T.border}`,
                  background:layout===l.id?T.amberGlow:"transparent",
                  color:layout===l.id?T.amber:T.textMid, textAlign:"center" }}>
                {l.icon} {l.label}
              </button>
            ))}
          </div>
          {saved && url ? (
            <div style={{ background:`${T.green}15`, border:`1px solid ${T.green}40`, borderRadius:6, padding:10 }}>
              <div style={{ fontSize:10, color:T.green, marginBottom:5 }}>Published ✓</div>
              <div style={{ fontSize:10, color:T.textMid, wordBreak:"break-all", marginBottom:6 }}>{url}</div>
              <button onClick={()=>navigator.clipboard?.writeText(url)}
                style={{ fontSize:10, padding:"4px 8px", borderRadius:4, border:`1px solid ${T.border}`,
                  background:"transparent", color:T.textMid, cursor:"pointer" }}>Copy link</button>
            </div>
          ) : (
            <button onClick={save} style={{ width:"100%", padding:"9px", borderRadius:6, border:"none",
              background:T.amber, color:T.bg0, fontFamily:T.sans, fontSize:13, fontWeight:700, cursor:"pointer" }}>
              ↗ Publish Dashboard
            </button>
          )}
          <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim, fontWeight:600 }}>Actions</div>
          {["🔔 Set Alert","💬 Discuss","📅 Schedule Report","📤 Export PDF"].map(a=>(
            <div key={a} style={{ padding:"7px 6px", fontSize:11, color:T.textMid, cursor:"pointer", borderRadius:4 }}
              onMouseEnter={e=>e.currentTarget.style.background=T.bg3}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{a}</div>
          ))}
        </>
      )}
    </aside>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   UPLOAD / LANDING
   ════════════════════════════════════════════════════════════════════════ */
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@300;400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${T.bg0}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  @keyframes mic-ring{0%,100%{box-shadow:0 0 0 4px ${T.amber}22}50%{box-shadow:0 0 0 12px ${T.amber}08}}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:${T.bg1}}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:2px}
`;

/* ════════════════════════════════════════════════════════════════════════
   UPLOAD SCREEN — real CSV → in-browser profile + cube build
   ════════════════════════════════════════════════════════════════════════ */
function UploadScreen({ onReady }) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus]     = useState("");   // "", parsing, profiling, building
  const [error, setError]       = useState("");
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    setError(""); setStatus("parsing");
    try {
      const text = await file.text();
      // Yield to paint so the status shows
      await new Promise(r => setTimeout(r, 30));
      const { headers, data } = parseCSV(text);
      if (!data.length) throw new Error("No data rows found in file.");

      setStatus("profiling");
      await new Promise(r => setTimeout(r, 30));
      const prof = profile(headers, data);
      if (!prof.timeCol) {
        throw new Error("No date/time column detected. The cube needs a temporal column (e.g. order_date).");
      }
      if (!prof.measures.length) {
        throw new Error("No numeric measures detected. The cube needs at least one numeric column.");
      }

      setStatus("building");
      await new Promise(r => setTimeout(r, 30));
      const cube = buildCube(data, prof);

      onReady({ cube, schema: prof, fileName: file.name });
    } catch (e) {
      setError(e.message || String(e));
      setStatus("");
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const busy = status !== "";
  const statusText = { parsing:"Parsing CSV…", profiling:"Profiling schema…", building:"Building cube…" }[status] || "";

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      height:"100vh", gap:32, background:`radial-gradient(ellipse at 50% 40%, #0e1220 0%, ${T.bg0} 70%)` }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:40, fontWeight:800, letterSpacing:"-2px",
          background:"linear-gradient(135deg,#f59e0b,#06b6d4)", WebkitBackgroundClip:"text",
          WebkitTextFillColor:"transparent" }}>axilattice</div>
        <div style={{ fontSize:11, letterSpacing:"4px", textTransform:"uppercase", color:T.textDim, marginTop:6 }}>
          agentic insight engine
        </div>
      </div>

      <div
        onDragOver={e=>{e.preventDefault(); setDragging(true);}}
        onDragLeave={()=>setDragging(false)}
        onDrop={onDrop}
        onClick={()=>!busy && fileRef.current?.click()}
        style={{ width:380, padding:40, borderRadius:12, textAlign:"center", cursor: busy?"default":"pointer",
          border:`2px dashed ${dragging?T.amber:T.border}`, background: dragging?T.amberGlow:T.bg2,
          transition:"all 0.2s" }}>
        <input ref={fileRef} type="file" accept=".csv" style={{ display:"none" }}
          onChange={e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); }}/>
        {busy ? (
          <>
            <div style={{ width:28, height:28, border:`2px solid ${T.border}`, borderTopColor:T.amber,
              borderRadius:"50%", animation:"spin 0.8s linear infinite", margin:"0 auto 14px" }}/>
            <div style={{ color:T.text, fontSize:13, fontWeight:600 }}>{statusText}</div>
            <div style={{ color:T.textDim, fontSize:11, marginTop:6 }}>Everything runs in your browser — no upload leaves your device.</div>
          </>
        ) : (
          <>
            <div style={{ fontSize:32, marginBottom:10 }}>⬡</div>
            <div style={{ color:T.text, fontSize:14, fontWeight:600 }}>Drop a CSV to build the cube</div>
            <div style={{ color:T.textDim, fontSize:11, marginTop:8, lineHeight:1.6 }}>
              Needs a date column + at least one numeric measure.<br/>Runs 100% in-browser. Try the sample datasets.
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{ maxWidth:380, background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:8,
          padding:"10px 14px", fontSize:12, color:T.red, lineHeight:1.5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   MAIN APP
   ════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,setScreen]   = useState("upload");
  const [cube,setCube]       = useState(null);
  const [schema,setSchema]   = useState(null);
  const [fileName,setFileName] = useState("");
  const [cards,setCards]     = useState([]);
  const [query,setQuery]     = useState("");
  const [loading,setLoading] = useState(false);
  const [pinned,setPinned]   = useState([]);
  const [agentTrace,setAgentTrace] = useState(null);
  const [agentLive,setAgentLive]   = useState(false);
  const [mobilePanel,setMobilePanel] = useState(null);  // null | "dims" | "dash"
  const [selMeasure,setSelMeasure] = useState(null);   // user-pinned measure override
  const [selPeriod,setSelPeriod]   = useState(null);   // user-pinned period override
  const [selGrain,setSelGrain]     = useState("month");// grain for the period picker
  const isMobile = useIsMobile();
  const inputRef = useRef(null);

  const { listening, interim, start:startVoice, stop:stopVoice, speak } = useVoice({
    onTranscript:(t)=>{ setQuery(t); handleAsk(t); },
    onError:(e)=>console.warn("voice:",e),
  });

  const handleReady = useCallback(({ cube, schema, fileName })=>{
    setCube(cube); setSchema(schema); setFileName(fileName); setScreen("app");
  },[]);

  // Suggestions built from the ACTUAL schema — mix of fast + all 4 agents
  const suggestions = useMemo(()=>{
    if (!schema) return [];
    const m  = schema.measures[0]?.col;
    const d0 = schema.dims[0]?.col;
    const d1 = schema.dims[1]?.col;
    const s = [];
    if (m && d0) s.push(`${m} by ${d0} this month`);
    if (m)       s.push(`${m} trend`);
    if (m && d0) s.push(`Why did ${m} drop?`);          // drill agent
    if (m)       s.push(`Scan overview of ${m}`);        // scan agent
    if (m)       s.push(`Find the odd ones in ${m}`);    // correlate agent
    if (m && d0) s.push(`Deep dive ${m} by ${d0} across time`); // deepdive agent
    return s;
  },[schema]);

  const handleAsk = useCallback(async (text)=>{
    const q=(text||query).trim(); if(!q || !cube) return;
    setLoading(true); setQuery(""); setAgentTrace(null);
    const intent = parseIntent(q, schema);
    // User selections override the parsed intent (explicit beats inferred)
    if (selMeasure) intent.measure = selMeasure;
    if (selPeriod)  { intent.period = selPeriod; intent.grain = selGrain; }
    const route  = routeQuery(intent);

    if (route==="agent") {
      setAgentLive(true);
      const card = await runAgent(cube, intent, (tr)=>setAgentTrace(tr));
      setAgentLive(false);
      setCards(prev=>[card,...prev]);
      setAgentTrace(null);
      if (card.summary) speak(card.summary);
    } else {
      await new Promise(r=>setTimeout(r,300));
      const card = fastPathCard(cube, intent);
      setCards(prev=>[card,...prev]);
      if (card.summary) speak(card.summary);
    }
    setLoading(false);
  },[query,cube,schema,speak,selMeasure,selPeriod,selGrain]);

  const handlePin=useCallback((c)=>setPinned(p=>p.some(x=>x.id===c.id)?p.filter(x=>x.id!==c.id):[...p,c]),[]);
  const handleUnpin=useCallback((id)=>setPinned(p=>p.filter(x=>x.id!==id)),[]);

  if (screen==="upload" || !cube || !schema) return <UploadScreen onReady={handleReady}/>;

  const dims=schema.dims, measures=schema.measures;
  const cellCount = cube.meta.cellCount;

  return (
    <div style={{ display:"flex", flexDirection:"column", minHeight:"100vh", background:T.bg0,
      color:T.text, fontFamily:T.sans }}>
      <style>{GLOBAL_CSS}</style>

      {/* HEADER */}
      <header style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        padding: isMobile ? "10px 14px" : "12px 24px",
        borderBottom:`1px solid ${T.border}`, background:T.bg1, position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap: isMobile ? 8 : 12 }}>
          <div style={{ fontSize: isMobile ? 15 : 18, fontWeight:800, letterSpacing:"-1px" }}>
            axilattice <span style={{ color:T.amber }}>·</span> engine
          </div>
          {!isMobile && (
            <span style={{ fontFamily:T.mono, fontSize:9, color:T.amber, background:`${T.amberDim}20`,
              border:`1px solid ${T.amberDim}60`, borderRadius:3, padding:"2px 7px", letterSpacing:"1px" }}>
              AGENTIC · L99
            </span>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap: isMobile ? 12 : 20 }}>
          {(isMobile
            ? [{v:cellCount.toLocaleString(),l:"Cells"}]
            : [{v:cellCount.toLocaleString(),l:"Cube Cells"},{v:dims.length,l:"Dimensions"},{v:measures.length,l:"Measures"}]
          ).map(({v,l})=>(
            <div key={l} style={{ textAlign:"right" }}>
              <div style={{ fontFamily:T.mono, fontSize:12, color:T.amber }}>{v}</div>
              <div style={{ fontSize:9, color:T.textDim, letterSpacing:"1px", textTransform:"uppercase" }}>{l}</div>
            </div>
          ))}
          <button onClick={()=>{setScreen("upload"); setCube(null); setSchema(null); setCards([]); setPinned([]);}}
            style={{ padding: isMobile ? "6px 10px" : "7px 14px", borderRadius:5, border:`1px solid ${T.border}`, background:"transparent",
              color:T.textMid, fontFamily:T.sans, fontSize:11, cursor:"pointer" }}>{isMobile ? "↩" : "↩ New Data"}</button>
        </div>
      </header>

      {/* QUERY BAR */}
      <div style={{ padding: isMobile ? "12px 14px 0" : "18px 24px 0" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, background:T.bg2,
          border:`1px solid ${listening?T.amber:T.borderHi}`, borderRadius:10, padding:"10px 14px",
          boxShadow: listening?`0 0 0 4px ${T.amber}12`:"none",
          animation: listening?"mic-ring 1.5s infinite":"none", transition:"border-color 0.2s" }}>
          <span style={{ fontSize:16, color:T.textDim }}>⌕</span>
          <input ref={inputRef} value={listening&&interim?interim:query}
            onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleAsk()}
            placeholder={listening?"Listening…":"Ask anything — try 'why did revenue drop last quarter?'"}
            style={{ flex:1, background:"none", border:"none", outline:"none", fontFamily:T.sans, fontSize:15, color:T.text }}/>
          <button onClick={listening?stopVoice:startVoice}
            style={{ width:36, height:36, borderRadius:"50%", border:"none", cursor:"pointer",
              background:listening?T.amber:T.bg3, color:listening?T.bg0:T.textMid, fontSize:16,
              display:"flex", alignItems:"center", justifyContent:"center",
              animation:listening?"pulse 1s infinite":"none", flexShrink:0 }}>🎙</button>
          <button onClick={()=>handleAsk()} disabled={loading||!query.trim()}
            style={{ padding:"9px 20px", borderRadius:6, border:"none", background:T.amber, color:T.bg0,
              fontFamily:T.sans, fontSize:13, fontWeight:700, cursor:"pointer",
              opacity:loading||!query.trim()?0.4:1, flexShrink:0 }}>Ask →</button>
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:7, marginTop:10 }}>
          {suggestions.map(s=>{
            const isAgent = /why|drop|explain|scan|overview|odd|deep dive|correlat|drill/.test(s.toLowerCase());
            return (
              <span key={s} onClick={()=>handleAsk(s)}
                style={{ fontSize:11, color:isAgent?T.purple:T.textMid, background:T.bg2,
                  border:`1px solid ${isAgent?`${T.purple}40`:T.border}`, borderRadius:20, padding:"4px 12px",
                  cursor:"pointer", whiteSpace:"nowrap" }}>
                {isAgent?"✦ ":""}{s}
              </span>
            );
          })}
        </div>

        {/* SELECTOR BAR — user overrides for measure + period */}
        <div style={{ display:"flex", flexWrap:"wrap", alignItems:"center", gap:10, marginTop:12,
          paddingTop:12, borderTop:`1px solid ${T.border}` }}>
          <span style={{ fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:T.textDim, fontWeight:600 }}>
            Focus
          </span>

          {/* Measure selector */}
          <label style={{ fontSize:11, color:T.textDim }}>Measure:</label>
          <select value={selMeasure||""} onChange={e=>setSelMeasure(e.target.value||null)}
            style={{ background:T.bg2, color: selMeasure?T.amber:T.textMid, border:`1px solid ${selMeasure?`${T.amber}50`:T.border}`,
              borderRadius:5, padding:"5px 9px", fontFamily:T.sans, fontSize:12, cursor:"pointer", outline:"none" }}>
            <option value="">Auto</option>
            {measures.map(m=><option key={m.col} value={m.col}>{m.col}</option>)}
          </select>

          {/* Grain selector (drives period list) */}
          <label style={{ fontSize:11, color:T.textDim }}>Grain:</label>
          <select value={selGrain} onChange={e=>{ setSelGrain(e.target.value); setSelPeriod(null); }}
            style={{ background:T.bg2, color:T.textMid, border:`1px solid ${T.border}`,
              borderRadius:5, padding:"5px 9px", fontFamily:T.sans, fontSize:12, cursor:"pointer", outline:"none" }}>
            {["month","quarter","year","week","day"]
              .filter(g=>Object.keys(cube.totals?.[g]||{}).length>=1)
              .map(g=><option key={g} value={g}>{g}</option>)}
          </select>

          {/* Period selector */}
          <label style={{ fontSize:11, color:T.textDim }}>Period:</label>
          <select value={selPeriod||""} onChange={e=>setSelPeriod(e.target.value||null)}
            style={{ background:T.bg2, color: selPeriod?T.amber:T.textMid, border:`1px solid ${selPeriod?`${T.amber}50`:T.border}`,
              borderRadius:5, padding:"5px 9px", fontFamily:T.sans, fontSize:12, cursor:"pointer", outline:"none", maxWidth:130 }}>
            <option value="">Latest / Auto</option>
            {Object.keys(cube.totals?.[selGrain]||{}).sort().map(pk=>(
              <option key={pk} value={pk}>{pk}</option>
            ))}
          </select>

          {(selMeasure||selPeriod) && (
            <button onClick={()=>{ setSelMeasure(null); setSelPeriod(null); }}
              style={{ fontSize:11, color:T.textDim, background:"transparent", border:`1px solid ${T.border}`,
                borderRadius:5, padding:"4px 10px", cursor:"pointer" }}>
              Reset focus ✕
            </button>
          )}
        </div>
      </div>

      {/* BODY */}
      <div style={{ display:"flex", flex:1, alignItems:"flex-start", minHeight:0, position:"relative" }}>
        {/* SIDEBAR — overlay drawer on mobile */}
        {(!isMobile || mobilePanel==="dims") && (
        <aside style={{
          width: isMobile ? "80%" : 200, maxWidth: isMobile ? 300 : 200,
          flexShrink:0, background:T.bg1, borderRight:`1px solid ${T.border}`,
          padding:"20px 16px", overflowY:"auto",
          height: isMobile ? "auto" : "100%",
          position: isMobile ? "absolute" : "relative",
          top:0, left:0, bottom: isMobile ? 0 : "auto", zIndex: isMobile ? 50 : 1,
          boxShadow: isMobile ? "4px 0 24px rgba(0,0,0,0.5)" : "none",
        }}>
          {isMobile && (
            <div onClick={()=>setMobilePanel(null)} style={{ display:"flex", justifyContent:"flex-end",
              marginBottom:8, cursor:"pointer", color:T.textMid, fontSize:18 }}>✕</div>
          )}
          <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
            <div>
              <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim,
                fontWeight:600, marginBottom:10 }}>Dimensions</div>
              {dims.map(d=>(
                <div key={d.col} onClick={()=>handleAsk(`${measures[0]?.col||"value"} by ${d.col} this month`)}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 8px", borderRadius:5,
                    cursor:"pointer", marginBottom:2 }}
                  onMouseEnter={e=>e.currentTarget.style.background=T.bg3}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{ fontSize:13, color:T.textDim }}>◈</span>
                  <span style={{ fontSize:12, color:T.textMid, fontWeight:500 }}>{d.col}</span>
                  <span style={{ fontSize:10, color:T.textDim, marginLeft:"auto" }}>{d.cardinality}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim,
                fontWeight:600, marginBottom:10 }}>Measures</div>
              {measures.map((m,i)=>(
                <div key={m.col} onClick={()=>handleAsk(`${m.col} trend`)}
                  style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 8px",
                    borderRadius:5, cursor:"pointer", marginBottom:2 }}
                  onMouseEnter={e=>e.currentTarget.style.background=T.bg3}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{ fontSize:12, color:T.textMid }}>{m.col}</span>
                  <span style={{ width:8, height:8, borderRadius:"50%", background:PALETTE[i] }}/>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim,
                fontWeight:600, marginBottom:10 }}>Agents</div>
              {[
                { label:"Scan everything",   q:`scan overview of ${measures[0]?.col||"value"}` },
                { label:"Deep-dive a dim",   q:`deep dive ${measures[0]?.col||"value"} by ${dims[0]?.col||"dimension"} across time` },
                { label:"Drill root-cause",  q:`why did ${measures[0]?.col||"value"} drop` },
                { label:"Correlate + odd ones", q:`find the odd ones in ${measures[0]?.col||"value"}` },
              ].map(a=>(
                <div key={a.label} onClick={()=>handleAsk(a.q)}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:5,
                    cursor:"pointer", marginBottom:2, fontSize:11, color:T.purple }}
                  onMouseEnter={e=>e.currentTarget.style.background=T.bg3}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  ✦ {a.label}
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim,
                fontWeight:600, marginBottom:10 }}>Insight Types</div>
              {Object.entries(INSIGHT_TYPES).map(([key,it])=>(
                <div key={key}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:5,
                    marginBottom:2, fontSize:11, color: it.supported?T.textMid:T.textDim,
                    cursor: it.supported?"default":"help" }}
                  title={it.supported ? it.desc : `Needs data source: ${it.desc}`}>
                  <span style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
                    background: it.supported?T.green:T.textFaint }}/>
                  {it.label}
                  {!it.supported && <span style={{ fontSize:8, color:T.textFaint, marginLeft:"auto" }}>needs data</span>}
                </div>
              ))}
            </div>
          </div>
        </aside>
        )}

        {/* Mobile backdrop when a panel is open */}
        {isMobile && mobilePanel && (
          <div onClick={()=>setMobilePanel(null)}
            style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.5)", zIndex:40 }}/>
        )}

        {/* MAIN */}
        <main style={{ flex:1, minWidth:0, padding: isMobile ? "16px 14px 72px" : "20px 24px", overflowY:"auto", width:"100%" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <span style={{ fontSize:9, letterSpacing:"2px", textTransform:"uppercase", color:T.textDim, fontWeight:600 }}>
              Insights — {cards.length} generated
            </span>
            {cards.length>0 && (
              <span onClick={()=>setCards([])} style={{ fontSize:11, color:T.textDim, cursor:"pointer" }}>Clear all</span>
            )}
          </div>

          {/* Live agent trace */}
          {agentTrace && <AgentTrace trace={agentTrace} live={agentLive}/>}

          {/* Fast-path spinner */}
          {loading && !agentTrace && (
            <div style={{ display:"flex", alignItems:"center", gap:14, background:T.bg2,
              border:`1px solid ${T.border}`, borderRadius:10, padding:18, marginBottom:16 }}>
              <div style={{ width:22, height:22, border:`2px solid ${T.border}`, borderTopColor:T.amber,
                borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
              <div>
                <div style={{ fontSize:13, color:T.text }}>Resolving from cube…</div>
                <div style={{ fontSize:11, color:T.textDim, marginTop:3 }}>Router: fast path · direct cube lookup</div>
              </div>
            </div>
          )}

          {/* Empty */}
          {cards.length===0 && !loading && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
              height:300, gap:16, color:T.textDim }}>
              <div style={{ fontSize:44, opacity:0.25 }}>◈</div>
              <div style={{ fontSize:13, textAlign:"center", lineHeight:1.7 }}>
                Ask a simple question → instant cube lookup.<br/>
                Ask <span style={{ color:T.purple }}>"why did revenue drop?"</span> → watch the agent reason.<br/>
                <span style={{ color:T.amber }}>Voice or text. Try the chips above.</span>
              </div>
            </div>
          )}

          {/* Cards */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(300px, 1fr))", gap:16 }}>
            {cards.map(card=>(
              <InsightCard key={card.id} card={card} pinned={pinned} onPin={handlePin} onSpeak={speak}/>
            ))}
          </div>
        </main>

        {/* DASHBOARD — overlay drawer on mobile */}
        {(!isMobile || mobilePanel==="dash") && (
          <div style={ isMobile ? {
            position:"absolute", top:0, right:0, bottom:0, zIndex:50,
            width:"85%", maxWidth:320, boxShadow:"-4px 0 24px rgba(0,0,0,0.5)",
          } : {} }>
            {isMobile && (
              <div onClick={()=>setMobilePanel(null)} style={{ position:"absolute", top:12, left:12,
                cursor:"pointer", color:T.textMid, fontSize:18, zIndex:51 }}>✕</div>
            )}
            <DashboardPanel pinned={pinned} onUnpin={handleUnpin}/>
          </div>
        )}
      </div>

      {/* MOBILE BOTTOM TAB BAR */}
      {isMobile && (
        <div style={{ position:"fixed", bottom:0, left:0, right:0, zIndex:60,
          display:"flex", background:T.bg1, borderTop:`1px solid ${T.border}`,
          height:56 }}>
          {[
            { id:"dims", label:"Dimensions", icon:"◈" },
            { id:null,   label:"Insights",   icon:"◆" },
            { id:"dash", label:`Pins ${pinned.length}`, icon:"◉" },
          ].map(tab=>(
            <button key={tab.label} onClick={()=>setMobilePanel(tab.id)}
              style={{ flex:1, border:"none", background:"transparent", cursor:"pointer",
                display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2,
                color: mobilePanel===tab.id ? T.amber : T.textMid, fontFamily:T.sans }}>
              <span style={{ fontSize:16 }}>{tab.icon}</span>
              <span style={{ fontSize:10 }}>{tab.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
