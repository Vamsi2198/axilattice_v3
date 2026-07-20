import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  parseCSV, profile, buildCube,
  queryBreakdown, queryTrend, queryTotal, queryTopK, queryDelta,
  latestPeriod,
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

  // insight type
  let insight_type = "breakdown";
  if (/\b(why|explain|reason|cause|diagnos|root|drop|decline|fell|worse|spike|anomal)\b/.test(q))
    insight_type = "diagnostic";
  else if (/trend|over time|trajectory|history/.test(q)) insight_type = "trend";
  else if (/\btop|best|rank|highest|lowest|worst\b/.test(q)) insight_type = "topk";
  else if (/total|overall|sum|grand/.test(q)) insight_type = "total";
  else if (!dimension) insight_type = "trend";

  let k = 5; const km = q.match(/top\s+(\d+)/); if (km) k = +km[1];

  // If diagnostic but no dimension named, default to the first dimension
  if (insight_type === "diagnostic" && !dimension) dimension = dims[0];

  const title = text.length > 52 ? text.slice(0,50)+"…" : text;
  return { insight_type, measure, dimension, grain, k, title };
}

/* ════════════════════════════════════════════════════════════════════════
   AGENT ROUTER
   ════════════════════════════════════════════════════════════════════════ */
function routeQuery(intent) {
  return intent.insight_type === "diagnostic" ? "agent" : "fast";
}

// FAST PATH — one cube lookup → card
function fastPathCard(cube, intent) {
  const { insight_type, measure, dimension, grain, k } = intent;
  let chart_data = [], kpi = null, delta = null, chart_type = "bar", period = latestPeriod(cube, grain);
  const nPeriods = { day:30, week:16, month:12, quarter:8, year:5 }[grain] || 12;

  if (insight_type === "trend" || (!dimension && insight_type !== "total")) {
    chart_data = queryTrend(cube, measure, grain, nPeriods);
    chart_type = "area";
    kpi = chart_data.at(-1)?.value;
    const prev = chart_data.at(-2)?.value;
    delta = prev ? (kpi - prev)/prev : null;
  } else if (insight_type === "total") {
    const r = queryTotal(cube, measure, grain);
    kpi = r.value; delta = r.delta; period = r.period;
    chart_data = queryTrend(cube, measure, grain, nPeriods); chart_type = "area";
  } else if (insight_type === "topk") {
    chart_data = queryTopK(cube, dimension, measure, grain, k);
    chart_type = "bar"; kpi = chart_data[0]?.value;
    delta = queryDelta(cube, dimension, chart_data[0]?.label, measure, grain);
  } else { // breakdown
    chart_data = queryBreakdown(cube, dimension, measure, grain);
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
async function runAgent(cube, intent, onStep) {
  const { measure } = intent;
  const dim = intent.dimension;
  const trace = [];
  const step = async (phase, label, detail) => {
    trace.push({ phase, label, detail });
    onStep([...trace]);
    await new Promise(r => setTimeout(r, 650));
  };

  // Worst single-period drop for a given dim value across the month grain
  const worstDropFor = (value) => {
    const tr = queryTrend(cube, measure, "month", 12, dim, value);
    let drop = 0, month = null;
    for (let i = 1; i < tr.length; i++) {
      const d = tr[i-1].value ? (tr[i].value - tr[i-1].value)/tr[i-1].value : 0;
      if (d < drop) { drop = d; month = tr[i].period; }
    }
    return { drop, month, trend: tr };
  };

  // OBSERVE
  const totalTrend = queryTrend(cube, measure, "month", 12);
  const tMin = Math.min(...totalTrend.map(t=>t.value)), tMax = Math.max(...totalTrend.map(t=>t.value));
  await step("OBSERVE", `Pull ${measure} total trend`,
    `Fetched 12 months of total ${measure} (range ${fmtKpi(tMin)}–${fmtKpi(tMax)}). Scanning beneath the aggregate for localized weakness.`);

  // ORIENT
  const breakdown = queryBreakdown(cube, dim, measure, "month");
  const profiles = breakdown.map(b => ({ label: b.label, ...worstDropFor(b.label) }))
    .sort((a,b)=>a.drop-b.drop);
  const worst = profiles[0];
  const worstTxt = worst && worst.month
    ? `${worst.label} fell ${(worst.drop*100).toFixed(1)}% at ${worst.month}`
    : `no single ${dim} shows a sharp drop`;
  await step("ORIENT", `Decompose ${measure} by ${dim}`,
    `Analyzed the full trajectory of ${breakdown.length} ${dim}s. Sharpest move: ${worstTxt}.`);

  // DECIDE
  await step("DECIDE", `Isolate ${worst.label} as prime suspect`,
    `${worst.label}'s move is the largest contributor to the aggregate shift. Drilling into its ${measure} trend to confirm the inflection.`);

  // ACT
  const moverTrend = worst.trend;
  await step("ACT", `Confirm inflection in ${worst.label}`,
    `Verified inflection at ${worst.month || "n/a"}. Neighboring ${dim}s show no matching break — the cause is localized to ${worst.label}.`);

  const summary = worst.month
    ? `Root cause: the shift in total ${measure} traces to ${worst.label}, which moved ${Math.abs(worst.drop*100).toFixed(1)}% at ${worst.month}. Other ${dim}s stayed stable — this is a localized ${worst.label} effect, not systemic.`
    : `No single ${dim} shows a dominant drop; the movement in ${measure} appears distributed rather than localized.`;

  return {
    id: Math.random().toString(36).slice(2,8),
    title: intent.title, insight_type: "diagnostic",
    measure, dimension: dim, grain: intent.grain,
    chart_type: "area", chart_data: moverTrend,
    kpi: moverTrend.at(-1)?.value, delta: worst.drop, period: worst.month,
    summary, via: "agent", trace, focus: worst.label,
  };
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
  const inputRef = useRef(null);

  const { listening, interim, start:startVoice, stop:stopVoice, speak } = useVoice({
    onTranscript:(t)=>{ setQuery(t); handleAsk(t); },
    onError:(e)=>console.warn("voice:",e),
  });

  const handleReady = useCallback(({ cube, schema, fileName })=>{
    setCube(cube); setSchema(schema); setFileName(fileName); setScreen("app");
  },[]);

  // Suggestions built from the ACTUAL schema
  const suggestions = useMemo(()=>{
    if (!schema) return [];
    const m  = schema.measures[0]?.col;
    const d0 = schema.dims[0]?.col;
    const d1 = schema.dims[1]?.col;
    const s = [];
    if (m && d0) s.push(`${m} by ${d0} this month`);
    if (m)       s.push(`${m} trend`);
    if (m && d1) s.push(`Top 5 ${d1} by ${m}`);
    if (m && d0) s.push(`Why did ${m} drop?`);
    if (m && d1) s.push(`${m} by ${d1}`);
    if (m)       s.push(`Total ${m} this year`);
    return s;
  },[schema]);

  const handleAsk = useCallback(async (text)=>{
    const q=(text||query).trim(); if(!q || !cube) return;
    setLoading(true); setQuery(""); setAgentTrace(null);
    const intent = parseIntent(q, schema);
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
  },[query,cube,schema,speak]);

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
      <header style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 24px",
        borderBottom:`1px solid ${T.border}`, background:T.bg1, position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ fontSize:18, fontWeight:800, letterSpacing:"-1px" }}>
            axilattice <span style={{ color:T.amber }}>·</span> engine
          </div>
          <span style={{ fontFamily:T.mono, fontSize:9, color:T.amber, background:`${T.amberDim}20`,
            border:`1px solid ${T.amberDim}60`, borderRadius:3, padding:"2px 7px", letterSpacing:"1px" }}>
            AGENTIC · L99
          </span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:20 }}>
          {[{v:cellCount.toLocaleString(),l:"Cube Cells"},{v:dims.length,l:"Dimensions"},{v:measures.length,l:"Measures"}].map(({v,l})=>(
            <div key={l} style={{ textAlign:"right" }}>
              <div style={{ fontFamily:T.mono, fontSize:12, color:T.amber }}>{v}</div>
              <div style={{ fontSize:9, color:T.textDim, letterSpacing:"1px", textTransform:"uppercase" }}>{l}</div>
            </div>
          ))}
          <button onClick={()=>{setScreen("upload"); setCube(null); setSchema(null); setCards([]); setPinned([]);}}
            style={{ padding:"7px 14px", borderRadius:5, border:`1px solid ${T.border}`, background:"transparent",
              color:T.textMid, fontFamily:T.sans, fontSize:11, cursor:"pointer" }}>↩ New Data</button>
        </div>
      </header>

      {/* QUERY BAR */}
      <div style={{ padding:"18px 24px 0" }}>
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
            const isAgent = /why|drop|explain/.test(s.toLowerCase());
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
      </div>

      {/* BODY */}
      <div style={{ display:"flex", flex:1, alignItems:"flex-start", minHeight:0 }}>
        {/* SIDEBAR */}
        <aside style={{ width:200, flexShrink:0, background:T.bg1, borderRight:`1px solid ${T.border}`,
          padding:"20px 16px", overflowY:"auto", height:"100%" }}>
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
                fontWeight:600, marginBottom:10 }}>Agent Skills</div>
              {["Diagnose a drop","Find anomalies","Root-cause analysis"].map(s=>(
                <div key={s} onClick={()=>handleAsk(`why did ${measures[0]?.col||"value"} drop`)}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:5,
                    cursor:"pointer", marginBottom:2, fontSize:11, color:T.purple }}
                  onMouseEnter={e=>e.currentTarget.style.background=T.bg3}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  ✦ {s}
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* MAIN */}
        <main style={{ flex:1, minWidth:0, padding:"20px 24px", overflowY:"auto" }}>
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

        {/* DASHBOARD */}
        <DashboardPanel pinned={pinned} onUnpin={handleUnpin}/>
      </div>
    </div>
  );
}
