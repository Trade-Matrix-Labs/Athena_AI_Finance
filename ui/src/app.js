"use strict";
/* Athena App v3. Number code, the Memo / Ask / Suggest edit loop, the Probe, scale rail, gauges, dial and the rosette
   started from our 20 Oct 2026 reading-desk mockups; see README. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const RM = matchMedia("(prefers-reduced-motion: reduce)");
let FAST = false;
const wait = ms => new Promise(r => setTimeout(r, FAST ? 0 : ms));
const isPhone = () => innerWidth < 900;
const pad2 = n => String(n).padStart(2, "0");
const clone = o => JSON.parse(JSON.stringify(o));
const mmss = s => pad2(Math.floor(s / 60)) + ":" + pad2(Math.floor(s % 60));
const live = t => { $("#live").textContent = t; };

/* ================= data (one block, swapped by build.py) ================= */
const DOC = JSON.parse($("#report-data").textContent);
// app mode: the app server adds an app-config slot (its API and this edition); the static prototype has none and keeps its
// demo behaviour (seed memos, memos in this browser)
const CFG = (e => e ? JSON.parse(e.textContent) : null)($("#app-config")), APP = !!CFG;
// app mode, a partial edition (its delivery manifest named the chapters in `coverage`): the stored report holds only the
// chapters it has, and the app server adds the canonical chapter map. Every chapter is listed at its canonical number; one
// not in this edition is a display-only entry with no blocks and no key point, `absent` "planned" (not part of this run)
// or "failed" (left out: it did not pass the checks). Without coverage nothing changes
const COV = APP && CFG.coverage && Array.isArray(CFG.chapters) && DOC.sections.every(s => CFG.chapters.some(c => c[0] === s.id)) ? CFG.coverage : null;
if (COV) { const have = new Map(DOC.sections.map(s => [s.id, s]));
  DOC.sections = CFG.chapters.map(([id, title, question], i) => Object.assign(have.get(id) || { id, title, question, blocks: [], absent: COV.failed.includes(id) ? "failed" : "planned" }, { number: i + 1 })); }
const HAVE = DOC.sections.filter(s => !s.absent); // the chapters this edition has (every one, unless it is partial)
const ABSENT = { planned: "planned for a later edition", failed: "left out: it did not pass the checks" };
const absentShort = s => `Not in this edition · ${ABSENT[s.absent]}`;
// one request to the app server; a refusal becomes an Error carrying the server's words, the HTTP status and the body it sent.
// A DELETE sends no body and no Content-Type; a write sends JSON
async function api(method, url, body) {
  const o = body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let r; try { r = await fetch(url, o); } catch (_) { throw new Error("the app server did not answer"); }
  if (r.ok) return r.status === 204 ? null : r.json();
  let d = "", code, j; try { j = await r.json(); code = j.code; d = Array.isArray(j.detail) ? j.detail.map(x => x.msg).join("; ") : String(j.detail || ""); } catch (_) {}
  throw Object.assign(new Error(`${d || r.statusText || "refused"} (HTTP ${r.status})`), { status: r.status, code, body: j });
}
// Ask with live answers (app mode): the app server puts `ask_url` in the page's app-config only when a model key and a cost cap
// are set. Without it ASK is null, no request is made and the Desk keeps its sample answers. This adapter is the one place that
// knows the wire shape: a question {question, thread_id?, intent?, anchor_id?} (anchor_id: the element a new thread or a quick
// action points at) and the decisions on a thread's proposed writes {decisions: [{id, type: approve|edit|reject, args?}]};
// both answer with one turn
const ASKED = { answered: 1, needs_approval: 1, disabled: 1, refused: 1 };
const askTurn = r => ({
  // any other state (the server's not-checked state included, or one this page does not know) reads as not checked: fail closed
  state: ASKED[r.state] ? r.state : "unchecked", thread: r.thread_id, text: r.answer || "", problems: r.problems || [],
  cites: (r.citations || []).filter(c => c && c.id), numbers: r.numbers || [], code: r.code || "", notice: r.notice || "",
  ui: (r.ui_actions || []).map(a => a.type === "highlight_anchor" ? { ...a, type: "highlight" } : a),
  pending: (r.pending_actions || []).map(p => ({ id: p.id, tool: p.tool, args: p.args || {}, problems: p.problems || [], base: S.latest })) }); // base: the reader's Rev it was written for
// a refusal keeps, as e.turn, what the server says happened before it failed: the thread it made (thread_id), the view actions
// of tools that ran (ui_actions) and, after decisions were applied, its notice. A question over the length limit (the server's
// 422 names the field) gets a code of its own
const ASK_MAX = 4000;
const askFail = e => { const b = e.body || {};
  if (e.status === 422 && Array.isArray(b.detail) && b.detail.some(x => x && x.type === "string_too_long" && (x.loc || []).includes("question"))) e.code = "question_too_long";
  throw Object.assign(e, { turn: askTurn(b) }); };
const ASK = APP && CFG.ask_url ? {
  ask: (question, { thread, anchor, intent } = {}) => {
    const at = anchor && (anchor.fact || anchor.block_id);
    return api("POST", CFG.ask_url, { question, ...(thread ? { thread_id: thread } : {}), ...(intent ? { intent } : {}),
      ...(at && (intent || !thread) ? { anchor_id: at } : {}) }).then(askTurn, askFail); },
  decide: (thread, decisions) => api("POST", `${CFG.ask_url}/${thread}/decisions`, { decisions }).then(askTurn, askFail),
} : null;
let ASK_OFF = false; // the server answered `disabled` once: sample answers from then on, as without live answers
const LIVE = () => !!ASK && !ASK_OFF;
// this edition's record from the app server: the four status fields, the delivery scope and the open review findings.
// "Ready" wording only for an edition that is both accepted and published
let ED = null, EDERR = "", LIB = null, APIERR = "";
const uword = s => String(s || "").replace(/_/g, " "), cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
const edReady = () => !APP || !!ED && ED.status.quality_disposition === "accepted" && ED.status.publication_disposition === "published";
// what the screens show as ready: app mode only. The static build replays a sample that has not passed review
const edShow = () => APP && edReady();
const stWords = e => `${cap1(uword(e.status.publication_disposition))} · ${uword(e.status.quality_disposition)}`;
const edWords = () => !APP ? "Draft · review required" : ED ? stWords(ED) : EDERR ? "status unavailable" : "status loading";
// per-edition labels set by hand; move to edition data when the delivery carries them. Keyed by the delivery's
// report_sha256 (EDITION-STATUS), which the app server sends as the edition's source_sha256; any other edition has none
const ED_LABEL = { "0c62f515cc417d07ceb6a802bbebfed719d00d9b98a4cc916c97473c14754d1e": "Assisted revision (n=1) · Financial review failed — correction required" };
const edLabel = () => ED && ED_LABEL[ED.source_sha256] || "";
// the app server's interim status strip (#edition-status) carries the label on its own line once the edition record is in
const stripLabel = () => { const s = $("#edition-status"), l = edLabel(); if (s && l && !$(".edlab", s)) s.insertAdjacentHTML("beforeend", `<span class="edlab">${esc(l)}</span>`); };
// the label on AI-written text: sample text in the static prototype; in app mode the edition's own text, a draft until it is
// accepted and published
const aiTag = () => !APP ? "Sample · AI text" : edReady() ? "AI text" : "AI text · draft";
const F = {}, SRC = {}, ASM = {};
DOC.facts.forEach(f => F[f.id] = f);
DOC.sources.forEach(s => SRC[s.id] = s);
(DOC.assumptions || []).forEach(a => ASM[a.id] = a);
const FIL = DOC.filing, FY = FIL.fiscal_year;
const TOKRE = /\{fact:([^}]+)\}/g;
const textFacts = t => [...String(t || "").matchAll(TOKRE)].map(m => m[1]).filter(id => F[id]);
function blockFacts(b) {
  const out = [];
  if (b.kind === "prose" || b.kind === "callout") out.push(...textFacts(b.title), ...textFacts(b.text));
  if (b.kind === "table") b.rows.forEach(r => r.cells.forEach(c => c && out.push(c)));
  if (b.kind === "chart") b.series.forEach(s => s.facts.forEach(c => c && out.push(c)));
  if (b.kind === "lab") b.outputs.forEach(o => o.inputs.forEach(i => out.push(i)));
  return out.filter(id => F[id]);
}
function sectionFacts(sec) { const out = []; [...textFacts(sec.keypoint), ...sec.blocks.flatMap(blockFacts)].forEach(id => out.includes(id) || out.push(id)); return out; }
const blockOf = (doc, bid) => { for (const s of doc.sections) for (const b of s.blocks) if (b.id === bid) return { s, b }; return null; };
const secById = (doc, id) => doc.sections.find(s => s.id === id);
const secNum = s => pad2(s.number);
const PLACEHOLDER_KP = "Content arrives with the full data.";

/* ================= exact numbers (BigInt decimal strings; no float rounding) ================= */
function roundStr(str, shift, dp, dir = 0) { // round(value * 10^shift, dp) half-up (dir 0), down (-1) or up (+1), as a string
  let neg = str.startsWith("-"); if (neg) str = str.slice(1);
  const [i, f = ""] = str.split(".");
  let n = BigInt(i + f); const k = f.length - shift - dp; let q;
  if (k <= 0) q = n * 10n ** BigInt(-k);
  else { const d = 10n ** BigInt(k), r = n % d; q = n / d; if (dir ? r && (dir > 0) !== neg : r * 2n >= d) q += 1n; }
  let s = q.toString().padStart(dp + 1, "0");
  s = dp ? s.slice(0, -dp) + "." + s.slice(-dp) : s;
  return (neg && /[1-9]/.test(s) ? "−" : "") + s;
}
function shiftStr(v, k) { // exact value * 10^k as a plain decimal string
  const neg = v.startsWith("-"); if (neg) v = v.slice(1);
  const [i, f = ""] = v.split("."); let d = i + f, p = i.length + k;
  if (p <= 0) { d = "0".repeat(1 - p) + d; p = 1; }
  if (p > d.length) d += "0".repeat(p - d.length);
  const a = d.slice(0, p).replace(/^0+(?=\d)/, ""), b = d.slice(p).replace(/0+$/, "");
  return (neg ? "-" : "") + a + (b ? "." + b : "");
}
const group = s => s.replace(/(\d+)/, m => m.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const SHIFT = { thousands: 3, units: 0, millions: 6, billions: 9 };
const absDollars = f => BigInt(shiftStr(f.value.replace("-", ""), SHIFT[f.scale] ?? 0).split(".")[0] || "0");
const isText = f => f.kind !== "calculated" && !f.concept; // reported from a text quote (rounded), not from a tag
const roundedText = f => isText(f) && /[^\d,.\s()]/.test(String(f.shown || "")) && !isDash(f); // "$4.1 billion", "109%": rounded in the text
const showsAsPrinted = f => isText(f) && f.shown && (roundedText(f) || !/^usd/.test(f.unit)); // bare "156,052" ($ thousands) renders from value + scale
const isDash = f => /^[—–-]$/.test(String(f.shown || "").trim()); // the filing prints a dash: nil
const parenPrinted = f => String(f.shown || "").trim().startsWith("(");
const printed = f => f.shown ?? asFiled(f);
const ctxLabel = f => f.dims_label || ""; // plain label from the data; member names are never shown
const lc1 = s => /^[A-Z][a-z]/.test(s) && !/^(Palantir|United|U\.S\.|GAAP|Customer [A-Z]\b)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
// statement or note behind a source line, for chips and for "Printed as … in …"
function stmt(sid, chip) {
  const s = SRC[sid]; if (!s) return chip ? "Filing" : "the filing";
  const [item, ...rest] = s.locator.split(" · "), name = rest.join(" · ");
  const short = { "Consolidated Statements of Cash Flows": ["Cash flows", "the cash flow statement"], "Consolidated Statements of Operations": ["Operations", "the income statement"], "Consolidated Balance Sheets": ["Balance sheet", "the balance sheet"] }[name];
  if (chip) { const n = short ? short[0] : name || item; return (n.length > 30 ? n.slice(0, 29).trimEnd() + "…" : n) + (name ? " · " + item : ""); }
  return short ? short[1] : name ? `${name} (${item})` : item;
}
function spec(f, style) {
  const sh = SHIFT[f.scale] ?? 0;
  switch (f.unit) {
    case "usd":
      // a $ millions table never spreads a figure the filing rounds to billions into false precision
      // "tablex": a table that mixes units, so each cell carries its own
      if (/^table/.test(style) && sh <= 6) return { k: sh - 6, dp: 1, pre: style === "tablex" ? "$" : "", post: style === "tablex" ? "M" : "", unit: "$ millions", paren: true, grp: true, rule: "shown in $ millions to 0.1" };
      if (style === "chart") return { k: sh - 9, dp: 2, pre: "", post: "", unit: "$ billions", rule: "shown to $0.01 billion" };
      return absDollars(f) >= 1000000000n
        ? { k: sh - 9, dp: 2, pre: "$", post: style === "prose" ? " billion" : "B", unit: "$ billions", rule: "shown to $0.01 billion", paren: /^table/.test(style) }
        : { k: sh - 6, dp: 1, pre: "$", post: style === "prose" ? " million" : "M", unit: "$ millions", rule: "shown to $0.1 million", paren: /^table/.test(style) };
    case "usd_per_share": return { k: 0, dp: 2, pre: style === "table" ? "" : "$", post: "", unit: "$ per share", rule: "shown to $0.01" };
    case "shares": return { k: sh - 6, dp: 1, pre: "", post: style === "table" ? "" : style === "tablex" ? "M" : " million shares", unit: "millions of shares", grp: true, rule: "shown in millions to 0.1" };
    case "ratio": return { k: 2, dp: 1, pre: "", post: "%", unit: "percent", rule: "shown to 0.1 pp" };
    case "percent": return { k: 0, dp: 1, pre: "", post: "%", unit: "percent", rule: "shown to 0.1 pp" };
    case "points": return { k: 2, dp: 1, pre: "", post: style === "prose" ? " percentage points" : " pp", unit: "percentage points", sign: style !== "prose", rule: "shown to 0.1 pp" };
    case "multiple": return { k: 0, dp: 1, pre: "", post: "×", unit: "times", rule: "shown to 0.1×" };
    default: return { k: sh, dp: 0, pre: "", post: f.unit && !/^(pure|count|number|units?)$/.test(f.unit) ? " " + f.unit.replace(/_/g, " ") : "", unit: (f.unit || "").replace(/_/g, " "), grp: true, rule: "shown to 1" };
  }
}
// decimals shown: calculated figures round to the display rule; reported ratios show every printed digit;
// other reported figures never show more decimals than the filing printed
function dpFor(f, p) {
  if (f.kind === "calculated") { const s = supDp(f); return s == null ? p.dp : Math.max(0, Math.min(p.dp, s - p.k)); }
  const sup = printedDp(f, p);
  return /^(ratio|percent)$/.test(f.unit) ? sup : Math.min(p.dp, sup);
}
// filing precision: XBRL `decimals` (integer or "INF"); without it, the precision of the printed form
const PW = { billion: 9, million: 6, thousand: 3 };
function decOf(f) {
  if (f.decimals != null) return f.decimals === "INF" ? Infinity : +f.decimals;
  const m = !isDash(f) && /(\d[\d,]*)(?:\.(\d+))?\s*(%|billion|million|thousand)?/.exec(String(f.shown || ""));
  if (m) { const fr = (m[2] || "").length; return m[3] === "%" ? fr + 2 : fr - (m[3] ? PW[m[3]] : SHIFT[f.scale] ?? 0); }
  return (f.value.split(".")[1] || "").length - (SHIFT[f.scale] ?? 0);
}
// decimals the filing printed, at the display scale of spec p
const printedDp = (f, p) => { const d = decOf(f); return d === Infinity ? (shiftStr(f.value, p.k).split(".")[1] || "").length : Math.max(0, d + (SHIFT[f.scale] ?? 0) - p.k); };
// an operand stated coarser than the filing's usual $ thousands, or any text figure, is marked with its precision;
// a rounded one (coarse $, or a rounded text figure) also limits the digits of every result built on it
const isCoarse = f => f.kind !== "calculated" && (isText(f) || f.unit === "usd" && decOf(f) < -3);
const limits = f => f.kind !== "calculated" && (f.unit === "usd" && decOf(f) < -3 || roundedText(f));
function precWords(f) {
  const d = decOf(f);
  if (f.unit === "usd" && d !== Infinity) { const e = -d, u = e >= 8 ? 9 : e >= 5 ? 6 : e >= 2 ? 3 : 0; return `to $${+(10 ** (e - u)).toPrecision(1)}${u ? " " + { 9: "billion", 6: "million", 3: "thousand" }[u] : ""}`; }
  if (/^(ratio|percent)$/.test(f.unit) && d !== Infinity) return `to ${+(10 ** (2 - d)).toPrecision(1)}%`;
  return "a whole number";
}
const precChip = f => isText(f) ? `as stated in the text, ${roundedText(f) ? "rounded " : ""}${precWords(f)}` : `as filed, ${precWords(f)}`;
// the rounded operands behind a calculated figure, and how far they can move its value (half a unit of each
// operand's last printed digit, carried through the formula by trying every corner)
const limitingOf = id => leavesOf(id).filter(l => limits(F[l]));
// "remaining performance obligations (as filed, to $0.1 billion)"; one label for several periods is named once
const limNames = (id, chip) => { const by = new Map(); limitingOf(id).forEach(l => { const k = F[l].label; by.has(k) ? by.get(k).push(l) : by.set(k, [l]); });
  return [...by].map(([k, ls]) => `${lc1(k)}${ls.length > 1 ? " at " + ls.map(l => F[l].period).join(" and ") : ""}${chip ? ` (${precChip(F[ls[0]])})` : ""}`); };
const nOf = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const andJoin = a => a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0] || "";
const JSOP = { "/": "/", "÷": "/", "*": "*", "×": "*", "-": "-", "−": "-", "+": "+" };
const valU = g => Number(shiftStr(g.value, SHIFT[g.scale] ?? 0));
const INT = {};
// the interval a calculated figure can lie in when an operand is rounded: each rounded operand moves by half a unit of
// its last printed digit, carried through the formula by trying every corner; null when no operand is rounded
function intOf(id) {
  if (id in INT) return INT[id];
  const g = F[id]; if (!g) return INT[id] = null;
  if (g.kind !== "calculated") { if (!limits(g)) return INT[id] = null; const v = valU(g), e = 0.5 * 10 ** -decOf(g); return INT[id] = [v - e, v + e]; }
  const toks = ftoks(g.formula), ins = [...new Set(toks.filter(t => F[t]))], iv = ins.map(intOf);
  if (!iv.some(Boolean) || toks.some(t => !F[t] && !JSOP[t] && !/^[\d.()]+$/.test(t))) return INT[id] = null;
  const ev = vals => Function(`return (${toks.map(t => F[t] ? `(${vals[t]})` : JSOP[t] || t).join(" ")})`)();
  const base = {}; ins.forEach(t => base[t] = valU(F[t]));
  const vary = ins.filter((t, i) => iv[i]); let lo = Infinity, hi = -Infinity;
  for (let m = 0; m < 1 << vary.length; m++) { const v = { ...base }; vary.forEach((t, i) => v[t] = intOf(t)[m >> i & 1]); const r = ev(v); lo = Math.min(lo, r); hi = Math.max(hi, r); }
  return INT[id] = [lo, hi];
}
const ivStr = f => intOf(f.id).map(x => x.toFixed(15));
// decimals (in plain units) a result built on rounded operands keeps: the most digits at which both ends of its
// interval round half-up to the same value; -Infinity when no digit agrees (the interval is shown instead)
const supDp = f => { const iv = f.kind === "calculated" && intOf(f.id); if (!iv) return null; const [lo, hi] = ivStr(f);
  for (let d = 15; d >= -15; d--) if (roundStr(lo, d, 0) === roundStr(hi, d, 0)) return d; return -Infinity; };
// display form of a limited result: digits both ends agree on, and the interval named two digits finer
function agreeView(f, style = "kpi") {
  const s = supDp(f); if (s == null) return null;
  const p = spec(f, style), d = s - p.k, [lo, hi] = ivStr(f), u = x => p.pre + (p.grp ? group(x) : x) + p.post;
  const rd = Math.max(0, (d < 0 ? p.dp : d) + 2), range = [lo, hi].map((x, i) => u(roundStr(x, p.k, rd, i ? 1 : -1))); // ends rounded outward
  const g = x => p.grp ? group(x) : x;
  return d < 0 ? { d, range, interval: p.pre + [lo, hi].map((x, i) => g(roundStr(x, p.k, 0, i ? 1 : -1))).join("–") + p.post } : { d, range, at: u(roundStr(f.value, p.k, d)) };
}
const DUP = { "×": "times", " million shares": "shares" }; // unit the prose already says right after the figure
function fmt(f, style = "prose", next = "") {
  if (!f) return "—";
  if (isDash(f)) return /^table|chart/.test(style) ? "—" : "— (nil)";
  if (showsAsPrinted(f) && style !== "chart") return f.shown; // text-sourced: the printed form, everywhere
  const p = spec(f, style);
  if (f.kind === "calculated") { const s = supDp(f); if (s != null && s - p.k < 0) return agreeView(f, style).interval; }
  let s = roundStr(f.value, p.k, dpFor(f, p)); const neg = s.startsWith("−"); if (neg) s = s.slice(1);
  if (p.grp) s = group(s);
  if (p.paren && (neg || parenPrinted(f))) return "(" + p.pre + s + (style === "table" ? "" : p.post) + ")";
  const post = DUP[p.post] && new RegExp("^\\s+" + DUP[p.post] + "\\b").test(next) ? p.post.replace(/×$|\s*shares$/, "") : p.post;
  return (neg ? "−" : p.sign && /[1-9]/.test(s) ? "+" : "") + p.pre + s + post;
}
// every digit is shown: a reported figure shows every digit the filing printed; a calculated one ends within the shown digits
const shownAll = (f, style) => { const p = spec(f, style), dp = dpFor(f, p); return f.kind === "calculated" ? supDp(f) == null && (shiftStr(f.value, p.k).split(".")[1] || "").length <= dp : printedDp(f, p) <= dp; };
const asFiled = f => f.unit === "usd_per_share" ? f.value : group(f.value.replace("-", ""));
const scaleName = f => f.unit === "usd" ? (f.scale === "units" ? "$" : "$ " + f.scale) : f.unit === "usd_per_share" ? "$ per share" : f.unit === "shares" ? (f.scale && f.scale !== "units" ? f.scale + " of shares" : "shares") : (f.unit || "").replace(/_/g, " ");
const digitsOf = v => v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
const num = (v, max = 12) => { const neg = v.startsWith("-"), [i, d] = v.replace("-", "").split("."); return (neg ? "−" : "") + group(i) + (d ? "." + (d.length > max ? d.slice(0, max) + "…" : d) : ""); };
function honesty(f) {
  if (f.kind !== "calculated") return isText(f) ? "As stated in the filing text" : "Exact · as filed";
  if (/^-?\d+$/.test(f.value)) return "Exact · integer arithmetic";
  return "Computed · rounded";
}
// the Exact detent in words: what the filing printed, how the display rounds it
function exactLine(f) {
  const p = spec(f, "kpi"), shown = fmt(f, "kpi"), where = stmt(f.source);
  const sup = f.kind !== "calculated" && printedDp(f, p), drop = sup - dpFor(f, p);
  const tail = shownAll(f, "kpi") ? "every printed digit is shown" : `${p.rule}, half-up: the last ${drop} printed digit${drop === 1 ? " is" : "s are"} dropped`;
  if (f.kind === "calculated") {
    const dol = s => f.unit === "usd" ? (s.startsWith("-") || s.startsWith("−") ? "−$" : "$") + s.replace(/^[-−]/, "") : s;
    if (/^-?\d+$/.test(f.value)) return `Exact value ${dol(num(f.value))} → shown as ${shown}${shownAll(f, "kpi") ? "" : `, ${p.rule}, half-up`}.`;
    const a = agreeView(f);
    if (a) { const lead = `Built on ${andJoin(limNames(f.id, true))}, so the result lies between ${a.range[0]} and ${a.range[1]}`;
      return a.d < 0 ? `${lead}; the two ends agree on no digit → shown as the interval ${shown}.` : `${lead}; both ends round to ${a.at} at ${a.d} decimal${a.d === 1 ? "" : "s"} → shown as ${shown}.`; }
    return `Full value ${dol(num(digitsOf(f.value), 12))} → shown as ${shown}.`;
  }
  if (isDash(f)) return `Printed as — in ${where}: nil. Shown as — (nil).`;
  if (roundedText(f)) return `Stated as “${printed(f)}” in ${where}, a rounded figure (${precWords(f)}). Shown as stated.`;
  if (showsAsPrinted(f)) return `Stated as “${printed(f)}” in ${where}. Shown as stated.`;
  if (isText(f)) return `Stated as ${printed(f)} in ${scaleName(f)} in ${where}. Shown as ${shown}, ${tail}.`;
  const pr = printed(f), asPrinted = /^(ratio|percent)$/.test(f.unit) ? (pr.includes("%") ? pr : pr + "%") : f.unit === "usd_per_share" ? "$" + pr.replace(/^\$/, "") : /^(usd|shares)$/.test(f.unit) && !/[a-z$]/i.test(pr) ? `${pr} in ${scaleName(f)}` : pr;
  const sign = parenPrinted(f) ? (/cash flow/.test(where) ? ": parentheses mark an outflow" : ": parentheses mark a deduction") : "";
  return `Printed as ${asPrinted} in ${where}${sign}. Shown as ${shown}, ${tail}.`;
}
const OPS = { "/": "÷", "-": "−", "*": "×", "+": "+", "÷": "÷", "×": "×", "−": "−" };
function ftoks(formula) {
  const out = [];
  for (let t of String(formula || "").trim().split(/\s+/)) {
    while (t.startsWith("(")) { out.push("("); t = t.slice(1); }
    let close = 0; while (t.endsWith(")") && !F[t] && !ASM[t]) { close++; t = t.slice(0, -1); }
    if (t) out.push(t); while (close-- > 0) out.push(")");
  }
  return out;
}
// one display scale per unit in every working line and in the Work detent: dollars in $ thousands (the filing's own
// scale), ratios in percent, shares as filed, counts as counts; each line names its scales
const DSC = g => g.unit === "usd" ? -3 : /^(ratio|points)$/.test(g.unit) ? 2 : g.unit === "shares" ? -(SHIFT[g.scale] ?? 0) : 0;
const DPOST = { ratio: "%", percent: "%", points: " pp", multiple: "×" };
const dscName = g => g.unit === "usd" ? "in $ thousands" : /^(ratio|percent)$/.test(g.unit) ? "in percent" : g.unit === "points" ? "in percentage points" : g.unit === "shares" ? (g.scale && g.scale !== "units" ? "in thousands of shares" : "in shares") : g.unit === "usd_per_share" ? "in $ per share" : g.unit === "multiple" ? "in times" : "as counts";
function scaleLine(f) {
  const ops = [...new Set(f.inputs.filter(i => F[i]).map(i => limits(F[i]) && !roundedText(F[i]) ? "as filed" : dscName(F[i])))], res = dscName(f);
  return ops.length === 1 && ops[0] === res ? res : `operands ${andJoin(ops)}; result ${res}`;
}
// a value at its display scale: exact digits, a negative in parentheses so "−" never doubles
function dval(g, v = g.value, max = 10) {
  const x = g.unit === "usd_per_share" ? v : shiftStr(v, (SHIFT[g.scale] ?? 0) + DSC(g)), neg = x.startsWith("-"), s = num(digitsOf(x.replace("-", "")), max) + (DPOST[g.unit] || "");
  return neg ? `(−${s})` : s;
}
// an operand at its display scale names its unit: "$4,475,446 thousand", "2,565,197 thousand shares", "954 (count)"
const unitOf = (g, s) => { const [, n = "", x, c = ""] = s.match(/^(\(−)?(.*?)(\))?$/);
  return g.unit === "usd" ? `${n}$${x} thousand${c}` : g.unit === "usd_per_share" ? `${n}$${x}${c} per share` : g.unit === "shares" ? s + (g.scale && g.scale !== "units" ? " thousand shares" : " shares") : g.unit === "count" ? s + " (count)" : s; };
function operandView(f) {
  const ins = f.inputs.map(i => F[i]).filter(Boolean), anyText = ins.some(roundedText), anyCalc = ins.some(g => g.kind === "calculated");
  // an operand the filing rounds prints as filed ("$4.1 billion"), never padded with zeros to the line's scale
  const show = g => limits(g) && !roundedText(g) ? printed(g) : roundedText(g) ? `${unitOf(g, dval(g))} (stated “${printed(g)}”)` : unitOf(g, dval(g));
  const kind = g => g.kind === "calculated" ? "computed" : isCoarse(g) ? precChip(g) : "as filed";
  const exact = /^-?\d+$/.test(f.value);
  const lim = limNames(f.id), many = limitingOf(f.id).length > 1;
  const av = agreeView(f);
  const result = exact ? dval(f, f.value, 14).replace(/^\((.*)\)$/, "$1") : av ? (av.d < 0 ? av.interval : av.at) : dval(f, f.value, 12).replace(/^\((.*)\)$/, "$1");
  const opsNote = anyText ? "from operands that include rounded figures as stated" : anyCalc ? "from operands as filed and computed" : "from operands as filed";
  const ends = (digitsOf(f.value).split(".")[1] || "").length < 20;
  const note = exact ? `Exact integer result ${opsNote}.`
    : av ? `Decimal arithmetic on the operands; ${andJoin(lim)} ${many ? "are" : "is"} rounded in the filing, so the result lies between ${av.range[0]} and ${av.range[1]}${av.d < 0 ? "; no digit agrees at both ends, so the interval is shown" : `; it is kept to the ${av.d} decimal${av.d === 1 ? "" : "s"} at which both ends agree`}.`
    : ends ? "Decimal arithmetic on the operands; the result is rounded for display." : "Decimal arithmetic on the operands; the result does not end, so it is rounded for display.";
  return { show, kind, result, exact, note, scale: scaleLine(f), range: av && av.range };
}
const leavesOf = id => { const out = [], walk = x => { const g = F[x]; if (!g) return; if (g.kind !== "calculated") { out.includes(x) || out.push(x); } else g.inputs.forEach(walk); }; walk(id); return out; };
// highlight colours: one hue per meaning in every open panel (reported in the filing / calculated by code), the same hue as the
// body's markers for those meanings. Each highlighted number names its meaning on demand: a title for the pointer, and a description
// (aria-describedby to one hidden sentence per meaning) for assistive tech, so the quoted text itself stays verbatim. The labels
// that already name the meanings (Working / Filing, the Probe's kind badge, an answer's meta line) carry the swatch: the key
const hlK = f => f && f.kind === "calculated" ? "hc" : "hq";
const hlT = f => f.kind === "calculated" ? "Calculated by code" : "Reported in the filing" + (SRC[f.source] ? " · " + SRC[f.source].locator : "");
const hlA = (f, cls = "") => `class="${cls ? cls + " " : ""}${hlK(f)}" title="${esc(hlT(f))}" aria-describedby="hlD-${hlK(f).slice(1)}"`;
const SW = k => `<i class="sw ${k}" aria-hidden="true"></i>`;
// the key to the highlight colours a panel shows (hq / hc, a cited figure or a source tag in its markup), for the panel's fixed
// header: in sight at any scroll position of the panel
const KEYRX = { c: /[" ]hc"|class="fig c /, q: /[" ]hq"|class="fig  |class="stag"/ };
const keyHTML = html => { const ks = ["c", "q"].filter(x => KEYRX[x].test(html));
  return ks.length ? `<span class="ukey">${ks.map(x => `<span class="key">${SW(x)}${x === "c" ? "calculated" : "reported"}</span>`).join(" ")}</span>` : ""; };
function markQuote(sid, ids) { // mark a figure only where it occurs exactly once in the line; never guess
  const q = SRC[sid].quote, marks = [];
  for (const id of ids) {
    const s = printed(F[id]); let at = -1, n = 0, i = -1;
    const D = c => /\d/.test(c || ""), part = (c, far) => D(c) || /[,.]/.test(c || "") && D(far); // a digit, or a separator inside a number
    while ((i = q.indexOf(s, i + 1)) !== -1) if (!part(q[i - 1], q[i - 2]) && !part(q[i + s.length], q[i + s.length + 1])) { at = i; n++; }
    if (n === 1) marks.push({ at, len: s.length, id });
  }
  marks.sort((a, b) => a.at - b.at);
  // a table line's leading line-item name (the words before at least two numeric cells) is a key word; prose quotes have none (words
  // that end in a month, "As of December 31, 2025, ...", start a sentence with a date, not a table line)
  let html = "", p = 0; const nm = q.match(/^(\D+?)\s+(?=(?:[$(]?\s?[\d,.]+\)?\s?%?|[$%—–])\s+(?:[$(]?\s?[\d,.]+\)?\s?%?|[$%—–])(?:\s|$))/);
  // a reconciling line keeps its sign word ("Add: employer payroll taxes ...", "Less: ..."): the colon after it is no sentence
  if (nm && !/[.;:]\s/.test(nm[1].replace(/^(?:Add|Less|Plus|Minus|Deduct|Excluding|Including|Net of):\s+/i, "")) && !/(January|February|March|April|May|June|July|August|September|October|November|December)$/.test(nm[1])) { html = `<span class="kw">${esc(nm[1])}</span>`; p = nm[1].length; }
  for (const m of marks) { if (m.at < p) continue; html += esc(q.slice(p, m.at)) + `<mark data-f="${esc(m.id)}" ${hlA(F[m.id])}>${esc(q.slice(m.at, m.at + m.len))}</mark>`; p = m.at + m.len; }
  return html + esc(q.slice(p));
}

/* ================= state ================= */
let S;
const JOB = { t: 770, state: "ready", speed: 30, last: 0, drawnAt: [], seen: null, confirmStop: false };
const T = { read: 70, collect: 260, write: 640, check: 720, review: 770 };
const STEPS = [
  { id: "read", name: "Read the filing", d: "Athena reads the 10-K and finds the passages it will quote." },
  { id: "collect", name: "Collect the facts", d: "Linked figures come from the filing: tagged numbers where they exist, otherwise quoted text." },
  { id: "write", name: "Write the report", d: "One chapter at a time, citing only collected facts." },
  { id: "check", name: "Check numbers and sources", d: "Code re-checks each linked figure against its filing line." },
  { id: "review", name: "Review", d: "A separate reviewer reads each chapter; Athena settles each note." },
  { id: "ready", name: "Ready", d: "Shared edition R1 is saved; every later reader opens it at once." },
];
function freshState() {
  return {
    route: "home", sheet: "summary", view: 1, latest: 1, docs: { 1: clone(DOC) }, conv: false, convFilter: "all",
    panel: [], threads: [], seq: 0, price: "", pencil: null, inks: {}, changed: null, focusSector: null, sel: null,
    newOpen: false, newForm: { co: "PLTR", form: "10-K", fy: "FY2025", lang: "en" }, libFilter: "all", libQ: "", homeAns: null,
    clock: [14, 2], index: false, slip: null, panelFull: false, tray: false, trayProbe: false, st: null, unfold: null,
  };
}
const docV = () => S.docs[S.view];
// the static prototype runs on a demo clock; app mode stamps the reader's local time, since the stamp is stored with the memo
const now = (d = new Date()) => { if (APP) return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const [h, m] = S.clock; S.clock = [h + Math.floor((m + 1) / 60), (m + 1) % 60]; return pad2(h) + ":" + pad2(m); };
const threadById = id => S.threads.find(t => t.id === id);
const sheetIds = () => ["summary", ...docV().sections.map(s => s.id), "glossary", "references"];
function sheetTitle(id, short) {
  if (id === "summary") return "Summary"; if (id === "glossary") return "Glossary"; if (id === "references") return "References";
  const s = secById(docV(), id) || secById(DOC, id); return s ? (short ? s.title : secNum(s) + " " + s.title) : "Whole report";
}

/* ================= inline rendering ================= */
// The Probe carries the period; prose, gauges and tables never glue a period chip to a figure.
function figHTML(id, style = "prose", cls = "", next = "") {
  const f = F[id]; if (!f) return `<span class="muted" title="Figure ${esc(id)} is not in the data">—</span>`;
  const v = fmt(f, style, next);
  return `<button type="button" class="fig ${f.kind === "calculated" ? "c" : ""} ${cls}" data-fact="${esc(id)}" title="${esc(hlT(f))}" aria-label="${esc(f.label + ", " + f.period + ", " + v + ", " + (f.kind === "calculated" ? "calculated" : "quoted from the filing"))}">${esc(v)}</button>`;
}
// consecutive source markers become one chip per statement or note, named, not "Item 8 Item 8 Item 8"
function srcTags(ids) {
  const by = new Map(); ids.filter(id => SRC[id]).forEach(id => { const k = stmt(id, true); by.has(k) ? by.get(k).push(id) : by.set(k, [id]); });
  return [...by].map(([k, v]) => `<button type="button" class="stag" data-act="src" data-src="${esc(v[0])}" title="${esc(v.map(i => SRC[i].locator + " · " + SRC[i].label).join("\n"))}\nOpen in References">${esc(k)}${v.length > 1 ? ` <span aria-hidden="true">×${v.length}</span>` : ""}</button>`).join(" ");
}
const srcTag = id => srcTags([id]);
const SRCRUN = /(?:\s*\[src-[\w-]+\])+/g;
const facts = (t, fn) => t.replace(TOKRE, (m, id, off, str) => fn(id, str.slice(off + m.length, off + m.length + 24)));
const inline = t => facts(esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>"), (id, next) => figHTML(id, "prose", "", next)).replace(SRCRUN, m => " " + srcTags(m.match(/src-[\w-]+/g)));
const plain = t => facts(String(t || ""), (id, next) => F[id] ? fmt(F[id], "prose", next) : "—").replace(SRCRUN, "").replace(/\*\*/g, "");
// Ask may repeat a linked figure in digits beside its link: show it once. The number check still reads m.numbers.
const undouble = t => String(t || "").replace(/(\{fact:[^}]+\})\s*\(([^()]+)\)/g, (m, k, d) => plain(k) === d.trim() ? k : m).replace(/(\$?[\d.,]+%?(?: (?:million|billion))?)\s*\((\{fact:[^}]+\})\)/g, (m, d, k) => plain(k) === d.trim() ? k : m);
const plainHTML = t => esc(plain(t));
function words(t) { return t.match(/\{fact:[^}]+\}|\[src-[\w-]+\]|\*\*|[^\s{[*.,;:]+|[.,;:]|\s+/g) || []; }
function diffWords(a, b) {
  const A = words(a), B = words(b), n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  const push = (k, t) => { const l = out[out.length - 1]; l && l.k === k ? l.t += t : out.push({ k, t }); };
  while (i < n && j < m) { if (A[i] === B[j]) { push("=", A[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) push("-", A[i++]); else push("+", B[j++]); }
  while (i < n) push("-", A[i++]); while (j < m) push("+", B[j++]);
  return out;
}
const diffHTML = (a, b, ins, del) => diffWords(a, b).map(p => p.k === "=" ? inline(p.t) : /^\s+$/.test(p.t) ? p.t : p.k === "+" ? `<span class="${ins}">${inline(p.t)}</span>` : del ? `<span class="${del}">${inline(p.t)}</span>` : "").join("");

/* ================= rosette: sectors = chapters, rings = that chapter's figures ================= */
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function sizeCanvas(c, px) { const d = Math.min(devicePixelRatio || 1, 2); c.width = Math.round(px * d); c.height = Math.round(px * d); const x = c.getContext("2d"); x.setTransform(d, 0, 0, d, 0, 0); return x; }
function roseModel(doc) {
  return doc.sections.map((s, i) => { const ids = sectionFacts(s), q = ids.filter(id => F[id].kind !== "calculated"), c = ids.filter(id => F[id].kind === "calculated"); return { s, i, ids: [...q, ...c], nq: q.length }; });
}
function ringP(f) { // deterministic from the figure: lobes from its year, swing from its size, modulation and phase from its digits
  const d = f.value.replace(/\D/g, "").replace(/^0+/, "") || "0"; let ds = 0; for (const c of d) ds += +c;
  const y = /(\d{4})/.exec(String(f.period || "")), k = y ? 3 + (+y[1] % 4) : 5;
  const v = Math.abs(Number(f.value)) || 0;
  let mag = f.unit === "usd" || f.unit === "shares" ? (Math.log10(Math.max(1, Number(absDollars({ ...f, value: f.value.split(".")[0] || "0" })))) - 6) / 4
    : f.unit === "usd_per_share" ? .15 + Math.min(1, v / 3) : /ratio|points|percent/.test(f.unit) ? Math.sqrt(Math.min(v, 3) / 3) : .5;
  return { k, k2: 2 + ds % 5, ph: (parseInt(d.slice(0, 4), 10) / 1e4) * Math.PI * 2, ph0: (ds % 7) / 7 * Math.PI * 2, mag: clamp(mag, .08, 1), calc: f.kind === "calculated" };
}
function roseGeom(px, M, small) {
  const n = M.length || 1, step = 2 * Math.PI / n, gap = step * (small ? .16 : .12);
  const r0 = px * (small ? .2 : .19), rMax = px * (small ? .47 : .405);
  const maxN = Math.max(6, ...M.map(m => m.ids.length));
  return { c: px / 2, n, step, gap, r0, rMax, sp: (rMax - r0) / maxN, a0: i => -Math.PI / 2 + i * step + gap / 2, a1: i => -Math.PI / 2 + (i + 1) * step - gap / 2 };
}
function strokeRing(x, G, i, k, f, lw, small) {
  const p = ringP(f), R = G.r0 + (k + .5) * G.sp, amp = G.sp * (.3 + .85 * p.mag), a0 = G.a0(i), a1 = G.a1(i), N = small ? 40 : 110;
  const dense = G.sp < 3, copies = small || dense ? 1 : p.calc ? 2 : 3, strands = p.calc && !small ? (dense ? [-.45, .45] : [-.8, .8]) : [0];
  x.lineWidth = dense && !small && lw < .7 ? .4 : lw; // pencil (>= .7) keeps its weight
  for (let j = 0; j < copies; j++) for (const dr of strands) {
    x.beginPath();
    for (let s = 0; s <= N; s++) {
      const u = s / N, t = a0 + u * (a1 - a0), env = Math.sin(Math.PI * u) ** .6;
      const r = R + dr + amp * env * Math.sin(2 * Math.PI * p.k * u * .5 + j * 2 * Math.PI / copies + p.ph0) + amp * .22 * env * Math.sin(2 * Math.PI * p.k2 * u + p.ph);
      const X = G.c + r * Math.cos(t), Y = G.c + r * Math.sin(t); s ? x.lineTo(X, Y) : x.moveTo(X, Y);
    }
    x.stroke();
  }
}
// o: written (sectors), drawnAt[], facts (collected), rim (sources read), inked (sectors), review, rev, hi, ring, small, skeleton, at
function drawRose(cv, px, M, o = {}) {
  const x = sizeCanvas(cv, px), small = o.small ?? px < 160, G = roseGeom(px, M, small), at = o.at ?? performance.now();
  const ink1 = cssv("--ink-1"), ink3 = cssv("--ink-3"), line = cssv("--line-strong"), pencil = cssv("--pencil"), accent = cssv("--accent");
  const g = x.createLinearGradient(0, 0, px, px); g.addColorStop(0, cssv("--iris-a")); g.addColorStop(.55, cssv("--iris-b")); g.addColorStop(1, cssv("--iris-c"));
  const written = o.written ?? M.length, inked = o.inked ?? M.length, nFacts = DOC.facts.length;
  let animating = false;
  x.lineCap = "round";
  // sector bases: one hairline arc per chapter
  x.strokeStyle = line; x.lineWidth = small ? .6 : .7;
  for (let i = 0; i < G.n; i++) { x.setLineDash(!o.skeleton && M[i] && M[i].s.absent ? [1, 3] : []); x.beginPath(); x.arc(G.c, G.c, G.r0 - (small ? 2 : 4), G.a0(i), G.a1(i)); x.stroke(); }
  x.setLineDash([]);
  if (o.hi != null && M[o.hi]) { // focused sector: a faint wedge wash
    x.fillStyle = cssv("--wash"); x.beginPath(); x.arc(G.c, G.c, G.rMax + 6, G.a0(o.hi) - G.gap / 2, G.a1(o.hi) + G.gap / 2); x.arc(G.c, G.c, G.r0 - 8, G.a1(o.hi) + G.gap / 2, G.a0(o.hi) - G.gap / 2, true); x.closePath(); x.fill();
  }
  // rings
  for (const m of M) {
    // skeleton (a sample card with no figures): written sectors as three dashed rings in ink, the rest one hairline
    if (o.skeleton) { const w = m.i < written; x.setLineDash(w ? [3, 3] : [1, 3]); x.strokeStyle = w ? ink3 : line; x.lineWidth = w ? 1.3 : .8;
      for (let k = 1; k <= (w ? 3 : 1); k++) { x.beginPath(); x.arc(G.c, G.c, G.r0 + (G.rMax - G.r0) * k / 4, G.a0(m.i), G.a1(m.i)); x.stroke(); } x.setLineDash([]); continue; }
    if (m.i >= written || m.s.absent) continue;
    if (!m.ids.length) { x.setLineDash([2, 3]); x.strokeStyle = line; x.lineWidth = .8; x.beginPath(); x.arc(G.c, G.c, G.r0 + G.sp * .6, G.a0(m.i), G.a1(m.i)); x.stroke(); x.setLineDash([]); continue; }
    let upto = m.ids.length;
    const t0 = o.drawnAt && o.drawnAt[m.i];
    if (t0 && !RM.matches) { const fr = clamp((at - t0) / 700); upto = Math.ceil(fr * m.ids.length); if (fr < 1) animating = true; }
    const isHi = o.hi === m.i;
    x.strokeStyle = m.i < inked ? (isHi ? accent : g) : pencil;
    x.globalAlpha = o.hi != null && !isHi ? .45 : 1;
    const lw = isHi ? .8 : px >= 360 ? .5 : small ? .55 : .45, lwP = m.i < inked ? lw : Math.max(lw, small ? .7 : .8); // pencil strokes stay readable before ink
    for (let k = 0; k < upto; k++) strokeRing(x, G, m.i, k, F[m.ids[k]], lwP, small);
    x.globalAlpha = 1;
    if (o.ring) { const k = m.ids.indexOf(o.ring); if (k >= 0 && k < upto) { x.strokeStyle = accent; strokeRing(x, G, m.i, k, F[o.ring], 1.5, small); } }
  }
  if (!small) {
    // index ring: one tick per fact collected
    const facts = o.facts ?? nFacts, rI = px * .158;
    x.strokeStyle = ink3; x.lineWidth = .6;
    for (let k = 0; k < facts; k++) { const t = -Math.PI / 2 + k / nFacts * 2 * Math.PI, f = DOC.facts[k], len = f && f.kind === "calculated" ? 2.5 : 4.5; x.beginPath(); x.moveTo(G.c + rI * Math.cos(t), G.c + rI * Math.sin(t)); x.lineTo(G.c + (rI + len) * Math.cos(t), G.c + (rI + len) * Math.sin(t)); x.stroke(); }
    // chapter numbers
    x.font = `500 ${Math.max(8, px * .024)}px "Athena Mono", monospace`; x.textAlign = "center"; x.textBaseline = "middle";
    for (const m of M) { const t = (G.a0(m.i) + G.a1(m.i)) / 2, r = px * .43; x.fillStyle = o.hi === m.i ? accent : m.i < written && !m.s.absent ? ink3 : line; x.fillText(secNum(m.s), G.c + r * Math.cos(t), G.c + r * Math.sin(t)); }
    // rim: the filing's own lines in microtext, one slot per source, filled as the filing is read
    const rR = px * .468, fs = Math.max(4, px * .0105), cw = fs * .6, cap = Math.floor(2 * Math.PI * rR / cw), nS = DOC.sources.length;
    const per = Math.max(8, Math.floor(cap / Math.max(1, nS))), readS = Math.round((o.rim ?? 1) * nS);
    x.font = `400 ${fs}px "Athena Mono", monospace`; x.fillStyle = ink3; x.textBaseline = "alphabetic";
    if (px >= 220) {
      let pos = 0;
      for (let si = 0; si < nS && pos < cap; si++) {
        const txt = (DOC.sources[si].quote + " · ").toUpperCase().slice(0, per).padEnd(per, " ");
        if (si < readS) for (let c = 0; c < txt.length && pos + c < cap; c++) { const t = -Math.PI / 2 + (pos + c + .5) * cw / rR; x.save(); x.translate(G.c + rR * Math.cos(t), G.c + rR * Math.sin(t)); x.rotate(t + Math.PI / 2); x.fillText(txt[c], 0, 0); x.restore(); }
        pos += per;
      }
    } else { x.strokeStyle = ink3; for (let si = 0; si < readS; si++) { const t = -Math.PI / 2 + si / nS * 2 * Math.PI; x.beginPath(); x.moveTo(G.c + rR * Math.cos(t), G.c + rR * Math.sin(t)); x.lineTo(G.c + (rR + 3) * Math.cos(t), G.c + (rR + 3) * Math.sin(t)); x.stroke(); } }
    // outer double rule once review is done
    x.strokeStyle = o.review === false ? line : ink1; x.lineWidth = .7; x.setLineDash(o.review === false ? [2, 4] : []);
    x.beginPath(); x.arc(G.c, G.c, px * .492, 0, 2 * Math.PI); x.stroke();
    if (o.review !== false) { x.beginPath(); x.arc(G.c, G.c, px * .486, 0, 2 * Math.PI); x.stroke(); }
    x.setLineDash([]);
    // centre: ticker, year and the revision number once there is one
    const rC = px * .135; x.strokeStyle = ink3; x.lineWidth = .6; x.beginPath(); x.arc(G.c, G.c, rC, 0, 2 * Math.PI); x.stroke();
    x.fillStyle = ink1; x.textAlign = "center"; x.textBaseline = "middle";
    x.font = `500 ${px * .05}px Newsreader, serif`; x.fillText((FIL.ticker || "").split("").join(" "), G.c, G.c - px * .03);
    x.font = `600 ${px * .02}px Manrope, sans-serif`; x.fillStyle = ink3; x.fillText(`${FIL.form} · FY${FY}`, G.c, G.c + px * .012);
    if (o.rev) { x.font = `500 ${px * .034}px "Athena Mono", monospace`; x.fillStyle = accent; x.fillText("R" + o.rev, G.c, G.c + px * .058); }
  } else if (o.rev) {
    x.strokeStyle = ink3; x.lineWidth = .6; x.beginPath(); x.arc(G.c, G.c, px * .12, 0, 2 * Math.PI); x.stroke();
  }
  return { G, animating };
}
// one shared driver for every rosette on screen; animations run only while a sector is engraving
const ROSES = new Map(); let roseRAF = 0;
function rose(cv, px, Mfn, ofn) { ROSES.set(cv, { px, Mfn, ofn }); paintRose(cv); }
function paintRose(cv) { const r = ROSES.get(cv); if (!r || !cv.isConnected) { ROSES.delete(cv); return false; } return drawRose(cv, r.px, r.Mfn(), r.ofn()).animating; }
function paintRoses() { let anim = false; for (const cv of [...ROSES.keys()]) anim = paintRose(cv) || anim; if (anim && !roseRAF) roseRAF = requestAnimationFrame(() => { roseRAF = 0; paintRoses(); }); }

/* ================= the writing job (simulated; each visual change = one backend event) ================= */
function prog(t = JOB.t) {
  const nS = DOC.sources.length, nF = DOC.facts.length, nC = HAVE.length;
  // chN and revN count the chapters written and through review; ch and rev are positions in the chapter list (sectors), the
  // same numbers unless the edition is partial: then the replay skips the chapters not in it
  const at = k => k ? DOC.sections.indexOf(HAVE[k - 1]) + 1 : 0;
  const p = {
    src: Math.round(nS * clamp(t / T.read)), facts: Math.round(nF * clamp((t - T.read) / (T.collect - T.read))),
    chN: Math.floor(nC * clamp((t - T.collect) / (T.write - T.collect)) + 1e-9), chk: Math.round(nF * clamp((t - T.write) / (T.check - T.write))),
    revN: Math.floor(nC * clamp((t - T.check) / (T.review - T.check)) + 1e-9), ready: t >= T.review,
  };
  p.ch = at(p.chN); p.rev = at(p.revN);
  p.step = p.ready ? 5 : t < T.read ? 0 : t < T.collect ? 1 : t < T.write ? 2 : t < T.check ? 3 : 4;
  // a chapter is inked when every figure it cites has been checked (in report order)
  let acc = 0; p.inked = 0;
  if (t >= T.write) for (const m of roseModel(DOC)) { acc += m.ids.length; if (acc <= p.chk) p.inked++; else break; }
  return p;
}
const jobRoseOpts = () => { const p = prog(); return { written: p.ch, drawnAt: JOB.drawnAt, facts: p.facts, rim: p.src / Math.max(1, DOC.sources.length), inked: p.step >= 3 ? p.inked : 0, review: p.ready ? true : false, rev: p.ready ? 1 : null }; };
function setJob(t, state) {
  JOB.t = t; JOB.state = state || (t >= T.review ? "ready" : "running"); JOB.last = performance.now(); JOB.drawnAt = []; JOB.seen = prog(); JOB.confirmStop = false;
}
setInterval(() => {
  if (JOB.state !== "running") return;
  const n = performance.now(); JOB.t = Math.min(T.review, JOB.t + (n - JOB.last) / 1000 * JOB.speed); JOB.last = n;
  const p = prog();
  if (JOB.seen && p.ch > JOB.seen.ch) for (let i = JOB.seen.ch; i < p.ch; i++) JOB.drawnAt[i] = n; // event: section_written
  const changed = !JOB.seen || ["src", "facts", "ch", "chk", "rev", "step"].some(k => p[k] !== JOB.seen[k]);
  if (p.ready) { JOB.state = "ready"; { if (edShow()) live("The shared edition is ready."); else if (!APP) live("The sample draft is written. It is held as review required."); } }
  JOB.seen = p;
  updateJobViews(changed);
}, 200);

/* ================= icons ================= */
const IC = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V21H3z"/></svg>',
  lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h5v16H4zM10 4h5v16h-5zM16 5l4 1-3 14-4-1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  conv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m6 15 6-6 6 6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>',
};

/* ================= shell ================= */
const PLACE = { home: "Home", library: "Library", writing: "the writing page", desk: "the report", settings: "Settings", developer: "Developer", essay: "Essay", markets: "Markets" };
// where the reader came from: the Desk's back button and the writing page's way out return there
function setRoute(r) {
  if (S.route !== r) { if (r === "desk") S.deskFrom = S.route; if (r === "writing") S.wrFrom = S.route === "desk" || S.route === "writing" ? "home" : S.route; }
  S.route = r;
}
const NAV = [["home", "Home"], ["library", "Library"], ["markets", "Markets"], ["developer", "Developer"], ["settings", "Settings"]];
const LATER = new Set(["markets"]); // in the navigation with its "later" tag
const NAVIC = { home: IC.home, library: IC.lib, settings: IC.set,
  markets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18M4 16l5-5 4 3 7-8"/></svg>',
  developer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>' };
const revWord = () => S.latest > 1 ? `Your Rev ${S.latest} · private` : `Shared R1 · ${edShow() ? "ready" : edWords().toLowerCase()}`;
function jobLine() { const p = prog(); return JOB.state === "ready" ? revWord() : JOB.state === "stopped" ? `Stopped at ${STEPS[p.step].name}` : `Writing · step ${p.step + 1} of 6`; }
function renderSide() {
  const cur = S.route === "essay" ? "developer" : S.route;
  // between 900 and 1219 px the sidebar folds to an icon rail (CSS) so the reading column keeps its measure; icons show only there.
  // In the rail every control keeps its name: the wordmark says where it goes, Markets keeps its "later" and the notice stays
  $("#side").innerHTML = `<a class="wordmark" href="#" data-go="home" aria-label="Athena home"><span class="lg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><circle cx="12" cy="12" r="11.2"/><path d="M15.17 12.91Q22.14 22.5 12.8 15.2Q7.98 26.03 9.63 14.29Q-2.17 15.53 8.83 11.09Q1.86 1.5 11.2 8.8Q16.02 -2.03 14.37 9.71Q26.17 8.47 15.17 12.91Z"/></svg></span><span class="wm1">A</span><span class="wm2">thena</span></a>
    <button class="btn primary new" data-act="new" title="New report${LJ.off ? " · later" : ""}">${IC.plus.replace("<svg", '<svg width="16" height="16"')}<span class="nl"> New report</span>${laterTag()}</button>
    <nav class="nav" aria-label="Main">${NAV.map(([id, l]) => `<a href="#" data-go="${id}" ${cur === id ? 'aria-current="page"' : ""} title="${l}${LATER.has(id) ? " · later" : ""}"><span class="ni" aria-hidden="true">${NAVIC[id]}</span><span class="nl">${l}</span>${LATER.has(id) ? '<span class="later">later</span>' : ""}</a>${id === "library" ? runsNavHTML("ni") : ""}`).join("")}</nav>
    <h2>Open reports</h2>
    <div class="open"><a href="#" data-go="${JOB.state === "ready" ? "desk" : "writing"}" ${cur === "desk" || cur === "writing" ? 'aria-current="page"' : ""} title="${esc(shortIssuer())} · FY${FY}"><canvas id="sideRose" aria-hidden="true"></canvas><b>${esc(shortIssuer())} · FY${FY}</b><small id="sideJob">${esc(jobLine())}</small></a></div>
    <div class="foot">Prototype · ${APP ? aiTag() : "AI text is sample text"}<span class="dt"> · Demo timing</span><span class="nia">Not investment advice.</span></div>`;
  rose($("#sideRose"), 28, () => roseModel(docV()), () => JOB.state === "ready" ? { small: true } : { ...jobRoseOpts(), small: true });
  $("#tabbar").innerHTML = [["home", "Home", IC.home], ["library", "Library", IC.lib], ["new", "New", IC.plus], ["settings", "Settings", IC.set]].map(([id, l, ic]) =>
    `<a href="#" ${id === "new" ? 'data-act="new"' : `data-go="${id}"`} ${cur === id ? 'aria-current="page"' : ""}>${ic}<span>${l}${id === "new" ? laterTag() : ""}</span></a>${id === "library" ? runsNavHTML() : ""}`).join("") + `<a href="#" data-act="demoopen" aria-haspopup="true"><span class="dm">▦</span><span>Demo</span></a>`;
}
const shortIssuer = () => FIL.issuer.replace(/,? Inc\.?$| Corporation$| Corp\.?$/, "").replace(/ Technologies$/, "");
function render() {
  document.body.classList.toggle("indesk", S.route === "desk"); padTop();
  renderSide();
  const m = $("#main");
  ROSES.forEach((_, cv) => { if (!cv.isConnected) ROSES.delete(cv); });
  if (S.route === "home") m.innerHTML = homeHTML();
  else if (S.route === "library") m.innerHTML = libraryHTML();
  else if (S.route === "writing") m.innerHTML = APP && S.liveJob ? liveWritingHTML() : writingHTML();
  else if (S.route === "developer") m.innerHTML = developerHTML();
  else if (S.route === "essay") m.innerHTML = essayHTML();
  else if (S.route === "settings") m.innerHTML = settingsHTML();
  else if (S.route === "markets") m.innerHTML = marketsHTML();
  else if (S.route === "desk") m.innerHTML = deskHTML();
  const pad = $(".page-pad", m); if (pad) pad.insertAdjacentHTML("beforeend", SITEFOOT);
  m.insertAdjacentHTML("beforeend", '<p class="nia nia-m">Not investment advice.</p>'); // the sidebar is hidden on a phone: this line is shown only there (display:none keeps one copy for a screen reader)
  afterRender();
  renderLayer();
}
// the address keeps the current place, so a reload returns to it. A move to another place (route, sheet or the Conversation
// view) adds a history entry, so Back and Forward follow the reader's moves; the first write, a redraw of the same place, a
// theme change and a place reached from the address itself replace the entry (pushState and replaceState fire no hashchange)
let HASH = null, BYHASH = false; // the address last written or applied; true while Back, Forward or a typed address is applied
function writeHash() {
  const at = S.route === "desk" ? "desk/" + S.sheet + (S.conv ? "/conversation" : "") : S.route === "writing" && APP && S.liveJob ? "writing/" + S.liveJob : S.route === "essay" ? "developer/essay" : S.route, th = S.theme === "light" || S.theme === "dark" ? "&theme=" + S.theme : "", h = "#at=" + at + th;
  if (location.hash !== h) try { history[HASH === null || BYHASH || (parseHash().at || "") === at ? "replaceState" : "pushState"](null, "", h); } catch (_) { /* file: URLs in some browsers */ }
  HASH = location.hash;
  setTitle();
}
// the tab's title names the place, so tabs, history and screen readers tell them apart; in app mode it leads
// with the count of ended runs not yet seen, "(1) Report ready · …"
function setTitle() {
  const n = APP ? unseenRuns().length : 0, ok = n && unseenRuns().every(r => r.told === "ready");
  document.title = (n ? `(${n}) ${ok ? (n > 1 ? "Reports ready" : "Report ready") : n > 1 ? "Runs ended" : "Run ended"} · ` : "") + (S.route === "desk" ? `${S.conv ? "Conversation" : sheetTitle(S.sheet)} · ${shortIssuer()} ${FIL.form} FY${FY}` : S.route === "writing" ? "Writing" : PLACE[S.route] || "Home") + " · Athena";
}
function afterRender() {
  writeHash();
  if (S.route === "home") { const c = $("#jobRose"); c && rose(c, 96, () => roseModel(DOC), () => JOB.state === "ready" ? { skeleton: true, written: 6, small: true } : jobRoseOpts()); $$("canvas[data-rc]").forEach(c => rose(c, 72, () => roseModel(docV()), () => ({ rev: S.latest }))); }
  if (S.route === "library") libraryAfter();
  if (S.route === "writing" && $("#wrRose")) rose($("#wrRose"), Math.min(520, $("#wrRose").parentElement.clientWidth || 520), () => roseModel(DOC), jobRoseOpts);
  if (S.route === "desk") { renderSheet(); renderTabs(); renderPanel(); }
  paintRoses(); paintBell();
}
function updateJobViews(changed) {
  const sj = $("#sideJob"); if (sj) sj.textContent = jobLine();
  if (S.route === "writing" && changed) { const st = $("#wrSteps"); if (st) { st.outerHTML = stepsHTML(); $("#wrHead").innerHTML = wrHeadHTML(); } const sf = $("#wrSoFar"), p = prog(); if (sf && sf.dataset.n !== `${p.ch}:${p.step >= 3 ? p.inked : 0}`) sf.outerHTML = soFarHTML(); const qm = $("#qsMark"); if (qm) qm.innerHTML = qsChecked() ? "" : CHK; }
  if (S.route === "writing") { const tm = $("#wrTime"); if (tm) tm.textContent = mmss(JOB.t); }
  if (S.route === "home" && changed) { const j = $("#jobCard"); if (j) { j.innerHTML = jobCardHTML(); afterRender(); } }
  if (S.route === "library" && changed) { const s = $("#pltrStatus"); if (s) s.innerHTML = pltrStatusHTML(); }
  if (changed || JOB.drawnAt.length) paintRoses();
  if (JOB.state === "ready" && changed && (S.route === "writing" || S.route === "home")) render();
}

/* ================= Home ================= */
const HOME_CHIPS = [
  { q: `Write a report on Meta's FY${FY} ${FIL.form}`, kind: "new" }, // a company not in the Library: the Palantir report already exists
  { q: "What did I note about cash flow?", kind: "notes" },
  { q: "Which of my reports have open questions?", kind: "open" },
];
// no key: sample answers are pre-written, and the reader is told how to turn live answers on
const NOKEY_TX = "To ask anything, add your own Meta API key (see Ask in the README). Until then, try these pre-written samples:";
const SITEFOOT = `<footer class="sitefoot"><span>© 2026 Trade Matrix Labs</span><span>Athena AI is a microservice of the Athena project at Trade Matrix Labs.</span></footer>`;
const TOUR_URL = "https://youtu.be/Ugn7Gb7mqrc"; // the public demo video: the Home card links it once it exists
const tourHTML = () => { const inner = `<span class="pl" aria-hidden="true">▶</span><span class="tt"><b>${TOUR_URL ? "Watch the 3-minute demo" : '3-minute demo video<span class="later">later</span>'}</b><small>${TOUR_URL ? "How" : "Not out yet. It will show how"} a report is read, checked and changed</small></span>`;
  return TOUR_URL ? `<a class="tour" href="${TOUR_URL}" target="_blank" rel="noopener">${inner}</a>` : `<div class="tour off">${inner}</div>`; };
function homeHTML() {
  return `<div class="page-pad">
    <h1 class="ph1">Good afternoon</h1><p class="lead">Ask Athena for a report on a public filing, or ask about the reports you already have.</p>
    <div class="askbox"><label class="vh" for="homeAsk">Ask Athena</label>
      <div class="row"><textarea id="homeAsk" placeholder="Ask Athena: request a report, or ask about your reports…" rows="2"></textarea><button class="btn primary" data-act="homeask">Ask</button></div>
      <div class="chiprow">${HOME_CHIPS.map((c, i) => `<button class="chip" data-act="homechip" data-i="${i}">${esc(c.q)}${c.kind === "new" ? laterTag() : ""}</button>`).join("")}</div>
      ${S.homeAns ? `<div class="answer" role="status">${S.homeAns}</div>` : ""}
    </div>
    <div class="home-grid">
      <section><h2 class="h2">Writing now</h2><div class="card" id="jobCard">${jobCardHTML()}</div>
        <h2 class="h2">Recent reports <a href="#" data-go="library" class="btn text">Library</a></h2>${recentHTML()}
        <h2 class="h2" id="newFilings">New filings this week</h2>${newFilingsHTML()}</section>
      <section><h2 class="h2">Tutorial</h2>${tourHTML()}<h2 class="h2">Your open notes <span class="muted">${openThreads().length} open</span></h2>${notesHTML()}</section>
    </div></div>`;
}
function jobCardHTML() {
  if (APP && LJ.runs.length) return liveCardHTML();
  const p = prog();
  if (JOB.state === "ready") return `<div class="job"><canvas id="jobRose" aria-hidden="true"></canvas><div><div class="t">Sample company A · 10-K FY2025</div><div class="s">Now: <b>${STEPS[2].name}</b> · step 3 of 6</div><div class="e">${REPLAY_TAG} no figures in a sample card</div><div class="acts"><button class="btn primary" data-act="newreport">New report${laterTag()}</button></div></div></div>`;
  return `<div class="job"><canvas id="jobRose" aria-hidden="true"></canvas><div>
    <div class="t">${esc(FIL.issuer)} · ${FIL.form} FY${FY}</div>
    <div class="s">${JOB.state === "stopped" ? "Stopped during" : "Now:"} <b>${STEPS[p.step].name}</b> · step ${p.step + 1} of 6</div>
    <div class="e">${mmss(JOB.t)} elapsed · usually 10–15 min <span class="tag demo">Demo timing</span></div>
    <div class="acts"><a class="btn" href="#" data-go="writing">${JOB.state === "stopped" ? "Resume or review" : "Watch it write"}</a></div></div></div>`;
}
function recentHTML() {
  const c = DOC.cover;
  if (JOB.state !== "ready") return `<p class="empty">No finished reports yet. ${esc(shortIssuer())} ${FIL.form} FY${FY} appears here when it is ready.</p>`;
  return `<a class="rcard" href="#" data-go="desk"><canvas data-rc aria-hidden="true"></canvas><div><div class="m">${esc(FIL.ticker)} · ${FIL.form} FY${FY} · ${S.latest > 1 ? `your Rev ${S.latest}` : "R1"}</div><div class="hl">${plainHTML(c.headline)}</div><div class="muted">${edShow() ? "Ready to open" : esc(edWords())} · shared edition R1${S.latest > 1 ? ` · your Rev ${S.latest} (private)` : ""}</div></div></a>`;
}
function newFilingsHTML() {
  return `<ul class="nfl">${CAT().map((c, i) => ({ ...c, i })).filter(c => !c.arch).map(c => `<li>${c.real ? `<a href="#" data-go="${c.st === "ready" ? "desk" : "writing"}">` : `<a href="#" data-act="newfor" data-i="${c.i}">`}<b>${esc(c.nm)}</b> <span class="muted">${c.form} · ${esc(c.fy)}</span></a><span class="st">${stateHTML(c)}</span>${c.real || c.st === "writing" ? "" : '<span class="tag dash">Sample</span>'}</li>`).join("")}</ul>`;
}
const openThreads = () => S.threads.filter(t => t.status === "open");
function tcardHTML(th, cur) {
  const kind = th.kind === "note" ? "memo" : th.messages[0].mode === "edit" ? "edit" : "ai";
  const a = anchorState(th), last = th.messages[th.messages.length - 1];
  const where = th.anchor && th.anchor.section_id ? sheetTitle(th.anchor.section_id) : "Whole report";
  return `<button class="tcard" data-act="openthread" data-th="${th.id}"${cur ? ' aria-current="true"' : ""}><div class="hd"><span class="mk ${kind}"></span>${kind === "memo" ? "Memo · only you" : kind === "edit" ? "Suggest edit" : "Ask"} · ${esc(where)}<span class="st">${th.status === "resolved" ? "Resolved" : a.st === "outdated" ? "Written on Rev " + th.anchor.revision_id.slice(4) : a.st === "carried" ? "Carried to Rev " + S.view : "Open"}</span></div>
    <div class="ex">${th.anchor ? "“" + esc(th.anchor.exact) + "”" : esc(th.messages[0].text)}</div>
    ${kind !== "memo" && th.anchor ? `<div class="one q">You: ${esc([...th.messages].reverse().find(m => m.role === "user").text)}</div>` : ""}<div class="one">${th.messages[0].fromSample ? `<span class="tag">Saved from a sample answer</span> ` : ""}${lastHTML(last)}</div></button>`;
}
// the list row names its last turn as the thread does: a live turn by its state, as its own label line says (a
// failed one by what went wrong), a sample turn as Sample
const lastHTML = m => m.role === "assistant" && m.waiting ? `Athena: ${m.mode === "edit" ? "Drafting" : "Answering"}…`
  : m.role === "assistant" && m.live ? `${m.live === "error" ? "" : '<span class="tag">Live answer</span> '}Athena · ${liveWho(m)}: ${esc(m.live === "error" ? m.notice || m.err : m.text ? plain(m.text) : m.pending.map(x => toolOf(x).what).join("; "))}`
  : `${m.role === "assistant" ? `<span class="tag">Sample</span> Athena: ` : ""}${m.text ? esc(plain(m.text)) : m.refusal ? "Draft refused by the report checks" : m.proposal ? esc(m.proposal.summary) : ""}`;
function notesHTML() {
  const ts = openThreads();
  if (!ts.length) return `<p class="empty">No open notes. Select words in a report to write a memo or ask Athena.</p>`;
  return ts.map(th => { const kind = th.kind === "note" ? "memo" : th.messages[0].mode === "edit" ? "edit" : "ai";
    return `<button class="note-row" data-act="openthread" data-th="${th.id}"><span class="mk ${kind}"></span><span><span class="q">${th.anchor ? "“" + esc(th.anchor.exact) + "”" : esc(th.messages[0].text)}</span><br><span class="w">${kind === "memo" ? (th.messages[0].fromSample ? "Memo saved from a sample answer: " : "Memo: ") + esc(th.messages[0].text) : kind === "edit" ? "Suggested edit" : "Question · " + nOf(th.messages.filter(m => m.role === "assistant" && m.text).length, "answer")} · ${esc(shortIssuer())} FY${FY}</span></span><span class="go">${esc(th.anchor && th.anchor.section_id ? sheetTitle(th.anchor.section_id) : "Report")} ›</span></button>`; }).join("");
}
// Home composer: a report request opens New report prefilled; the two sample questions get their samples;
// a question no filing answers gets the calm refusal; anything else gets an honest demo card.
const REPORT_RE = /\b(write|draft|make|new report|report on|report for|10-?k|13-?f|annual report|filing)\b/i;
function reportReq(q) {
  const co = COMPANIES.find(([t, n], i) => new RegExp(`\\b(${t}|${i ? n : n.split(/[ ,]/)[0]})\\b`, "i").test(q));
  const named = !co && (q.match(/\b(?:on|for|about)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)/) || [])[1];
  if (!co && !named && !REPORT_RE.test(q)) return null;
  const fy = (q.match(/\bFY\s?'?(\d{2,4})\b|\b(20\d{2})\b/i) || []).slice(1).find(Boolean);
  return { co: co ? co[0] : named ? named.replace(/'s$/, "") : S.newForm.co, form: /13-?f/i.test(q) ? "13F" : "10-K", fy: fy ? "FY" + (fy.length === 2 ? "20" + fy : fy) : S.newForm.fy, lang: S.newForm.lang };
}
function homeAsk(q, kind) {
  q = (q || "").trim(); if (!q) return;
  if (!kind) kind = PRICE_Q.test(q) || OUT_Q.test(q) ? "cant" : /\b(note|notes|noted|memo|memos)\b/i.test(q) && /cash/i.test(q) ? "notes" : /open question|unanswered|still open/i.test(q) ? "open" : reportReq(q) ? "new" : "demo";
  if (kind === "new") { const r = reportReq(q); if (r) S.newForm = r; S.newOpen = true; S.newLive = APP; if (APP) ljOpenForm(); S.homeAns = null; render(); return; }
  const memos = S.threads.filter(t => t.kind === "note" && t.status === "open"), qs = S.threads.filter(t => t.kind !== "note" && t.status === "open");
  const card = (who, body, meta) => `<div class="msg" style="margin:0"><div class="who ai">Athena · ${who}</div>${body}<div class="meta">${meta}</div></div>`;
  if (kind === "cant") S.homeAns = card("can't answer from the filings", `<div class="cant"><div class="h">Not something a filing can tell you</div><div class="tx">Athena reports what filed annual reports say. It won't give a price, a forecast, or a buy or sell view.</div></div>`, `<span class="tag demo">Demo</span>`);
  else if (kind === "demo") S.homeAns = card(LIVE() ? "ask inside a report" : "live answers off", `<div class="cant"><div class="h">${LIVE() ? "Live answers work inside a report." : "Live answers are off: this copy has no Meta API key."}</div><div class="tx">Your words were not sent to a model. ${LIVE() ? "Open a report and ask there, or try:" : NOKEY_TX}</div><div class="chiprow">${HOME_CHIPS.map((c, i) => `<button class="chip" data-act="homechip" data-i="${i}">${esc(c.q)}${c.kind === "new" ? laterTag() : ""}</button>`).join("")}</div></div>`, `<span class="tag demo">${LIVE() ? "Demo" : "No API key"}</span>`);
  else {
    let a;
    if (kind === "notes") { const cfId = (DOC.sections.find(s => /cash flow/i.test(s.title)) || {}).id, cf = memos.filter(t => t.anchor && t.anchor.section_id === cfId); // only the cash flow chapter's own memos
      a = cf.length ? `You have ${cf.length} memo${cf.length > 1 ? "s" : ""} in the ${esc(sheetTitle(cfId))} chapter of ${esc(shortIssuer())} FY${FY}: ${cf.map(t => `<button class="btn text" data-act="openthread" data-th="${t.id}">“${esc(t.messages[0].text)}”</button>`).join(" ")}` : `No memos in the ${esc(sheetTitle(cfId))} chapter yet.`; }
    else a = qs.length ? `${esc(shortIssuer())} FY${FY} has ${qs.length} open question${qs.length > 1 ? "s" : ""}: ${qs.map(t => `<button class="btn text" data-act="openthread" data-th="${t.id}">${esc(sheetTitle(t.anchor && t.anchor.section_id))}</button>`).join(" ")}. No other report has open questions.` : "No report has open questions.";
    S.homeAns = card("answer", `<div class="tx">${a}</div>`, "Sample answer · reads your notes only, never the reports' text");
  }
  render();
}

/* ================= New report sheet ================= */
const COMPANIES = [[FIL.ticker, FIL.issuer], ["CO-A", "Sample company A"], ["CO-B", "Sample company B"], ["CO-C", "Sample company C"]];
// the verdict follows the inputs: company + form + period + language, looked up in the catalog
const PERIODS = { "10-K": ["FY" + FY, "FY" + (FY - 1)], "13F": ["Q2 2026", "Q1 2026"] };
// a choice this demo cannot make: disabled, with the navigation's "later" tag. It stays pressed when a Library row opened on it
const laterOpt = (name, html, pressed) => `<button disabled aria-pressed="${pressed}" title="${name} · later">${html}<span class="later">later</span></button>`;
const LATER_START = `<button class="btn primary" disabled title="Start · later">Start<span class="later">later</span></button>`;
const resolveCo = q => { q = String(q || "").trim().toLowerCase(); if (!q) return null;
  return COMPANIES.find(([t, n]) => q === t.toLowerCase() || q === n.toLowerCase() || q === `${n} (${t})`.toLowerCase() || q.length >= 3 && n.toLowerCase().startsWith(q)) || null; };
function verdict(n) {
  if (!String(n.co || "").trim()) return null;
  const co = resolveCo(n.co); if (!co) return { k: "none" };
  if (n.form === "13F") return { k: "later", co };
  const c = CAT().find(c => c.tk === co[0] && c.form === n.form && c.fy === n.fy && c.lang === n.lang);
  return c ? { k: c.st, c, co } : { k: "none", co };
}
function verdictHTML() {
  const n = S.newForm, v = verdict(n), cancel = `<button class="btn text" data-act="closenew">Cancel</button>`, what = v && v.co ? `${esc(v.co[1])} · ${esc(n.form)} · ${esc(n.fy)} · ${n.lang === "ko" ? "한국어" : "English"}` : "";
  if (!v) return `<p class="note muted">Choose a company to see whether its report is already written.</p><div class="acts">${cancel}</div>`;
  if (v.k === "ready") return `<p class="note" role="status"><b>Already written · opens now.</b> ${what} has a shared edition (R1), the same for every reader. Your memos, questions and revisions on it stay private.</p>
    <div class="acts">${cancel}<button class="btn" data-act="startjob">Replay its first request (demo)</button><button class="btn primary" data-act="opennow">Open now</button></div>`;
  if (v.k === "writing") return `<p class="note" role="status"><b>Being written for its first reader.</b> ${what}: the quick summary is ready; the full report opens for everyone when it is done.${v.c.real ? "" : ` <span class="tag dash">Sample card</span> This sample has no data; the writing page replays the ${esc(shortIssuer())} FY${FY} run.`}</p>
    <div class="acts">${cancel}${v.c.real ? `<a class="btn primary" href="#" data-go="writing">Watch it write</a>` : `<button class="btn primary" data-act="startjob">Open the writing page (demo replay)</button>`}</div>`;
  if (v.k === "archived") return `<p class="note" role="status"><b>Archived edition.</b> ${what} is an older edition; older editions are not in this demo.</p><div class="acts">${cancel}</div>`;
  if (v.k === "later") return `<p class="note" role="status"><b>Later.</b> Holdings reports (13F) come in a later version; not in this demo.</p><div class="acts">${cancel}</div>`;
  if (v.k === "unwritten") return `<p class="note" role="status"><b>Not written yet: the first request writes it</b>, in about 10–15 minutes. You can keep working; Athena tells you when it is ready, and every later reader opens it at once.<br><span style="color:var(--caution)">${LJ.off ? "Report runs are off on this server" : `This demo can only write ${esc(FIL.issuer)}, ${FIL.form}, FY${FY}`}, so Start is off here.</span></p>
    <div class="acts">${cancel}${LATER_START}</div>`;
  return `<p class="note" role="status"><b>Not in this demo.</b> ${what || `“${esc(n.co)}”`} is not in this demo's catalog. The live service looks the filing up and writes it on the first request.</p>
    <div class="acts">${cancel}${LATER_START}</div>`;
}
// New report's model, display only: Contributor is the selected model, shown as text
// (.sel, styled as the pressed option), not a control, so it is no Tab stop; the other two are disabled with the later tag, as
// 한국어 is. No request carries a model: the server chooses it
const modelFldHTML = () => `<div class="fld"><span class="lb" id="lbModel">Model</span><div class="opts" role="group" aria-labelledby="lbModel" aria-describedby="nrModelN"><span class="sel">Muse Spark 1.3 · Contributor<span class="vh">, selected</span></span>${[["Muse Spark 1.3 · Standard"], ["Muse Wonder · preview"]].map(([l]) => `<button type="button" aria-pressed="false" disabled title="${l} · later">${l}<span class="later">later</span></button>`).join("")}</div>
    <p class="muted ljsm" id="nrModelN" style="margin:6px 0 0">Public research only. Inputs may be used by Meta to improve its models.</p><p class="muted ljsm" style="margin:4px 0 0">In this build, report jobs run on a local fake runner; no model is called.</p></div>`;
function newHTML() {
  const n = S.newForm, co = COMPANIES.find(c => c[0] === n.co);
  return `<div class="modal" data-act="closenew-scrim"><div class="mbox" role="dialog" aria-modal="true" aria-labelledby="nrT">
    <div class="caps muted">New report</div><h2 id="nrT">Which filing?</h2>
    <div class="fld"><label class="lb" for="nrCo">Company or ticker</label><input id="nrCo" class="field" autocomplete="off" value="${esc(co ? co[1] + " (" + co[0] + ")" : n.co)}" aria-describedby="nrHint">
      <div class="suggest" id="nrSug" hidden></div><div id="nrHint" class="vh">Type to search companies</div></div>
    <div class="fld"><span class="lb" id="lbForm">Form</span><div class="opts" role="group" aria-labelledby="lbForm"><button data-act="nf" data-k="form" data-v="10-K" aria-pressed="${n.form === "10-K"}">10-K<span class="muted" style="font-weight:400;margin-left:6px">annual report</span></button>${laterOpt("13F holdings", `13F<span class="muted" style="font-weight:400;margin-left:6px">holdings</span>`, n.form === "13F")}</div></div>
    <div class="fld"><span class="lb" id="lbFy">${n.form === "13F" ? "Quarter" : "Fiscal year"}</span><div class="opts" role="group" aria-labelledby="lbFy">${PERIODS[n.form].map(f => f === "FY" + FY ? `<button data-act="nf" data-k="fy" data-v="${f}" aria-pressed="${n.fy === f}">${f}</button>` : laterOpt(f, f, n.fy === f)).join("")}</div></div>
    <div class="fld"><span class="lb" id="lbLang">Language</span><div class="opts" role="group" aria-labelledby="lbLang"><button data-act="nf" data-k="lang" data-v="en" aria-pressed="${n.lang === "en"}">English</button>${laterLangs('data-act="nf" data-k="lang"')}</div></div>
    ${modelFldHTML()}
    <div id="nrVerdict" aria-live="polite">${verdictHTML()}</div>
  </div></div>`;
}

/* ================= Writing page ================= */
function wrHeadHTML() {
  const p = prog();
  if (JOB.state === "ready") return `<div class="caps muted">${edShow() ? "Ready" : esc(edWords())} · ${mmss(T.review)}</div><h1 class="wr-h">${edShow() ? "The shared edition is ready" : `Shared edition R1: ${esc(edWords())}`}</h1><p class="lead" style="margin:0">${esc(FIL.issuer)} · ${FIL.form} · FY${FY} · shared edition R1, the same for every reader. The rosette is finished: one sector per chapter, one ring per figure.</p><div class="wr-acts" style="margin-top:16px"><button class="btn primary" data-act="opensummary">Open the Summary</button></div>`;
  return `<div class="caps muted">${esc(FIL.issuer)} · ${FIL.form} · FY${FY} · ${S.newForm.lang === "ko" ? "한국어" : "English"}</div><h1 class="wr-h">${JOB.state === "stopped" ? "Writing stopped" : "Writing your report"}</h1>
    <div class="timer"><b id="wrTime">${mmss(JOB.t)}</b><span>elapsed · usually 10–15 minutes</span><span class="tag demo">Demo timing · ${JOB.speed}× faster</span></div>
    ${JOB.state === "stopped" ? `<div class="stopnote" role="status"><b>Stopped during ${STEPS[p.step].name}.</b> The ${nOf(p.facts, "fact")} and ${nOf(p.chN, "chapter")} written so far are kept. Resume continues from the saved step; nothing is sent again.</div>
      <div class="wr-acts"><button class="btn primary" data-act="resume">Resume</button><a class="btn" href="#" data-go="home">Back to Home</a></div>`
    : JOB.confirmStop ? `<div class="confirm" role="group" aria-label="Stop writing"><span>Stop writing? The work so far is kept and you can resume.</span><button class="btn danger" data-act="stopyes">Stop writing</button><button class="btn text" data-act="stopno">Keep writing</button></div>`
    : `<div class="wr-acts"><a class="btn" href="#" data-go="${S.wrFrom || "home"}" title="The report keeps writing">Back to ${PLACE[S.wrFrom || "home"]}</a><button class="btn text danger" data-act="stop">Stop</button><span class="muted" style="font-size:12.5px">You can leave this page; the report keeps writing.</span></div>`}`;
}
function stepsHTML() {
  const p = prog(), nS = DOC.sources.length, nF = DOC.facts.length, nC = DOC.sections.length;
  // app mode: an edition that is not accepted and published is replayed as a draft, never as checked, reviewed or ready
  const dr = !edShow(), nOpen = ED && ED.review_findings ? ED.review_findings.count : null;
  const counts = [`${p.src} of ${nS} source passages read`, `${p.facts} of ${nF} facts collected`, `${p.chN} of ${nC} chapters written`, dr ? `${p.chk} of ${nF} linked figures run through the checks` : `${p.chk} of ${nF} linked figures checked`,
    dr ? (p.ready && (nOpen != null || !APP) ? (nOpen != null ? `Review required · ${nOf(nOpen, "open finding")}` : "Review required") : `${p.revN} of ${nC} chapters through review`) : `${p.revN} of ${nC} chapters reviewed`, p.ready && !dr ? "Rev 1 saved" : ""];
  const ends = [T.read, T.collect, T.write, T.check, T.review, T.review], starts = [0, T.read, T.collect, T.write, T.check, T.review];
  return `<ol class="steps" id="wrSteps">${STEPS.map((s, i) => { const done = p.ready || i < p.step, cur = !p.ready && i === p.step, last = dr && i === 5;
    return `<li class="${done ? "done" : cur ? JOB.state === "stopped" ? "stop" : "now" : ""}" ${cur ? 'aria-current="step"' : ""}><span class="dot" aria-hidden="true"></span><div><div class="n">${last ? "Saved as a draft" : s.name}</div><div class="d">${last ? "Shared edition R1 is saved as a draft; it has not passed review." : s.d}</div>${(done || cur) && counts[i] ? `<div class="c">${counts[i]}</div>` : ""}</div><span class="t">${done && i < 5 ? mmss(ends[i] - starts[i]) : cur ? JOB.state === "stopped" ? "stopped" : "now" : ""}</span></li>`; }).join("")}</ol>`;
}
// first request: the quick summary is there from the start; each chapter's key point appears as its sector is engraved
// quick-summary figures are plain text here: the Probe opens with the finished report
const staticFigs = h => h.replace(/<button type="button" class="fig[^"]*"[^>]*>/g, '<span class="sfig">').replace(/<\/button>/g, "</span>");
const CHK = '<span class="tag dash unchk">Not yet checked</span>';
const qsChecked = () => prog().ready || prog().step >= 4;
function soFarHTML() {
  const p = prog(), n = p.ch, ink = p.step >= 3 ? p.inked : 0, ss = DOC.sections.slice(0, n).filter(s => !s.absent);
  return `<div id="wrSoFar" data-n="${n}:${ink}"><h2 class="h2">Chapters so far <span class="muted">${p.chN} of ${DOC.sections.length}</span></h2><p class="muted sofar-note">Chapters open when the report is ready. A key point is marked until its figures pass Check numbers.</p>${n ? `<ol class="chlist sofar">${ss.map(s => { const kp = (DOC.digest || []).find(d => d.section === s.id), i = DOC.sections.indexOf(s);
    return `<li><b>${secNum(s)}</b><span class="t">${esc(s.title)}${p.ready || i < ink ? "" : " " + CHK}</span>${(k => k ? `<span class="k">${plainHTML(k)}</span>` : "")(kp ? kp.keypoint : s.keypoint)}</li>`; }).join("")}</ol>` : `<p class="empty">The first chapter's key point appears here when its sector is engraved.</p>`}</div>`;
}
function quickHTML() {
  const c = DOC.cover;
  return `<section class="qs" aria-labelledby="qsH"><div class="caps muted" id="qsH">Quick summary · ready in minutes <span class="tag">${aiTag()}</span> <span id="qsMark">${qsChecked() ? "" : CHK}</span></div>
    <h2 class="qs-h">${plainHTML(c.headline)}</h2>${c.kpis ? `<div class="gauges">${staticFigs(c.kpis.items.map(gaugeHTML).join(""))}</div>` : ""}</section>`;
}
function writingHTML() {
  return `<div class="page-pad"><p class="demoband"><span class="tag demo">Demo</span> What the first reader of a filing sees: the quick summary right away, the full report in about 10–15 minutes, then every later reader opens it at once. Replayed with the ${esc(shortIssuer())} FY${FY} data.</p><div class="writing">
    <div><div class="rosebox"><canvas id="wrRose" role="img" aria-label="Rosette engraving as the report is written: rim = filing passages read, inner ticks = facts collected, sectors = chapters written, ink = figures checked"></canvas></div>${stepsHTML()}
      <p class="muted" style="font-size:12.5px;line-height:18px">What you see is what the service reports: the rim fills as filing passages are read, a tick appears for each fact collected, a sector is engraved in pencil when its chapter is written and inked when its figures pass the checks. Demo timing replays these events faster than a real run.</p></div>
    <div><div id="wrHead">${wrHeadHTML()}</div>${quickHTML()}${soFarHTML()}</div>
  </div></div>`;
}

/* ================= live report runs (app mode) ================= */
// A judge starts a run on a catalog filing; the report service (the runner) writes it and posts its stages; this page asks
// the app every 5 s. The judge's runs are kept in this browser, so a reload or a later visit finds them again. The static
// prototype and the Demo menu's replay never use any of this.
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage off: this visit only */ } } };
const rid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const JAPI = APP ? CFG.api_base || "/api" : "", ENDED = ["ready", "failed", "refused", "stopped"];
const laterTag = () => LJ.off ? `<span class="later">later</span>` : ""; // on what a server with report runs off cannot do
const LJ = { cat: null, runs: APP ? LS.get("athena-runs", []) : [], v: {}, form: null, needCode: false, err: "", off: false, polling: false, timer: 0, toast: null, key: "" };
const saveRuns = () => { LJ.runs = LJ.runs.slice(-10); LS.set("athena-runs", LJ.runs); };
const runById = id => LJ.runs.find(r => r.id === id);
const unseenRuns = () => LJ.runs.filter(r => r.told && !r.seen);
const clientId = () => LJ.cid || (LJ.cid = LS.get("athena-client", "") || (c => (LS.set("athena-client", c), c))(rid()));
const tsMs = s => { const t = Date.parse(s || ""); return isNaN(t) ? null : t; };
const hms = s => s >= 3600 ? Math.floor(s / 3600) + ":" + mmss(s % 3600) : mmss(s);
// measured time: from the request to the end (both server times), or to now while the run is open
const runSecs = v => { const a = tsMs(v.created_at), b = ENDED.includes(v.state) ? tsMs(v.ended_at) : Date.now(); return a == null || b == null ? null : Math.max(0, (b - a) / 1000); };
// spend only as observed: the app sends null until the runner reports it, and null shows nothing, never
// $0.00 (display only; the pipeline's ledger is the authority)
const runSpend = v => typeof v.spend_usd === "number" ? v.spend_usd : null;
const runUsd = x => "$" + (x > 0 && x < .01 ? x.toFixed(4) : x.toFixed(2));
const RUN_W = {
  requested: ["Requested", "Waiting for the report service to pick it up. A run it does not pick up in time is closed without a report."],
  claimed: ["Picked up", "The report service has the request and is starting."],
  running: ["Being written", "The stages below are reported by the report service as they happen."],
  ingesting: ["Storing", "The report service delivered the report; the app is checking and storing it."],
  ready: ["Written", "The report is stored. Open it to read it; its status shows on the report."],
  failed: ["Failed", "The run ended without a report."],
  refused: ["Refused", "This run did not start; no report was written."],
  stopped: ["Stopped", "The run was stopped; no report was written."],
  unknown: ["No word", "The report service has not reported for a while. The run may still finish, so this page keeps checking; until it ends, this browser cannot start another run."],
};
const runWord = v => (RUN_W[v.state] || [cap1(uword(v.state))])[0];
const edOk = es => es && es.quality_disposition === "accepted" && es.publication_disposition === "published";
// why a run ended without a report: the app's own codes, and the runner's allowlisted reason codes.
// The public view carries codes and counts only, never the findings themselves
const REASON = {
  cap_reached: "The report service's spending limit is reached, so this run did not start.",
  unavailable: "The report service was not available, so this run did not start.",
  engine_error: "The report engine stopped with an error.",
  provider_error: "The model provider returned an error.",
  timeout: "The run passed its time limit.",
  input_error: "The filing could not be read.",
  stopped: "The run was stopped.",
  operator_closed: "The operator closed this run after checking that nothing was still running.",
  not_started: "The report service did not pick this run up in time, so it was closed.",
  not_in_catalog: "This filing is no longer offered, so the run was not started.",
  filing_mismatch: "The report delivered was for another filing, so it was not stored.",
  language_mismatch: "The report delivered was in another language, so it was not stored.",
};
function runErrHTML(v) {
  const e = v.error || {}, why = String(e.reason || v.reason || ""), list = e.errors || [], codes = Array.isArray(list) ? list.map(String) : Object.entries(list).map(([k, n]) => `${uword(k)}: ${n}`);
  if (e.code === "integrity_error") return `<b>The delivery did not pass the app's checks</b> (${nOf(e.count || codes.length, "finding")}), so no report was stored.${codes.length ? `<details class="ljerr"><summary>Show the codes</summary><ul>${codes.slice(0, 20).map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}`;
  if (e.code === "app_error") return "<b>The app could not store the delivery</b>, so no report was stored.";
  const w = REASON[why] || REASON[e.code];
  return w ? `<b>${esc(w)}</b>` : why || e.code ? `Reason given: ${esc(uword(why || e.code))}.` : "";
}
// the stages are the runner's progress lines, one row per stage in the order first reported, with its latest status and note.
// Nothing is estimated: no percentage, no expected duration
const DONE_RE = /^(done|ok|complete|completed|finished|passed|succeeded)$/i, BAD_RE = /^(failed|error|stopped|refused|cancelled)$/i;
function runStepsHTML(v) {
  const m = new Map(); for (const e of v.events || []) m.set(String(e.stage), { ...(m.get(String(e.stage)) || {}), ...e });
  const st = [...m.values()], t0 = tsMs(v.created_at), open = !ENDED.includes(v.state) && v.state !== "unknown";
  if (!st.length) return `<p class="empty" id="ljSteps">${open ? "Writing your report. Its stages appear here as the report service reports them." : "The report service reported no stages."}</p>`;
  return `<ol class="steps" id="ljSteps" aria-label="Stages reported by the report service">${st.map((s, i) => {
    const c = BAD_RE.test(s.status) ? "stop" : DONE_RE.test(s.status) || v.state === "ready" ? "done" : open && i === st.length - 1 ? "now" : "", at = tsMs(s.ts);
    return `<li class="${c}"${c === "now" ? ' aria-current="step"' : ""}><span class="dot" aria-hidden="true"></span><div><div class="n">${esc(cap1(uword(s.stage)))}</div>${s.note ? `<div class="d">${esc(s.note)}</div>` : ""}<div class="c">${esc(uword(s.status))}</div></div><span class="t">${at != null && t0 != null ? hms(Math.max(0, (at - t0) / 1000)) : ""}</span></li>`; }).join("")}</ol>`;
}
function notifyHTML() {
  const p = Notification.permission, on = p === "granted" && LS.get("athena-notify", false);
  return `<span id="ljNotify" class="wr-acts"><button class="btn" data-act="notifyme" aria-pressed="${on}"${p === "denied" ? ' aria-describedby="ljNoN"' : ""}>Notify me</button>${on ? '<span class="muted ljsm">A browser notification comes when the run ends.</span>' : p === "denied" ? '<span class="muted ljsm" id="ljNoN">Browser notifications are blocked for this site; the bell and the tab title still tell you.</span>' : ""}</span>`;
}
function runHeadHTML(r, v) {
  const [w, d] = RUN_W[v.state] || [cap1(uword(v.state)), ""], s = runSecs(v), sp = runSpend(v), ended = ENDED.includes(v.state), es = v.state === "ready" && v.edition_status, err = ended && v.state !== "ready" ? runErrHTML(v) : "";
  return `<div class="caps muted">${esc(r.name)} · ${v.language === "ko" ? "한국어" : "English"}</div>
    <h1 class="wr-h">${v.state === "ready" ? "Your report is written" : ended ? "The run ended" : v.state === "unknown" ? "No word from the report service" : "Writing your report"}</h1>
    <p class="lead" style="margin:0"><b>${esc(w)}.</b> ${esc(d)}${es ? ` Status: ${esc(stWords({ status: es }))}${edOk(es) ? "" : "; not an accepted report"}.` : ""}</p>
    ${err ? `<div class="stopnote" style="margin-top:12px">${err}</div>` : ""}
    <div class="timer"><b id="ljTime">${s == null ? "--:--" : hms(s)}</b><span>${ended ? "from the request to the end" : "since the request"}</span>${sp != null ? `<span>Spend ${runUsd(sp)}, as reported by the report service</span>` : ""}</div>
    <div class="wr-acts">${v.state === "ready" && v.edition_id != null ? `<a class="btn primary" href="/reports/${encodeURIComponent(v.edition_id)}#at=desk/summary" data-act="ljopen" data-j="${esc(r.id)}">Open the report</a>` : ""}${!ended && "Notification" in window ? notifyHTML() : ""}${ended ? `<button class="btn" data-act="new">New report</button>` : '<span class="muted ljsm">You can leave this page; Athena tells you here when the run ends.</span>'}</div>`;
}
function ljViewHTML(r, v) {
  if (v && v.gone) return `<div class="caps muted">${esc(r.name)}</div><h1 class="wr-h">This run is not on this server</h1><p class="lead">The app server has no run with this number.</p><div class="wr-acts"><button class="btn" data-act="new">New report</button></div>`;
  return (v ? runHeadHTML(r, v) + runStepsHTML(v) : `<div class="caps muted">${esc(r.name)}</div><h1 class="wr-h">Writing your report</h1><p class="lead">${LJ.off ? "Report runs are off on this server right now, so this run cannot be shown." : "Asking the app server for this run…"}</p>`) + (LJ.err ? `<p class="muted ljsm">${esc(LJ.err)}</p>` : "");
}
const viewKey = id => JSON.stringify(LJ.v[id] || null) + LJ.err + LJ.off;
function liveWritingHTML() {
  const id = S.liveJob, r = runById(id) || { id, name: "Report run" }, others = LJ.runs.filter(x => x.id !== id).reverse();
  LJ.key = viewKey(id);
  return `<div class="page-pad" style="max-width:820px"><div id="ljView">${ljViewHTML(r, LJ.v[id])}</div>
    ${others.length ? `<h2 class="h2">Your other runs in this browser</h2><ul class="nfl">${others.map(x => `<li><a href="#" data-act="ljgo" data-j="${esc(x.id)}"><b>${esc(x.name)}</b></a><span class="st">${LJ.v[x.id] && !LJ.v[x.id].gone ? esc(runWord(LJ.v[x.id])) + (tsMs(LJ.v[x.id].created_at) ? " · requested " + new Date(tsMs(LJ.v[x.id].created_at)).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "") : ""}</span></li>`).join("")}</ul>` : ""}</div>`;
}
// Home's "Writing now" card follows the judge's latest run
function liveCardHTML() {
  const r = LJ.runs[LJ.runs.length - 1], v = LJ.v[r.id], ok = v && !v.gone, ended = ok && ENDED.includes(v.state), s = ok ? runSecs(v) : null, e = ok && (v.events || []).slice(-1)[0];
  return `<div class="job live"><div><div class="t">${esc(r.name)}</div><div class="s">${ok ? `<b>${esc(runWord(v))}</b>${e && !ended ? ` · ${esc(cap1(uword(e.stage)))} ${esc(uword(e.status))}` : ""}` : v ? "Not on this server" : LJ.off ? "Report runs are off on this server" : "Asking the app server…"}</div>${s != null ? `<div class="e"><span id="ljCardTime">${hms(s)}</span> ${ended ? "from the request to the end" : "since the request"}</div>` : ""}<div class="acts"><a class="btn" href="#" data-act="ljgo" data-j="${esc(r.id)}">${ended ? "See the run" : "Watch it write"}</a></div></div></div>`;
}
// New report, live: the server's catalog, the access code, Start. One client_request_id per attempt (a filing choice), reused
// when Start is pressed again, so a retry never starts a second run
const REFUSE = {
  disabled: "Report runs are off on this server right now, so nothing was started.",
  bad_access_code: "That access code is not right. Check it and try again.",
  unknown_filing: "This server cannot write that filing. Choose one from the list.",
  busy: "The report service is busy with another run. Try again in a few minutes.",
  cap_reached: "This server has reached its limit of report runs, so no new run can start.",
  rate_limited: "This browser already has a run that has not ended. You can start another when it ends.",
  unavailable: "The report service is not reporting right now, so no run can start. Try again later.",
  conflict: "This request was already used with other choices, so it was not sent again. Press Start to send it as a new request.",
};
function refusalWords(x) {
  if (x.status === undefined) return "The app server did not answer, so the request may not have arrived. Press Start again: it sends the same request, and a request that already arrived does not start a second run.";
  const w = REFUSE[x.code] || REFUSE[{ 409: "conflict", 429: "rate_limited" }[x.status]], open = LJ.runs.filter(r => !r.told).pop();
  return w ? esc(w) + (x.status === 429 && open ? ` <a href="#" data-act="ljgo" data-j="${esc(open.id)}">See that run</a>` : "") : `The request was refused: ${esc(x.message)}`;
}
function ljBodyHTML() {
  const c = LJ.cat, f = LJ.form, cancel = `<button type="button" class="btn text" data-act="closenew">${Array.isArray(c) ? "Cancel" : "Close"}</button>`;
  if (c === null) return `<p class="note muted">Loading the filings this server can write…</p><div class="acts">${cancel}</div>`;
  if (!Array.isArray(c)) return c.code === "disabled" ? `<p class="note"><b>Report runs are off on this server.</b><span class="later">later</span> Nothing can be started here; the reports in the Library still open, and a demo replay shows how one gets written.</p><div class="acts">${cancel}<button type="button" class="btn" data-go="library">Open the Library</button><button type="button" class="btn primary" data-act="newfor" data-i="${CAT().findIndex(x => x.tk === "CO-A")}">Demo Replay</button></div>`
    : `<p class="note"><b>The filings could not be loaded.</b> ${esc(c.err)}</p><div class="acts">${cancel}<button type="button" class="btn" data-act="ljcat">Try again</button></div>`;
  if (!c.length) return `<p class="note"><b>This server lists no filings to write.</b></p><div class="acts">${cancel}</div>`;
  // only Korean filings: the later reason shows when the dialog opens (Start keeps its behaviour and says it again when pressed)
  const koOnly = c.every(ljLater);
  return `<div class="fld"><span class="lb" id="ljFl">Filing</span><div class="opts" role="group" aria-labelledby="ljFl">${c.map(e => ljLater(e) ? `<button type="button" data-act="ljpick" data-v="${esc(e.filing_id)}" aria-pressed="false" disabled title="한국어 · later">${esc(e.issuer)}<span class="muted" style="font-weight:400;margin-left:6px">${esc(e.form)} · ${esc(e.period)} · <span lang="ko">한국어</span></span><span class="later">later</span></button>`
      : `<button type="button" data-act="ljpick" data-v="${esc(e.filing_id)}" aria-pressed="${f.filing_id === e.filing_id}">${esc(e.issuer)}<span class="muted" style="font-weight:400;margin-left:6px">${esc(e.form)} · ${esc(e.period)} · English</span></button>`).join("")}</div></div>
    ${modelFldHTML()}
    ${LJ.needCode ? `<div class="fld"><label class="lb" for="ljCode">Access code</label><input id="ljCode" class="field" type="password" autocomplete="off" spellcheck="false" value="${esc(f.code)}" aria-describedby="${f.err ? "ljErr " : ""}ljCodeH"${f.bad ? ' aria-invalid="true"' : ""}><div class="muted ljsm" id="ljCodeH" style="margin-top:4px">The code that came with this demo.</div></div>` : ""}
    ${f.err ? `<p class="note ljbad" id="ljErr" role="alert">${f.err}</p>` : koOnly ? `<p class="note" id="ljLaterN">${KO_ONLY}</p>` : `<p class="note">The run's progress shows once it starts. You can leave the page; Athena tells you here when the run ends.</p>`}
    <div class="acts">${cancel}<button type="submit" class="btn primary" data-act="ljstart"${f.busy ? ' aria-disabled="true"' : ""}${koOnly && !f.err ? ' aria-describedby="ljLaterN"' : ""}>${f.busy ? "Starting…" : "Start"}</button></div>`;
}
const liveNewHTML = () => `<div class="modal" data-act="closenew-scrim"><form class="mbox" id="ljForm" role="dialog" aria-modal="true" aria-labelledby="nrT" novalidate>
    <div class="caps muted">New report</div><h2 id="nrT">Which filing?</h2><div id="ljBody">${ljBodyHTML()}</div></form></div>`;
// where the keyboard starts in the dialog: the first filing, else the code when the server asked for one, else Start
// (a Korean filing is shown but disabled: with no other filing, Start, which then says why)
const ljFocusEl = () => LJ.form && Array.isArray(LJ.cat) && LJ.cat.length ? (!LJ.form.filing_id ? $('[data-act="ljpick"]:not([disabled])') || $('[data-act="ljstart"]') : LJ.needCode ? $("#ljCode") : $('[data-act="ljstart"]')) : null;
function ljPaint(focus) { const b = $("#ljBody"); if (!b) return; b.innerHTML = ljBodyHTML(); if (focus) { const f = ljFocusEl() || $("button:not([disabled])", b); f && f.focus({ preventScroll: true }); } }
// a server that lists one filing has it chosen already; a Korean filing comes later, so it is never the one chosen
const ljLater = e => e.language === "ko";
// report and interface languages: English now, the others carry the later tag and are never pressed
const laterLangs = act => [["ko", "한국어"], ["de", "Deutsch"], ["ja", "日本語"], ["fr", "Français"], ["zh", "中文"], ["es", "Español"]].map(([k, n]) => `<button ${act} data-v="${k}" aria-pressed="false" disabled title="${n} · later"><span lang="${k}">${n}</span><span class="later">later</span></button>`).join("");
const KO_ONLY = "Korean reports arrive in a later version, so no filing on this list can be written yet.";
const ljOne = () => { if (!Array.isArray(LJ.cat) || !LJ.form) return;
  if (LJ.cat.some(e => e.filing_id === LJ.form.filing_id && ljLater(e))) LJ.form.filing_id = "";
  if (LJ.cat.length === 1 && !ljLater(LJ.cat[0]) && !LJ.form.filing_id) LJ.form.filing_id = LJ.cat[0].filing_id; };
function ljOpenForm() {
  if (!LJ.form) LJ.form = { filing_id: "", code: "", crid: rid(), err: "", bad: false, busy: false };
  Object.assign(LJ.form, { err: "", bad: false, busy: false });
  if (!Array.isArray(LJ.cat)) loadCat(); else ljOne();
}
function loadCat() {
  LJ.cat = null; ljPaint();
  api("GET", JAPI + "/catalog").then(c => { LJ.cat = Array.isArray(c) ? c : { err: "the list came in an unexpected form" }; ljOne(); },
    e => { LJ.cat = { code: e.code, err: e.message }; }).then(() => ljPaint(true));
}
async function startRun() {
  const f = LJ.form, c = Array.isArray(LJ.cat) ? LJ.cat : null; if (!f || !c || f.busy) return;
  // the access code field shows only after the server has asked for one (bad_access_code); until then the request carries none
  const e = c.find(x => x.filing_id === f.filing_id), code = LJ.needCode ? f.code.trim() : "";
  if (!e) { f.err = c.some(x => !ljLater(x)) ? "Choose a filing first." : KO_ONLY;
    ljPaint(); const t = ljFocusEl(); return t && t.focus(); }
  if (LJ.needCode && !code) { f.err = "Enter the access code."; f.bad = true; ljPaint(); return $("#ljCode").focus(); }
  f.busy = true; f.err = ""; f.bad = false; ljPaint(); $('[data-act="ljstart"]').focus();
  try {
    const j = await api("POST", JAPI + "/jobs", { filing_id: e.filing_id, language: e.language, client_request_id: f.crid, client_id: clientId(), access_code: code });
    if (!runById(j.job_id)) LJ.runs.push({ id: j.job_id, filing_id: e.filing_id, name: `${e.issuer} · ${e.form} · ${e.period}`, told: false, seen: false });
    saveRuns(); LJ.form = null; S.newLive = false; S.liveJob = j.job_id;
    goRoute("writing"); live("Report requested. Its progress shows on this page."); pollJobs();
  } catch (x) {
    if (!LJ.form) return;
    f.busy = false; f.bad = x.code === "bad_access_code"; if (x.status === 409) f.crid = rid();
    f.err = f.bad && !LJ.needCode ? "This server asks for an access code. Enter the code that came with this demo, then press Start." : refusalWords(x);
    if (f.bad) LJ.needCode = true; ljPaint(); (f.bad ? $("#ljCode") : $('[data-act="ljstart"]')).focus();
  }
}
// one round asks for every run that is still open (and once per visit for an ended one), then again in 5 s while any is open
function pollJobs() {
  clearTimeout(LJ.timer); LJ.timer = 0;
  const due = LJ.runs.filter(r => !(LJ.v[r.id] && r.told));
  if (!APP || LJ.off || LJ.polling || !due.length) return;
  LJ.polling = true;
  // events carry seq and the view carries last_seq: ask only for newer ones and add them to those already here
  const after = r => { const w = LJ.v[r.id], n = w && !w.gone ? (typeof w.last_seq === "number" ? w.last_seq : lastSeq(w.events)) : 0; return n ? "?after=" + n : ""; };
  Promise.all(due.map(r => api("GET", `${JAPI}/jobs/${encodeURIComponent(r.id)}${after(r)}`).then(v => gotRun(r, v), e => {
    if (e.status === 404) { LJ.v[r.id] = { gone: true }; LJ.runs = LJ.runs.filter(x => x !== r); saveRuns(); }
    else if (e.code === "disabled") LJ.off = true;
    else LJ.err = e.status === undefined ? `The app server did not answer at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}; this page keeps checking every 5 seconds.` : `The app server answered: ${e.message}. This page keeps checking.`;
  }))).then(() => {
    LJ.polling = false; jobsChanged();
    if (!LJ.off && LJ.runs.some(r => !(LJ.v[r.id] && r.told))) LJ.timer = setTimeout(pollJobs, 5000);
  });
}
const lastSeq = ev => (ev || []).reduce((m, e) => typeof e.seq === "number" && e.seq > m ? e.seq : m, 0);
function gotRun(r, v) {
  const was = LJ.v[r.id], nw = Array.isArray(v.events) ? v.events : [];
  // lines with seq join the earlier ones (a repeat is kept once); a server without seq sends the whole list each time
  if (was && !was.gone && nw.every(e => typeof e.seq === "number")) { const seen = new Set(nw.map(e => e.seq)); v.events = [...(was.events || []).filter(e => !seen.has(e.seq)), ...nw].sort((a, b) => (a.seq || 0) - (b.seq || 0)); }
  LJ.v[r.id] = v; LJ.err = "";
  if (!r.filing_id && v.filing_id) { r.filing_id = r.name = v.filing_id; saveRuns(); }
  if (ENDED.includes(v.state)) { if (!r.told) { r.told = v.state; r.seen = false; saveRuns(); runEnded(r, v, !was); } }
  else if (was && was.state !== v.state && S.route === "writing" && S.liveJob === r.id) live(`${runWord(v)}. ${RUN_W[v.state] ? RUN_W[v.state][1] : ""}`);
}
// a run that ends: a toast (it stays until dismissed), the bell's count, the tab's title, and a browser notification when
// the judge turned "Notify me" on and is looking elsewhere
function runEnded(r, v, away) {
  const ready = v.state === "ready", es = v.edition_status;
  const head = ready ? "Report ready" : v.state === "refused" ? "Report run refused" : v.state === "stopped" ? "Report run stopped" : "Report run failed";
  const body = `${r.name}${ready && es ? " · " + stWords({ status: es }) : ""}${away ? " · ended while you were away" : ""}`;
  LJ.toast = { id: r.id, head, body, eid: ready ? v.edition_id : null }; showToast(); live(`${head}: ${body}.`);
  if (LS.get("athena-notify", false) && "Notification" in window && Notification.permission === "granted" && (document.hidden || !document.hasFocus()))
    try { const n = new Notification(`Athena: ${head.toLowerCase()}`, { body, tag: "athena-" + r.id }); n.onclick = () => { focus(); openRun(r.id); n.close(); }; } catch (_) { /* a browser that allows them from a service worker only */ }
}
function showToast() {
  let el = $("#toast"); const t = LJ.toast;
  if (!el) { if (!t) return; el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "region"); el.setAttribute("aria-label", "Report run notice"); document.body.append(el); }
  el.hidden = !t; if (!t) return;
  el.innerHTML = `<div><div class="t">${esc(t.head)}</div><div class="s">${esc(t.body)}</div></div><button class="ib" data-act="toastx" aria-label="Dismiss: ${esc(t.head)}" title="Dismiss">${IC.x}</button>
    <div class="acts">${t.eid != null ? `<a class="btn primary" href="/reports/${encodeURIComponent(t.eid)}#at=desk/summary" data-act="ljopen" data-j="${esc(t.id)}">Open the report</a>` : ""}<a class="btn" href="#" data-act="ljgo" data-j="${esc(t.id)}">See the run</a></div>`;
}
function seeRun(id) { const r = runById(id); if (r && r.told && !r.seen) { r.seen = true; saveRuns(); } if (LJ.toast && LJ.toast.id === id) { LJ.toast = null; showToast(); } paintBell(); }
function openRun(id) { if (!id) return; seeRun(id); S.liveJob = id; goRoute("writing"); pollJobs(); }
// the Runs entry (sidebar after Library, phone tab bar): this browser's runs, with a badge counting ended runs not yet seen
function runsNavHTML(ni) {
  if (!APP || !LJ.runs.length) return "";
  const n = unseenRuns().length, ic = IC.bell.replace("<svg", '<svg aria-hidden="true"');
  return `<a href="#" data-act="runs" ${S.route === "writing" && S.liveJob ? 'aria-current="page"' : ""} title="Runs">${ni ? `<span class="ni" aria-hidden="true">${IC.bell}</span><span class="nl">Runs</span>` : `${ic}<span>Runs</span>`}<span class="bdg" aria-hidden="true"${n ? "" : " hidden"}>${n}</span><span class="vh">${n ? `, ${nOf(n, "ended run")} not yet seen` : ""}</span></a>`;
}
function paintBell() {
  if (!APP) return;
  const n = unseenRuns().length;
  if (LJ.runs.length && !$('#side [data-act="runs"]')) renderSide();
  $$('[data-act="runs"] .bdg').forEach(b => { b.textContent = n; b.hidden = !n; });
  $$('[data-act="runs"] .vh').forEach(b => { b.textContent = n ? `, ${nOf(n, "ended run")} not yet seen` : ""; });
  setTitle();
}
function jobsChanged() {
  if (S.route === "writing" && S.liveJob) { const el = $("#ljView"), k = viewKey(S.liveJob);
    if (el && k !== LJ.key) { LJ.key = k; const a = document.activeElement, act = a && el.contains(a) && a.dataset.act; el.innerHTML = ljViewHTML(runById(S.liveJob) || { id: S.liveJob, name: "Report run" }, LJ.v[S.liveJob]); const b = act && $(`#ljView [data-act="${act}"]`); if (b) b.focus({ preventScroll: true }); else if (act) $("#main").focus({ preventScroll: true }); } }
  if (S.route === "home" && LJ.runs.length) { const j = $("#jobCard"), k = viewKey(LJ.runs[LJ.runs.length - 1].id); if (j && j.dataset.k !== k && !j.contains(document.activeElement)) { j.dataset.k = k; j.innerHTML = liveCardHTML(); } }
  paintBell();
}
function askNotify() {
  const re = () => { const s = $("#ljNotify"); if (s) { s.outerHTML = notifyHTML(); $('[data-act="notifyme"]').focus(); } };
  if (LS.get("athena-notify", false) && Notification.permission === "granted") { LS.set("athena-notify", false); re(); return live("No browser notification for this run. The bell and the tab title still tell you."); }
  Notification.requestPermission().then(p => { if (p === "granted") LS.set("athena-notify", true); re();
    live(p === "granted" ? "A browser notification comes when the run ends." : "No browser notification. The bell and the tab title still tell you when the run ends."); });
}
if (APP) {
  setInterval(() => { // the elapsed time of an open run, once a second (the stages come with the 5 s poll)
    const v = S.liveJob && LJ.v[S.liveJob], t = $("#ljTime"); if (t && v && !v.gone && !ENDED.includes(v.state)) t.textContent = hms(runSecs(v));
    const r = LJ.runs[LJ.runs.length - 1], w = r && LJ.v[r.id], c = $("#ljCardTime"); if (c && w && !w.gone && !ENDED.includes(w.state)) c.textContent = hms(runSecs(w));
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollJobs(); });
  api("GET", JAPI + "/catalog").catch(e => { if (e.code === "disabled") { LJ.off = true; renderSide(); $$('[data-act="newreport"], [data-act="homechip"][data-i="0"]').forEach(b => b.insertAdjacentHTML("beforeend", laterTag())); } }); // the later tags on New report
}

/* ================= Library ================= */
// The catalog of shared editions: one immutable document per (issuer, form, period, language, edition), the same
// for every reader. Memos, questions and private revisions are each reader's overlay. Only the issuer entry has data.
const CAT = () => [
  { tk: FIL.ticker, nm: FIL.issuer, form: FIL.form, fy: "FY" + FY, real: true, st: JOB.state === "ready" ? "ready" : "writing", arch: false, lang: "en" },
  { tk: "CO-A", nm: "Sample company A", form: "10-K", fy: "FY2025", st: "writing", hl: "Sample: a demo replay of the writing page", arch: false, lang: "en" },
  { tk: "CO-C", nm: "Sample company C", form: "10-K", fy: "FY2025", st: "unwritten", hl: "Filed this week; not written yet", arch: false, lang: "en" },
  { tk: "CO-B", nm: "Sample company B", form: "13F", fy: "Q2 2026", st: "later", hl: "Holdings reports come later", arch: false, lang: "en" },
  { tk: FIL.ticker, nm: FIL.issuer, form: "10-K", fy: "FY" + (FY - 1), st: "archived", hl: "Archived edition", arch: true, lang: "en" },
];
const isYours = c => c.real && (S.threads.length > 0 || S.latest > 1); // memos, threads or a private revision
const REPLAY_TAG = `<span class="tag replay">Demo Replay</span>`;
const stateHTML = c => c.st === "ready" ? `<span class="tag">${c.real && !edShow() ? esc(edWords()) : "Ready to open"}</span> shared edition R1` : c.st === "writing" ? `<span class="tag">Being written</span> ${c.real ? "quick summary ready" : REPLAY_TAG}`
  : c.st === "unwritten" ? `<span class="tag dash">Later</span> not in this demo` : c.st === "later" ? `<span class="tag dash">Later</span> not in this demo` : `<span class="tag dash">Archived</span> not in this demo`;
function pltrStatusHTML() {
  const p = prog();
  if (JOB.state === "ready") return `<span class="tag">${edShow() ? "Ready to open" : esc(edWords())}</span> shared edition R1${S.latest > 1 ? ` · your Rev ${S.latest} (private)` : ""} · ${nOf(openThreads().length, "open note")}`;
  if (JOB.state === "stopped") return `<span class="tag dash">Stopped</span> at ${STEPS[p.step].name} · <button class="btn text" data-act="resume">Resume</button>`;
  return `<span class="tag">Being written</span> quick summary ready · step ${p.step + 1} of 6 · ${mmss(JOB.t)} <span class="tag demo">Demo timing</span>`;
}
// app mode: the editions the app server holds, each with its status; opening one loads its own page
function appLibraryHTML() {
  const f = S.libFilter, q = S.libQ.toLowerCase(), list = Array.isArray(LIB) ? LIB : [], forms = [...new Set(list.map(e => e.filing.form))];
  const all = list.filter(e => (f === "all" || e.filing.form === f) && (!q || (e.filing.ticker + " " + e.filing.issuer).toLowerCase().includes(q)));
  return `<div class="page-pad"><h1 class="ph1">Library</h1><p class="lead">Every report is a shared edition: written once, the same for every reader. Your memos, questions and revisions are kept apart from other readers.</p>
    <div class="libbar"><label class="vh" for="libQ">Search reports</label><input id="libQ" class="field" placeholder="Search by company or ticker" value="${esc(S.libQ)}">
      <div class="chiprow" role="group" aria-label="Filter">${[["all", "All"], ...forms.map(x => [x, x])].map(([k, l]) => `<button class="chip" data-act="libf" data-v="${esc(k)}" aria-pressed="${f === k}">${esc(l)}</button>`).join("")}</div></div>
    <div class="libgrid">${LIB === null ? `<p class="empty">Loading the editions…</p>` : LIB.err ? `<p class="empty">The editions could not be loaded: ${esc(LIB.err)}</p>`
      : all.map(e => { const cur = e.id === CFG.edition_id, n = e.review_findings.count;
        return `<a class="bcard" href="/reports/${e.id}#at=desk/summary">${cur ? `<canvas id="libRose" aria-hidden="true"></canvas>` : `<div class="blank" aria-hidden="true"></div>`}<div><div class="m">${esc(e.filing.ticker)} · ${esc(e.filing.form)} · FY${esc(e.filing.fiscal_year)} · ${e.language === "ko" ? "한국어" : "English"} · R${e.number}</div><div class="nm">${esc(e.filing.issuer)}</div>${cur ? `<div class="hl">${plainHTML(DOC.cover.headline)}</div>` : ""}<div class="st"><span class="tag">${esc(cap1(uword(e.status.publication_disposition)))}</span> <span class="tag">${esc(cap1(uword(e.status.quality_disposition)))}</span>${n ? ` ${nOf(n, "open review finding")}` : ""}</div></div></a>`; }).join("") || `<p class="empty">No reports match “${esc(S.libQ)}”.</p>`}</div>
    <h2 class="h2">Your open notes <span class="muted">${openThreads().length} open</span></h2>${notesHTML()}</div>`;
}
function libraryHTML() {
  if (APP) return appLibraryHTML();
  const f = S.libFilter, q = S.libQ.toLowerCase();
  const keep = c => f === "all" ? !c.arch : f === "archive" ? c.arch : f === "ready" || f === "writing" ? c.st === f : f === "yours" ? isYours(c) : c.form === f && !c.arch;
  const all = CAT().map((c, i) => ({ ...c, i })).filter(c => keep(c) && (!q || (c.tk + " " + c.nm).toLowerCase().includes(q)));
  return `<div class="page-pad"><h1 class="ph1">Library</h1><p class="lead">Every report is a shared edition: written once, the same for every reader. Your memos, questions and revisions are kept apart from other readers.</p>
    <div class="libbar"><label class="vh" for="libQ">Search reports</label><input id="libQ" class="field" placeholder="Search by company or ticker" value="${esc(S.libQ)}">
      <div class="chiprow" role="group" aria-label="Filter">${[["all", "All"], ["ready", APP ? "Ready to open" : "Open now"], ["writing", "Being written"], ["yours", "Yours"], ["10-K", "10-K"], ["13F", "13F"], ["archive", "Archive"]].map(([k, l]) => `<button class="chip" data-act="libf" data-v="${k}" aria-pressed="${f === k}">${l}</button>`).join("")}</div></div>
    <div class="libgrid">${all.map(c => c.real ? `<a class="bcard" href="#" data-go="${JOB.state === "ready" ? "desk" : "writing"}"><canvas id="libRose" aria-hidden="true"></canvas><div><div class="m">${esc(c.tk)} · ${c.form} · ${c.fy} · English</div><div class="nm">${esc(c.nm)}</div><div class="hl">${plainHTML(DOC.cover.headline)}</div><div class="st" id="pltrStatus">${pltrStatusHTML()}</div></div></a>`
      : `<a class="bcard sample" href="#" data-act="newfor" data-i="${c.i}" aria-label="${esc(c.nm + ", " + c.form + " " + c.fy + (c.st === "writing" ? "" : `, ${c.st === "archived" ? "archived" : "later"}, not in this demo`) + ": open New report for this filing")}"><div class="blank">${c.st === "writing" ? `<canvas data-skel aria-hidden="true"></canvas>` : "No figures in a sample card"}</div><div><div class="m">${c.tk ? esc(c.tk) + " · " : ""}${c.form} · ${esc(c.fy)} · <span class="tag dash">Sample card</span></div><div class="nm">${esc(c.nm)}</div><div class="hl">${esc(c.hl)}</div><div class="st">${stateHTML(c)}</div></div></a>`).join("") || `<p class="empty">${f === "yours" && !q ? "Nothing of yours yet. Memos, questions and private revisions you add appear here." : `No reports match “${esc(S.libQ)}”.`}</p>`}</div></div>`;
}
let skelT = 0;
function libraryAfter() {
  const c = $("#libRose"); c && rose(c, isPhone() ? 84 : 112, () => roseModel(docV()), () => JOB.state === "ready" ? { rev: S.latest, small: true } : { ...jobRoseOpts(), small: true });
  $$("canvas[data-skel]").forEach(cv => { cv.style.cssText = "width:100%;height:100%"; rose(cv, isPhone() ? 84 : 112, () => roseModel(DOC), () => ({ skeleton: true, written: 3 + (skelT % 6), small: true })); });
}
setInterval(() => { if (S && S.route === "library" && !RM.matches) { skelT++; $$("canvas[data-skel]").forEach(paintRose); } }, 1800);

/* ================= Desk ================= */
function dialHTML() {
  const n = Math.max(S.latest, 1), ang = n < 2 ? -50 : -50 + (S.view - 1) * 100 / (n - 1);
  return `<div class="dial" role="radiogroup" aria-label="Revision"><svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="13" fill="var(--ink-1)"/><circle cx="15" cy="15" r="10" fill="none" stroke="var(--ink-3)" stroke-width=".6" stroke-dasharray="1 2"/><g class="ix" style="transform:rotate(${ang}deg)"><line x1="15" y1="15" x2="15" y2="4" stroke="var(--win-index)" stroke-width="2" stroke-linecap="round"/></g></svg>
    ${Array.from({ length: n }, (_, i) => `<button role="radio" data-act="rev" data-v="${i + 1}" aria-checked="${S.view === i + 1}" aria-pressed="${S.view === i + 1}" title="${esc(i === 0 ? DOC.revision.summary : S.changed && S.changed.summary || "")}">R${i + 1}</button>`).join("")}</div>`;
}
function deskHTML() {
  return `<div class="desk">
    <div class="dk-main">
      <div class="mbar"><button class="ib" data-go="${S.deskFrom || "library"}" aria-label="Back to ${PLACE[S.deskFrom || "library"]}" title="Back to ${PLACE[S.deskFrom || "library"]}">${IC.back}</button><div class="who">${esc(shortIssuer())} · FY${FY}<small>${mbarSmall()}</small></div><span id="mDial">${dialHTML()}</span><button class="ib" data-act="conv" aria-pressed="${S.conv}" aria-label="Conversation">${IC.conv}</button><button class="ib dmb" data-act="demoopen" aria-haspopup="true" aria-label="Demo states">Demo</button></div>
      <div class="strip" id="strip" aria-label="Index"></div><div class="pedrow" id="pEd">${pEdHTML()}</div>
      <div class="bcol">
        <div class="binder" id="binder">
          <nav class="idx" id="idx" aria-label="Index tabs"></nav>
          <div class="sheetwrap"><article class="sheet" id="sheet"></article></div>
        </div>
        <div class="tray" id="tray"></div>
      </div>
    </div>
    <aside class="wpanel closed" id="wpanel" aria-label="Work sheet"></aside>
    <div class="stbar" id="stbar" hidden></div>
  </div>`;
}
// shared edition vs the reader's private revision, with a switch between them
// app mode: the tag carries the edition's status words, and "Status details" opens the delivery scope, the pipeline status
// and the open review findings (a disclosure; Esc or a click elsewhere closes it)
let ED_OPEN = false;
// a review finding in the reader's words: chapter, figure and quote names for the checker's ids, whole words for its
// shorthand, no markup fragments and no internal scope notes
const fdName = id => SRC[id] ? `“${SRC[id].label}” (${SRC[id].locator})` : F[id] ? `“${F[id].label}”` : secById(DOC, id) ? sheetTitle(id) : id;
const fdWords = m => String(m).replace(/^section ([a-z0-9-]+)(?:\/[a-z0-9-]+)?:/, (x, s) => secById(DOC, s) ? sheetTitle(s) + ":" : x)
  .replace(/: '[^']*\{[^']*'?$/, "").replace(/: '\s*([^']*?)\s*'?$/, (x, q) => /[.!?]$/.test(q) ? `: '${q}'` : (q = q.replace(/[\s,;:]*\S*$/, "")) ? `: '${q}…'` : "").replace(/\bLINT\s+/g, "").replace(/\bchars\b/g, "characters").replace(/\bkeypoint\b/g, "key point")
  .replace(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, fdName);
function edStatusHTML() {
  const n = (DOC.edition && DOC.edition.number) || 1, s = ED && ED.status, open = ED ? ED.review_findings.items.filter(x => x.status === "open") : [];
  // a partial edition reads partial or complete from its coverage: its delivery_complete covers the selected stage only
  const done = COV ? (HAVE.length < DOC.sections.length ? "partial" : "complete") : s && { true: "complete", false: "incomplete" }[s.delivery_complete] || "unknown";
  return `<span class="tag ed">Shared edition R${n} · ${esc(edWords())}</span>${ED ? `<details class="edd"${ED_OPEN ? " open" : ""}><summary class="btn text">Status details</summary><div class="edbox">
    ${edLabel() ? `<p class="edno edlab">${esc(edLabel())}</p>` : ""}${s.quality_disposition !== "accepted" ? `<p class="edno">Not an accepted report</p>` : ""}
    <dl class="edst"><dt>Publication</dt><dd>${esc(cap1(uword(s.publication_disposition)))}</dd><dt>Quality</dt><dd>${esc(cap1(uword(s.quality_disposition)))}</dd><dt>Delivery</dt><dd>${cap1(done)}${COV ? ` · ${HAVE.length} of ${DOC.sections.length} chapters in this edition` : ""}</dd><dt>Pipeline status</dt><dd>${esc(s.native_status)}</dd></dl>
    <h3 class="caps muted">Open review findings · ${ED.review_findings.count}</h3>${open.length ? `<ol class="edf">${open.map(x => `<li><b>${esc(cap1(String(x.class).replace(/\s*\([^)]*\)$/, "")))}</b> ${esc(fdWords(x.message))}</li>`).join("")}</ol>` : `<p class="muted">None.</p>`}</div></details>` : ""}${EDERR ? `<span class="apierr">Edition status could not be loaded: ${esc(EDERR)}</span>` : ""}${APIERR ? `<span class="apierr">${esc(APIERR)}</span>` : ""}`;
}
document.addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("edd")) ED_OPEN = e.target.open; }, true);
document.addEventListener("keydown", e => { const d = $("details.edd[open]"); if (e.key === "Escape" && d && d.contains(document.activeElement)) { e.stopPropagation(); d.open = false; $("summary", d).focus(); } }, true);
document.addEventListener("click", e => $$("details.edd[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; }));
const edTag = () => S.view === 1 && APP ? edStatusHTML() + (S.latest > 1 ? `<button class="btn text" data-act="rev" data-v="${S.latest}">Back to your Rev ${S.latest}</button>` : "")
  : S.view === 1 ? `<span class="tag ed">Shared edition R${(DOC.edition && DOC.edition.number) || 1} · ${esc(edWords())}</span>${S.latest > 1 ? `<button class="btn text" data-act="rev" data-v="${S.latest}">Back to your Rev ${S.latest}</button>` : ""}`
  : `<span class="tag ink">Your Rev ${S.view} · private · based on shared R1</span><button class="btn text" data-act="rev" data-v="1">View shared R1</button>`;
// phone: the same edition line and switch as the desktop sheet header
const pEdHTML = () => edTag() + (S.latest > 1 ? `<span class="muted">The shared edition R1 is unchanged for every reader.</span>` : "");
// the key to the page's marks, in the sticky sheet header: in sight wherever the page shows a quoted hairline, a
// calculated double rule or a teal filing-source tag; each swatch is the mark the page draws
const PKEY = `<span class="pkey" aria-label="Marks on this page"><span class="key">${SW("pq")}quoted</span><span class="key">${SW("pc")}calculated</span><span class="key">${SW("q")}filing source</span></span>`;
function sheetHeadHTML() {
  return `<header class="shead"><div class="id">${esc(FIL.issuer)} · Form ${esc(FIL.form)} · Fiscal ${FY}</div>
    <div class="r"><div class="seg" role="group" aria-label="View"><button data-act="conv" data-v="0" aria-pressed="${!S.conv}" tabindex="${S.conv ? -1 : 0}">Report</button><button data-act="conv" data-v="1" aria-pressed="${S.conv}" tabindex="${S.conv ? 0 : -1}">Conversation <span class="count">${S.threads.length}</span> <kbd>⌘J</kbd></button></div></div>
    <div class="acc"><span>ACC ${esc(FIL.accession)}</span><span>Period ended ${esc(FIL.period_end)}</span><span class="tag">${aiTag()}</span></div>
    <div class="edrow">${edTag()}</div>
    <div class="r">${PKEY}${dialHTML()}</div></header>`;
}
function renderSheet() {
  const sh = $("#sheet"); if (!sh) return;
  sh.setAttribute("aria-label", S.conv ? "Conversation" : sheetTitle(S.sheet));
  sh.innerHTML = sheetHeadHTML() + `<div class="rail" id="rail"><div class="in"><div class="ruler"></div><div class="vp" id="railVp"></div><div id="railMarks" role="toolbar" aria-orientation="vertical" aria-label="Figure map: one tick per figure in reading order. Filled = quoted from the filing, open = calculated."></div><span class="lab">Figure map</span></div></div>
    <div class="content" id="content">${S.conv ? convHTML() : sheetBodyHTML()}</div><div class="gutter" id="gutter"></div><aside class="lane" id="lane" aria-label="Margin: Probe and conversation"></aside><svg class="leaders" id="leaders" aria-hidden="true"></svg>`;
  afterSheet();
}
// figures on a sheet are one tab stop: a roving tabindex, arrows move between them (the figure map is the other path)
function rovingFigs(i) { const fs = $$("#content .fig"); if (!fs.length) return null; const n = clamp(i ?? Math.max(0, fs.findIndex(f => f.tabIndex === 0)), 0, fs.length - 1); fs.forEach((f, k) => f.tabIndex = k === n ? 0 : -1); return fs[n]; }
// the page's scroll padding clears the sticky sheet header and the chat bar, so focus moved by Tab or Shift+Tab never lands
// under them and a centred block sits in the band (WCAG 2.2 SC 2.4.11, scroll-padding for sticky chrome); the sticky chrome
// itself takes it back as a negative scroll margin (--padT, --padB), so focusing a control in it never scrolls the page. The
// phone keeps its stylesheet value
let PB = 0; // the chat bar's height from the window's foot, kept while the open tray replaces the bar, so a centred block never moves with it
// a browser reveals the caret after each key by the page's scroll padding, not the element's scroll margin. The tray's caret sits
// inside that band and the sticky tray never leaves it, so every key scrolled the page: while the reader types there, no padding
const typingTray = () => { const a = document.activeElement; return !!a && !!a.closest(".tray"); };
// the browser reveals a newly focused box before focusin fires, so a Tab inside the tray must not switch the padding on between two controls
const trayNode = n => !!(n && n.closest && n.closest(".tray"));
["focusin", "focusout"].forEach(t => document.addEventListener(t, e => { if (trayNode(e.target) && !(t === "focusout" && trayNode(e.relatedTarget))) padTop(); }));
function padTop() { const hd = S.route === "desk" && !isPhone() && $("#sheet .shead"), de = document.documentElement.style, tb = $("#trayBar");
  // the server's status strip is fixed at the top right: the sticky sheet header clears its measured foot (--stripB, app.css)
  const es = $("#edition-status"); if (es) de.setProperty("--stripB", Math.ceil(es.offsetTop + es.getBoundingClientRect().height) + "px"); else de.removeProperty("--stripB"); // not its screen position: off the Desk it scrolls with the page
  if (tb && tb.getClientRects().length) PB = Math.max(0, innerHeight - tb.getBoundingClientRect().top);
  de.scrollPaddingTop = hd ? hd.offsetHeight + 16 + "px" : ""; de.scrollPaddingBottom = hd && PB && !typingTray() ? PB + 16 + "px" : "";
  de.setProperty("--padT", de.scrollPaddingTop || "0px"); de.setProperty("--padB", de.scrollPaddingBottom || "0px"); }
function afterSheet() {
  writeHash(); padTop(); const pe = $("#pEd"); if (pe) pe.innerHTML = pEdHTML();
  const r = $("#sumRose"); if (r) summaryRoseInit(r);
  renderRail(); renderGutter(); paintAnchors(); markActiveFig(); { const v = activeProbe(); rovingFigs(v && v.el != null ? v.el : 0); }
  const m = $("#mDial"); if (m) m.innerHTML = dialHTML();
  clearST(); renderPanel();
}
function sheetBodyHTML() {
  const doc = docV();
  if (S.sheet === "summary") return summaryHTML(doc);
  if (S.sheet === "glossary") return glossaryHTML(doc);
  if (S.sheet === "references") return referencesHTML(doc);
  return chapterHTML(doc, secById(doc, S.sheet) || doc.sections[0]);
}
function footHTML() {
  const ids = sheetIds(), i = ids.indexOf(S.sheet), pv = ids[i - 1], nx = ids[i + 1];
  return `<nav class="sheetfoot" aria-label="Previous and next">${pv ? `<a href="#" data-sheet="${pv}"><small>‹ Previous</small><span>${esc(sheetTitle(pv))}</span></a>` : "<span></span>"}${nx ? `<a href="#" class="nx" data-sheet="${nx}"><small>Next ›</small><span>${esc(sheetTitle(nx))}</span></a>` : ""}</nav>`;
}
function blockHTML(sec, b) {
  const a = `data-block="${esc(b.id)}" data-section="${esc(sec.id)}"`;
  const pen = S.pencil && S.pencil.block === b.id && S.view === S.latest;
  const inked = S.inks[S.view], ink = inked && inked.block === b.id;
  const prev = ink && S.docs[inked.rev - 1] && blockOf(S.docs[inked.rev - 1], b.id);
  const body = t => pen ? diffHTML(t, S.pencil.text, "p-ins", "p-del") : ink ? diffHTML(prev ? prev.b.text : t, t, "p-new" + (inked.dry ? " dry" : ""), S.compare ? "p-del" : "") : inline(t);
  const mark = ink ? `<div class="inkmark"><span class="tag ink">Changed in your Rev ${inked.rev}</span><button class="btn text" data-act="compare" aria-pressed="${!!S.compare}">${S.compare ? "Hide" : "Show"} Rev ${inked.rev - 1} words</button>${S.compare && prev && !diffWords(prev.b.text, b.text).some(d => d.k === "-" && d.t.trim()) ? `<span class="cmpnote">Nothing from Rev ${inked.rev - 1} was removed; the marked words are new.</span>` : ""}</div>` : "";
  if (b.filing_table && !pen && !ink) { const h = filingTableHTML(b, a); if (h) return h; }
  if (b.kind === "prose") return `<div class="blk prose${ink ? " inked" : ""}" ${a}>${pen ? '<span class="pencil-tag">Pencil draft · not in the report yet</span>' : ""}${mark}<div class="txt">${body(b.text)}</div></div>`;
  if (b.kind === "callout") return `<div class="blk callout" ${a}><div class="lab">${esc(b.tone || "Note")}</div>${b.title ? `<div class="ttl2">${inline(b.title)}</div>` : ""}<div class="txt">${body(b.text)}</div></div>`;
  if (b.kind === "table") {
    const u = tableUnit(b), sub = b.subtitle || u, st = u ? "table" : "tablex";
    return `<div class="blk table" ${a}><div class="blk-t">${esc(b.title || "")}</div>${sub ? `<div class="blk-s">${esc(sub)}</div>` : ""}<div class="tbx"><table class="tbl"><thead><tr><th scope="col"><span class="vh">Line</span></th>${b.columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map(r => `<tr><td>${esc(r.label)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</td>${r.cells.map(c => `<td>${c ? figHTML(c, st) : "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${b.caption ? `<div class="cap">${inline(b.caption)}</div>` : ""}</div>`;
  }
  if (b.kind === "chart") return chartHTML(b, a);
  if (b.kind === "lab") return labHTML(b, a);
  return "";
}
// a table quoted from the filing (block.filing_table; the block's text is the same filing words as prose). Spacer cells drop
// out; the column groups are the cells of the deepest header row above the first row with a line label, and every other
// cell joins the group it starts in ("$" and its number share one cell). The lead-in and the notes are the lines of the
// block's text before and after the rows. A table whose cells do not fit its groups stays prose (null)
function filingTableHTML(b, a) {
  const t = b.filing_table, rows = (t.rows || []).map(r => r.filter(c => String(c.text).trim())).filter(r => r.length);
  const first = rows.findIndex(r => r[0].column === 0); if (first < 1) return null;
  const head = rows.slice(0, first), body = rows.slice(first), groups = head[head.length - 1].map(c => [c.column, c.column + (c.colspan || 1)]), L = groups[0][0];
  if (head.some(r => r.some(c => c.column < L))) return null;
  const lines = String(b.text).split("\n"), rl = rows.map(r => r.map(c => c.text).join(" "));
  const k = lines.findIndex((_, i) => rl.every((x, j) => lines[i + j] === x)); if (k < 0) return null;
  const before = lines.slice(0, k).join(" "), after = lines.slice(k + rl.length);
  const hrow = (r, leaf) => { let g = 0, h = leaf ? `<th scope="col"><span class="vh">Line</span></th>` : "<th></th>";
    for (const c of r) { const s = groups.findIndex(([x]) => x >= c.column), n = groups.filter(([x]) => x >= c.column && x < c.column + (c.colspan || 1)).length;
      if (!n || s < g) return null; h += "<th></th>".repeat(s - g) + `<th scope="col"${n > 1 ? ` colspan="${n}"` : ""}>${esc(c.text)}</th>`; g = s + n; }
    return `<tr>${h}${"<th></th>".repeat(groups.length - g)}</tr>`; };
  const brow = r => { const lab = r.filter(c => c.column < L).map(c => c.text).join(" "), cells = groups.map(() => []);
    for (const c of r.filter(c => c.column >= L)) { const gi = groups.findIndex(([x, y]) => c.column >= x && c.column < y); if (gi < 0) return null; cells[gi].push(c.text); }
    return `<tr><td>${esc(lab)}</td>${cells.map(v => `<td>${esc(v.join(" "))}</td>`).join("")}</tr>`; };
  const hs = head.map((r, i) => hrow(r, i === head.length - 1)), bs = body.map(brow); if (hs.includes(null) || bs.includes(null)) return null;
  const om = [t.omitted_before && "before", t.omitted_after && "after"].filter(Boolean).join(" and "), lid = "ft-" + esc(b.id);
  // the sideways-scrolling region is named for its own table (its top header), not only the caption every filing table shares
  const tn = head[0].map(c => c.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `<div class="blk table ftable" ${a}><div class="caps muted" id="${lid}">As stated in the filing text</div>${before ? `<p class="blk-s">${esc(before)}</p>` : ""}
    <div class="tbx" role="region" aria-label="As stated in the filing text${tn ? ": " + esc(tn) : ""}" tabindex="0"><table class="tbl"><thead>${hs.join("")}</thead><tbody>${bs.join("")}</tbody></table></div>
    ${om || after.length ? `<div class="cap">${om ? `<p>The saved excerpt omits filing text ${om} this excerpt.</p>` : ""}${after.map(x => `<p>${esc(x)}</p>`).join("")}</div>` : ""}</div>`;
}
// a table names its unit only when every cell shares it; otherwise each cell shows its own
const UNITNAME = { percent: "%", count: "count", times: "×" };
function tableUnit(b) {
  const us = new Set(b.rows.flatMap(r => r.cells.filter(c => F[c]).map(c => showsAsPrinted(F[c]) ? "printed" : spec(F[c], "table").unit || "count")));
  if (us.size !== 1 || us.has("printed")) return "";
  const u = [...us][0]; return UNITNAME[u] || u;
}
function chartHTML(b, a = "") {
  const vals = b.series.flatMap(s => s.facts.map(id => F[id] ? Number(shiftStr(F[id].value, spec(F[id], "chart").k)) : 0));
  const mx = Math.max(...vals, 0), step = mx <= 1 ? .25 : mx <= 5 ? 1 : mx <= 10 ? 2 : Math.pow(10, Math.floor(Math.log10(mx))), top = Math.max(step, Math.ceil(mx / step) * step);
  const guides = []; for (let v = 0; v <= top + 1e-9; v += step) guides.push(v);
  const u = b.series[0] && F[b.series[0].facts[0]] ? spec(F[b.series[0].facts[0]], "chart").unit : "";
  return `<div class="blk chart" ${a}><div class="blk-t">${esc(b.title || "")}</div><div class="blk-s">${esc(u)}${b.subtitle ? " · " + esc(b.subtitle) : ""}${b.series.map((s, i) => `<span class="swatch s${i % 3}"></span>${esc(s.label)}`).join("")}</div>
    <div class="plot" role="group" aria-label="${esc(b.title || "Chart")}">${guides.map(v => `<div class="guide ${v === 0 ? "zero" : ""}" style="bottom:${v / top * 100}%"><i>${+v.toFixed(2)}</i></div>`).join("")}
    <div class="groups">${b.periods.map((p, pi) => `<div class="group">${b.series.map((s, si) => { const id = s.facts[pi], f = F[id]; if (!f) return ""; const h = clamp(Number(shiftStr(f.value, spec(f, "chart").k)) / top) * 100;
      return `<button type="button" class="fig bar s${si % 3} ${f.kind === "calculated" ? "c" : ""}" data-fact="${esc(id)}" style="height:${h}%" aria-label="${esc(s.label + " " + p + ", " + fmt(f, "kpi"))}"><b>${fmt(f, "chart")}</b></button>`; }).join("")}<em>${esc(p)}</em></div>`).join("")}</div></div>${b.caption ? `<div class="cap">${inline(b.caption)}</div>` : ""}</div>`;
}
function absentHTML(sec) {
  return `<div class="placeholder"><b>Not in this edition</b>This edition has ${HAVE.length} of ${DOC.sections.length} chapters. ${sec.absent === "failed"
    ? "This chapter was left out because it did not pass the checks." : "This chapter was not part of this run; it is planned for a later edition."} There is no text or figure for it here.</div>`;
}
function chapterHTML(doc, sec) {
  const empty = !sec.blocks.length;
  return `<p class="kicker">Chapter <span class="chnum">${secNum(sec)}</span> of ${doc.sections.length}</p>
    <h1 class="ttl">${esc(sec.title)}</h1><p class="question">${esc(sec.question || "")}</p>
    ${sec.keypoint ? `<div class="keypoint" data-block="kp-${esc(sec.id)}" data-section="${esc(sec.id)}"><span class="caps">Key point</span><p class="txt">${sec.keypoint === PLACEHOLDER_KP ? `<span class="muted">${PLACEHOLDER_KP}</span>` : inline(sec.keypoint)}</p></div>` : ""}
    ${sec.absent ? absentHTML(sec) : empty ? `<div class="placeholder"><b>Content arrives with the full data.</b>This prototype's data block has no text or figures for this chapter yet. The tab, the question and the rosette sector are in place.</div>` : sec.blocks.map(b => blockHTML(sec, b)).join("")}
    ${footHTML()}`;
}
function gaugeHTML(k) {
  const f = F[k.fact]; if (!f) return "";
  const d = k.delta && F[k.delta], cmp = k.compare && F[k.compare];
  const priorId = cmp ? k.compare : d ? d.inputs.find(i => i !== k.fact && F[i] && F[i].unit === f.unit) : null, prior = priorId && F[priorId];
  const sp = spec(f, "kpi"), val = Number(shiftStr(f.value, sp.k)), pv = prior ? Number(shiftStr(prior.value, sp.k)) : 0;
  const mx = Math.max(val, pv, 1e-9) * 1.15, mag = Math.pow(10, Math.floor(Math.log10(mx))), top = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= mx) || mx;
  const pos = v => clamp(v / top) * 100;
  return `<div class="gauge-c"><div class="l">${esc(k.label)}</div><div class="v">${figHTML(k.fact, "kpi")}</div>
    <div class="gauge" aria-hidden="true"><div class="ticks"></div><div class="base"></div>${prior ? `<div class="prior" style="left:${pos(pv)}%" title="${esc(prior.period)}"></div>` : ""}<div class="needle" style="left:${pos(val)}%"></div><span class="lo">0</span><span class="hi">${+top.toPrecision(3)}${esc(sp.post.trim() === "%" ? "%" : sp.post.trim() === "pp" ? "" : sp.post.trim())}</span></div>
    <div class="d">${d ? `${Number(d.value) >= 0 ? "▲" : "▼"} ${figHTML(k.delta, "kpi")} vs ${esc(prior ? prior.period : "prior year")}` : cmp ? `vs ${figHTML(k.compare, "kpi")}` : ""}${k.note ? (d || cmp ? " · " : "") + esc(k.note) : ""}</div></div>`;
}
function summaryHTML(doc) {
  const c = doc.cover, M = roseModel(doc), nQ = new Set(), nC = new Set();
  M.forEach(m => m.ids.forEach(id => (F[id].kind === "calculated" ? nC : nQ).add(id)));
  return `${DOC.status === "stub" ? `<p class="stubnote">${esc(DOC.stub_note || "Stub data")} Swap in the full data with build.py.</p>` : ""}
    <div class="hero"><div class="hero-l">
    <p class="kicker">Summary · ${esc(FIL.issuer)} · ${FIL.form} FY${FY}</p>
    <h1 class="headline" data-block="headline" data-section="summary"><span class="txt">${inline(c.headline)}</span></h1>
    <p class="stand">${inline(c.standfirst)}</p>
    </div><div class="hero-b">
    ${c.kpis ? `<div class="gauges" data-block="${esc(c.kpis.id || "kpis")}" data-section="summary">${c.kpis.items.map(gaugeHTML).join("")}</div>` : ""}
    <div class="legend"><span><span class="lq">hairline</span> ${SW("pq")}quoted from the filing</span><span><span class="lc">double rule</span> ${SW("pc")}calculated by code</span><span>gauges start at zero; the short tick is the prior year</span></div>
    </div>
      <div class="rosewrap"><div class="rose" id="sumRoseBox"><canvas id="sumRose" aria-hidden="true"></canvas><svg id="sumHit" role="group" aria-label="Rosette: one sector per chapter. Hover or arrow keys move between sectors; Enter opens the chapter."></svg></div>
        <div class="rosecap" id="roseCap" aria-live="polite"></div></div></div>
    ${c.blocks && c.blocks.length || c.keypoint ? `<section class="sumprose"${c.title ? ' aria-labelledby="spH"' : ""}>${c.title ? `<h2 class="h2" id="spH">${esc(c.title)}</h2>` : ""}${c.keypoint ? `<div class="keypoint" data-block="kp-summary" data-section="summary"><span class="caps">Key point</span><p class="txt">${inline(c.keypoint)}</p></div>` : ""}${(c.blocks || []).map(b => blockHTML({ id: "summary" }, b)).join("")}</section>` : ""}
    <section class="glance" aria-labelledby="glH">
      <div><h2 class="h2" id="glH" style="margin-top:0">Chapters at a glance</h2><ol class="chlist">${doc.sections.map((s, i) => { const kp = (doc.digest || DOC.digest || []).find(d => d.section === s.id); const k = kp ? kp.keypoint : s.keypoint;
        return `<li><a href="#" data-sheet="${s.id}" data-si="${i}"><b>${secNum(s)}</b><span class="t">${esc(s.title)}</span>${s.absent ? `<span class="k ph">${absentShort(s)}</span>` : k ? `<span class="k ${k === PLACEHOLDER_KP ? "ph" : ""}">${plainHTML(k)}</span>` : ""}</a></li>`; }).join("")}</ol></div>
    </section>
    <div class="rlegend"><h3>What the rings mean</h3><ul><li>One sector per chapter, clockwise from the top: 01 to ${pad2(doc.sections.length)}.${HAVE.length < doc.sections.length ? ` This edition has ${HAVE.length} of them; a sector with a dotted base and no rings is a chapter not in this edition.` : ""}</li><li>One ring per figure the chapter cites: quoted figures form the core (single line), calculated figures the outer rings (double line). Here: ${nQ.size} quoted, ${nC.size} calculated.</li><li>Each ring's waves come from its own figure: rhythm from the fiscal year, swing from the size, fine waves from the digits. No two reports draw the same rosette.</li><li>The rim is the filing's own lines in microtext; the centre carries the revision number.</li></ul></div>
    ${c.chart ? `<div style="margin-top:36px">${chartHTML(c.chart, `data-block="${esc(c.chart.id || "cover-chart")}" data-section="summary"`)}</div>` : ""}
    ${footHTML()}`;
}
function summaryRoseInit(cv) {
  const box = $("#sumRoseBox"), px = box.clientWidth || 300;
  rose(cv, px, () => roseModel(docV()), () => ({ rev: S.view, hi: S.focusSector, ring: S.changed && S.view === S.changed.rev ? S.changed.ring : null, drawnAt: S.changed && S.changed.at && S.view === S.changed.rev ? { [S.changed.sector]: S.changed.at } : null }));
  const M = roseModel(docV()), G = roseGeom(px, M, false), svg = $("#sumHit");
  svg.setAttribute("viewBox", `0 0 ${px} ${px}`);
  const pt = (r, t) => `${(G.c + r * Math.cos(t)).toFixed(1)} ${(G.c + r * Math.sin(t)).toFixed(1)}`;
  svg.innerHTML = M.map(m => { const a0 = G.a0(m.i) - G.gap / 2, a1 = G.a1(m.i) + G.gap / 2, r1 = px * .45, r0 = px * .14, kp = (DOC.digest || []).find(d => d.section === m.s.id);
    return `<path d="M${pt(r0, a0)} L${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 0 0 ${pt(r0, a0)}Z" data-si="${m.i}" tabindex="${m.i === (S.focusSector ?? 0) ? 0 : -1}" role="button" aria-label="${esc(secNum(m.s) + " " + m.s.title + ". " + (m.s.absent ? absentShort(m.s) + "." : (k => k ? plain(k) + " " : "")(kp ? kp.keypoint : m.s.keypoint) + m.ids.length + " figures."))}"></path>`; }).join("");
  roseCaption();
}
function roseCaption() {
  const cap = $("#roseCap"); if (!cap) return; const i = S.focusSector, doc = docV();
  $$(".chlist a").forEach(a => a.classList.toggle("on", +a.dataset.si === i));
  if (i == null) { cap.innerHTML = `<span class="muted">Hover or focus a sector to read its chapter's key point. ${S.changed && S.view === S.changed.rev ? `The highlighted ring is the figure Rev ${S.changed.rev} added.` : ""}</span>`; return; }
  const m = roseModel(doc)[i], kp = (doc.digest || DOC.digest || []).find(d => d.section === m.s.id);
  if (m.s.absent) { cap.innerHTML = `<b>${secNum(m.s)} · ${esc(m.s.title)}</b> · ${absentShort(m.s)}<a href="#" data-sheet="${m.s.id}" class="btn text" style="padding:0;min-height:30px">Open chapter ›</a>`; return; }
  cap.innerHTML = `<b>${secNum(m.s)} · ${esc(m.s.title)}</b> · ${m.ids.length} figure${m.ids.length === 1 ? "" : "s"} (${m.nq} quoted, ${m.ids.length - m.nq} calculated)${(k => k ? `<span class="kp">${plainHTML(k)}</span>` : "")(kp ? kp.keypoint : m.s.keypoint)}<a href="#" data-sheet="${m.s.id}" class="btn text" style="padding:0;min-height:30px">Open chapter ›</a>`;
}
function focusSector(i, moveFocus) {
  S.focusSector = i; const cv = $("#sumRose"); cv && paintRose(cv); roseCaption();
  $$("#sumHit path").forEach(p => p.setAttribute("tabindex", +p.dataset.si === (i ?? 0) ? 0 : -1));
  if (moveFocus) { const p = $(`#sumHit path[data-si="${i}"]`); p && p.focus(); }
}
function glossaryHTML(doc) {
  const g = DOC.glossary || [];
  return `<p class="kicker">Glossary</p><h1 class="ttl">Terms used in this report</h1><p class="question">Each term links to the figures that use it.</p><span class="tag">${aiTag()}</span>
    <dl class="gl">${g.map(t => `<dt>${esc(t.term)}</dt><dd>${inline(t.definition)}${t.facts && t.facts.length ? `<div class="uses">In this report: ${t.facts.filter(id => F[id]).map(id => `${esc(F[id].label)} ${esc(F[id].period)} ${figHTML(id, "kpi")}`).join(" · ")}</div>` : ""}</dd>`).join("")}</dl>${footHTML()}`;
}
function usersOf(fid, doc = docV()) { // chapters and sheets that cite a fact
  const out = []; doc.sections.forEach(s => sectionFacts(s).includes(fid) && out.push(s.id));
  const c = doc.cover; if (textFacts(c.headline).includes(fid) || (c.kpis && c.kpis.items.some(k => [k.fact, k.delta, k.compare].includes(fid))) || (c.chart && c.chart.series.some(s => s.facts.includes(fid)))) out.unshift("summary");
  return out;
}
// calculated figures built (at any depth) on a figure quoted from this source
const FEEDS = sid => DOC.facts.filter(f => f.kind === "calculated" && leavesOf(f.id).some(l => F[l].source === sid));
function referencesHTML(doc) {
  return `<p class="kicker">References</p><h1 class="ttl">Filing lines this report quotes</h1><p class="question">Verbatim from ${esc(FIL.issuer)}'s ${FIL.form} for FY${FY}, accession <span class="mono">${esc(FIL.accession)}</span>.</p>
    <ol class="refs">${DOC.sources.map(s => { const figs = DOC.facts.filter(f => f.source === s.id), secs = [...new Set(figs.flatMap(f => usersOf(f.id, doc)))];
      return `<li id="ref-${esc(s.id)}" class="${S.litSrc === s.id ? "lit" : ""}" tabindex="-1"><div class="id">${esc(s.id)} · ${esc(s.locator)}</div><div class="lbl">${esc(s.label)}</div><div class="qt">${markQuote(s.id, figs.map(f => f.id))}</div><div class="loc">Form ${FIL.form} · accession <span class="mono">${esc(s.accession || FIL.accession)}</span></div>
        <div class="back">Figures: ${figs.map(f => `${esc(f.label)} ${esc(f.period)} ${figHTML(f.id, "kpi")}`).join(" · ") || "—"}${(fd => fd.length ? `<br>Feeds: ${fd.map(f => `<button class="btn text inl" data-act="probefact" data-fact="${esc(f.id)}">${esc(lc1(f.label))} ${esc(f.period)}</button>`).join(" · ")}` : "")(FEEDS(s.id))}${secs.length ? `<br>Used in: ${secs.map(id => `<a href="#" data-sheet="${id}">${esc(sheetTitle(id))}</a>`).join(" · ")}` : ""}</div></li>`; }).join("")}</ol>${(DOC.appendix || []).filter(x => x.id === "sources").map(x => `<section class="sumprose" aria-labelledby="ap-${esc(x.id)}"><h2 class="h2" id="ap-${esc(x.id)}">${esc(x.title)}</h2>${x.blocks.map(b => blockHTML({ id: "references" }, b)).join("")}</section>`).join("")}${footHTML()}`;
}
function labHTML(b, a) {
  return `<div class="blk lab" ${a}><div class="blk-t">Price and assumptions lab</div><div class="blk-s">Outputs use the number you type, never a figure from the filing.</div>
    <div class="lab-box" style="margin-top:10px">${b.inputs.map(id => { const as = ASM[id] || { label: id, why: "" };
      return `<div class="lab-ask"><span class="who">Athena</span><p id="labAsk" role="status">${esc(labAsk(as))}</p></div>
      <div class="lab-in"><label class="lb" for="lab-${esc(id)}" style="margin:0">${esc(as.label)}, $ · your input</label><input id="lab-${esc(id)}" data-lab="${esc(id)}" class="field" inputmode="decimal" placeholder="Type a price" value="${esc(S.price)}" autocomplete="off"><span class="muted" style="font-size:12.5px">${esc(as.why)}</span></div>`; }).join("")}
      <div class="lab-out" id="labOut-${esc(b.id)}">${labOutHTML(b)}</div></div></div>`;
}
// the reader's price: positive dollars only; anything else gets a plain message and no outputs
function priceIn() {
  const raw = String(S.price || "").trim(), t = raw.replace(/,/g, "").replace(/^\$/, "");
  if (!raw) return { ok: false, empty: true };
  if (!/^\d+(\.\d+)?$/.test(t) || !(Number(t) > 0) || Number(t) > 1e6) return { ok: false, raw };
  return { ok: true, val: Number(t) };
}
const usd = (v, dp = 2) => v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
function labAsk(as) {
  const pi = priceIn(), what = lc1((as || ASM.price || { label: "Share price" }).label);
  if (pi.empty) return `What ${what} should I use? Athena does not fetch market prices in this demo, so the lab waits for yours.`;
  if (!pi.ok) return `“${pi.raw}” is not a price I can use. Enter a positive number of dollars, for example 150 or 150.25.`;
  return `Using your ${what} of $${usd(pi.val)}.`;
}
function labOutHTML(b) {
  const pi = priceIn(), price = pi.val, have = pi.ok;
  if (!have && !pi.empty) return `<p class="labmsg" role="status">No outputs for “${esc(pi.raw)}”: the lab needs a positive price in dollars, for example 150.</p>`;
  return b.outputs.map(o => {
    let v = null; const parts = [];
    if (have) {
      const expr = ftoks(o.formula).map(t => { if (ASM[t]) { parts.push(`your $${usd(price)}`); return String(price); } if (F[t]) { parts.push(`${F[t].label} ${fmt(F[t], "kpi")} (${F[t].kind === "calculated" ? "calculated" : "from the filing"})`); return String(Number(F[t].value) * 10 ** (SHIFT[F[t].scale] ?? 0)); } if (OPS[t]) { parts.push(OPS[t]); return t.replace("÷", "/").replace("×", "*").replace("−", "-"); } if (/^[()]$|^\d+(\.\d+)?$/.test(t)) { parts.push(t); return t; } return "NaN"; }).join(" ");
      v = Function("return (" + expr + ")")();
    }
    const show = v == null || !isFinite(v) ? "—" : o.unit === "ratio" ? usd(v * 100, 1) + "%" : o.unit === "multiple" ? usd(v, 1) + "×" : o.unit === "usd" ? (v < 0 ? "−$" : "$") + usd(Math.abs(v / 1e9)) + "B" : usd(v);
    return `<div class="r"><span>${esc(o.label)}</span><span class="v">${show}</span>${have ? `<span class="w">${esc(parts.join(" "))} → ${show}</span><span class="uses">Computed in your browser from your price · not from the filing</span>` : `<span class="w">${esc(ftoks(o.formula).map(t => ASM[t] ? "your price" : F[t] ? lc1(F[t].label) : OPS[t] || t).join(" "))}</span>`}</div>`;
  }).join("");
}

/* ---------- index tabs ---------- */
function tabCounts(id) {
  const ts = S.threads.filter(t => t.status === "open" && t.anchor && t.anchor.section_id === id);
  return { q: ts.filter(t => t.kind !== "note").length, memo: ts.some(t => t.kind === "note") };
}
function renderTabs() {
  const doc = docV(), items = sheetIds().map(id => { const s = secById(doc, id); return { id, n: s ? secNum(s) : id === "summary" ? "S" : id === "glossary" ? "G" : "R", t: sheetTitle(id, true), empty: s && !s.blocks.length, absent: s && s.absent }; });
  const idx = $("#idx");
  if (idx) idx.innerHTML = `<ol>${items.map((it, i) => { const c = tabCounts(it.id), cur = !S.conv && S.sheet === it.id;
    return `${i === 1 || i === items.length - 2 ? '<li class="sep" aria-hidden="true"></li>' : ""}<li><button class="tabk" data-sheet="${it.id}" aria-current="${cur}" tabindex="${it.id === S.sheet ? 0 : -1}" title="${esc(sheetTitle(it.id))}${c.q ? ` · ${c.q} open question${c.q > 1 ? "s" : ""}` : ""}${c.memo ? " · memo" : ""}${it.absent ? " · not in this edition" : it.empty ? " · content arrives with the full data" : ""}" aria-label="${esc(sheetTitle(it.id))}${it.absent ? ", not in this edition" : ""}${c.q ? `, ${nOf(c.q, "open question")}` : ""}${c.memo ? ", has a memo" : ""}"><b>${it.n}</b><span class="t">${esc(it.t)}</span>${c.q ? `<span class="th">${c.q}</span>` : ""}${c.memo ? '<span class="mf" aria-hidden="true"></span>' : ""}${it.empty ? '<span class="empty-dot" aria-hidden="true"></span>' : ""}</button></li>`; }).join("")}</ol>`;
  const st = $("#strip");
  if (st) { st.innerHTML = `<button class="ixb" data-act="index" aria-haspopup="dialog">Index</button>` + items.map(it => { const c = tabCounts(it.id); return `<button data-sheet="${it.id}" aria-current="${!S.conv && S.sheet === it.id}" aria-label="${esc(sheetTitle(it.id))}${it.absent ? ", not in this edition" : ""}">${it.n === "S" ? "Summary" : it.n === "G" ? "Glossary" : it.n === "R" ? "Refs" : it.n}${c.q || c.memo ? '<span class="th"></span>' : ""}</button>`; }).join("");
    const cur = $('[aria-current="true"]', st); if (cur) st.scrollLeft = Math.max(0, cur.offsetLeft - 60); }
}
function indexHTML() {
  const doc = docV();
  return `<div class="modal" data-act="closeindex-scrim"><div class="mbox" role="dialog" aria-modal="true" aria-labelledby="ixT"><div class="caps muted">${esc(shortIssuer())} · ${FIL.form} FY${FY}</div><h2 id="ixT">Index</h2>
    <ol class="chlist">${sheetIds().map(id => { const s = secById(doc, id), c = tabCounts(id); return `<li><a href="#" data-sheet="${id}" class="${S.sheet === id ? "on" : ""}"><b>${s ? secNum(s) : "·"}</b><span class="t">${esc(sheetTitle(id, true))}${c.q ? ` <span class="count" style="color:var(--accent)">${c.q} open</span>` : ""}${c.memo ? ' <span class="mk memo" style="margin:0 0 -1px 4px;width:9px;height:9px"></span>' : ""}</span><span class="k ${s && !s.blocks.length ? "ph" : ""}">${s && s.absent ? absentShort(s) : s ? esc(s.question || "") : id === "summary" ? "Headline, gauges and the rosette" : id === "glossary" ? "Terms and the figures that use them" : "Every filing line, with backlinks"}</span></a></li>`; }).join("")}</ol>
    <div class="acts" style="justify-content:flex-end"><button class="btn text" data-act="closeindex">Close</button></div></div></div>`;
}

/* ---------- scale rail: the sheet's figure map ---------- */
function renderRail() {
  const box = $("#railMarks"), content = $("#content"); if (!box || !content) return;
  const figs = $$(".fig", content), H = content.scrollHeight || 1, top0 = content.getBoundingClientRect().top;
  const act = activeProbe();
  let last = -99;
  box.innerHTML = figs.map((el, i) => { const f = F[el.dataset.fact]; let y = clamp((el.getBoundingClientRect().top - top0) / H) * 100; if (y - last < .6) y = last + .6; last = y;
    return `<button class="rk ${f.kind === "calculated" ? "c" : ""} ${act && act.el === i ? "on" : ""}" style="top:calc(12px + ${y.toFixed(2)}% * (100% - 24px) / 100%)" data-ri="${i}" tabindex="${i === (act && act.el != null ? act.el : 0) ? 0 : -1}" aria-label="${esc(`Figure ${i + 1} of ${figs.length}: ${f.label} ${f.period}, ${fmt(f, "kpi")}, ${f.kind === "calculated" ? "calculated" : "quoted"}`)}"><i></i></button>`; }).join("");
  $$(".rk", box).forEach(b => { b.style.top = `calc(12px + (100% - 24px) * ${parseFloat(b.style.top.match(/([\d.]+)%/)[1]) / 100})`; });
  railViewport();
}
function railViewport() {
  const vp = $("#railVp"), content = $("#content"); if (!vp || !content) return;
  const r = content.getBoundingClientRect(), H = content.scrollHeight || 1, a = clamp(-r.top / H), b = clamp((innerHeight - r.top) / H);
  vp.style.top = `calc(12px + (100% - 24px) * ${a})`; vp.style.height = `calc((100% - 24px) * ${Math.max(.02, b - a)})`;
}
let layRAF = 0;
addEventListener("scroll", () => { if (S && S.route === "desk") { railViewport(); positionToolbar(); if (!layRAF) layRAF = requestAnimationFrame(() => { layRAF = 0; layLane(); stLead && stLead(); }); } }, { passive: true });
addEventListener("resize", () => { padTop(); if (S && S.route === "desk") { const r = $("#sumRose"); r && summaryRoseInit(r); renderPanel(); renderGutter(); if (S.st) S.st.side = null; renderST(); } });

/* ---------- anchors (W3C TextQuoteSelector inside one block) ---------- */
const blockEl = bid => $(`#content [data-block="${CSS.escape(bid)}"]`);
const txtEl = bid => { const b = blockEl(bid); return b && $(".txt", b); };
const CHIP = ".per, .stag, .pencil-tag";
function textNodes(el) { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest(CHIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); const out = []; let n; while ((n = w.nextNode())) out.push(n); return out; }
const anchorText = el => textNodes(el).map(n => n.data).join("");
function posIn(host, c, o) {
  const ns = textNodes(host); let p = 0;
  if (c.nodeType === 3) { const k = ns.indexOf(c); if (k >= 0) { for (let i = 0; i < k; i++) p += ns[i].data.length; return p + o; } }
  const b = document.createRange(); b.setStart(c, o);
  for (const n of ns) { if (b.comparePoint(n, n.data.length) <= 0) p += n.data.length; else break; }
  return p;
}
function rangeAt(el, start, end) {
  const r = document.createRange(); let pos = 0, set = false;
  for (const n of textNodes(el)) { const len = n.data.length;
    if (!set && start <= pos + len) { r.setStart(n, start - pos); set = true; }
    if (set && end <= pos + len) { r.setEnd(n, end - pos); return r; }
    pos += len; }
  return null;
}
function findAnchor(a) {
  if (a.fact) { const el = $$(`#content [data-block="${CSS.escape(a.block_id || "")}"] .fig[data-fact="${CSS.escape(a.fact)}"]`)[0] || $(`#content .fig[data-fact="${CSS.escape(a.fact)}"]`); if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); return r; }
  const el = txtEl(a.block_id); if (!el) return null;
  const t = anchorText(el); let at = -1, i = -1;
  while ((i = t.indexOf(a.exact, i + 1)) !== -1) { at = i; if (!a.prefix || t.slice(0, i).endsWith(a.prefix.slice(-12))) break; }
  return at < 0 ? null : rangeAt(el, at, at + a.exact.length);
}
function anchorFromRange(range) {
  const node = range.commonAncestorContainer, host = (node.nodeType === 1 ? node : node.parentElement).closest(".txt");
  if (!host || !host.closest("#content")) return { cross: true };
  const blk = host.closest("[data-block]"), t = anchorText(host);
  const s = posIn(host, range.startContainer, range.startOffset), e = posIn(host, range.endContainer, range.endOffset);
  let exact = t.slice(s, e); const lead = exact.length - exact.trimStart().length; exact = exact.trim(); if (!exact) return null;
  const s2 = s + lead, e2 = s2 + exact.length;
  return { revision_id: "rev-" + S.view, section_id: blk.dataset.section, block_id: blk.dataset.block, exact: exact.slice(0, 600), prefix: t.slice(Math.max(0, s2 - 64), s2), suffix: t.slice(e2, e2 + 64) };
}
function anchorState(th) {
  if (!th.anchor || !th.anchor.section_id) return { st: "report" };
  const born = +th.anchor.revision_id.slice(4), onSheet = !S.conv && th.anchor.section_id === S.sheet;
  if (S.view < born) return { st: "later" };
  if (S.view === born) return { st: "here", range: onSheet ? findAnchor(th.anchor) : null };
  const blk = th.anchor.block_id && blockOf(docV(), th.anchor.block_id);
  if (th.anchor.fact) return { st: "carried", range: onSheet ? findAnchor(th.anchor) : null };
  if (blk && th.anchor.exact && !plain(blk.b.text).includes(th.anchor.exact)) return { st: "outdated" };
  return { st: "carried", range: onSheet ? findAnchor(th.anchor) : null };
}
function paintAnchors() {
  if (!window.Highlight || !CSS.highlights) return;
  const ai = new Highlight(), memo = new Highlight(), act = new Highlight(), top = topView();
  if (S.route === "desk" && !S.conv) S.threads.forEach(th => {
    if (th.status !== "open") return; const a = anchorState(th); if (!a.range || th.anchor.fact) return;
    (top && top.t === "thread" && top.id === th.id ? act : th.kind === "note" ? memo : ai).add(a.range);
  });
  if (top && top.t === "compose" && top.anchor && !top.anchor.fact && top.anchor.section_id === S.sheet) { const r = findAnchor(top.anchor); r && act.add(r); }
  CSS.highlights.set("hl-ai", ai); CSS.highlights.set("hl-memo", memo); CSS.highlights.set("hl-act", act);
}
function renderGutter() {
  const g = $("#gutter"); if (!g) return; if (S.conv) { g.innerHTML = ""; return; }
  const gt = g.getBoundingClientRect().top, used = {};
  g.innerHTML = S.threads.filter(t => t.status === "open" && t.anchor && t.anchor.section_id === S.sheet && anchorState(t).st !== "later").map(th => {
    const a = anchorState(th), b = th.anchor.block_id && blockEl(th.anchor.block_id); let y;
    if (a.range) { const rs = a.range.getClientRects(); y = (rs[0] || a.range.getBoundingClientRect()).top - gt - 6; } else if (b) y = b.getBoundingClientRect().top - gt; else return "";
    const key = Math.round(y / 30); while (used[key + (used[key] || 0) * 0] && used[key] > 2) break; const off = (used[key] = (used[key] || 0) + 1) - 1;
    const kind = th.kind === "note" ? "memo" : th.messages[0].mode === "edit" ? "edit" : "ai";
    return `<button class="gm" style="top:${(y + off * 32).toFixed(0)}px${a.st === "outdated" ? ";opacity:.6" : ""}" data-act="openthread" data-th="${th.id}" aria-label="${kind === "memo" ? "Memo" : kind === "edit" ? "Suggested edit" : "Question"}${a.st === "outdated" ? ", written on an earlier revision" : ""}: ${esc(th.anchor.exact)}"><span class="mk ${kind}"></span></button>`;
  }).join("");
}

/* ---------- conversation (⌘J) ---------- */
function convHTML() {
  const f = S.convFilter, kindOf = t => t.kind === "note" ? "memo" : t.messages[0].mode === "edit" ? "edit" : "ai";
  const pass = t => f === "all" || (f === "memo" && kindOf(t) === "memo") || (f === "ai" && kindOf(t) === "ai") || (f === "edit" && kindOf(t) === "edit") || (f === "open" && t.status === "open") || (f === "resolved" && t.status === "resolved");
  const groups = ["summary", ...docV().sections.map(s => s.id), null].map(id => ({ id, ts: S.threads.filter(t => pass(t) && ((t.anchor && t.anchor.section_id) || null) === id) })).filter(g => g.ts.length);
  // wide enough for two readable panes: the list on the left, the selected thread in full on the right (first open one by default)
  const two = CONV2.matches && !isPhone(), shown = groups.flatMap(g => g.ts), sel = two ? shown.find(t => t.id === S.convSel) || shown.find(t => t.status === "open") || shown[0] : null;
  return `<div class="conv${two ? " two" : ""}"><p class="kicker">Conversation · ${nOf(S.threads.length, "thread")}</p><h1>Every note and question in this report</h1>
    <div class="chiprow" role="group" aria-label="Filter">${[["all", "All"], ["memo", "Memos"], ["ai", "Questions"], ["edit", "Edits"], ["open", "Open"], ["resolved", "Resolved"]].map(([k, l]) => `<button class="chip" data-act="convf" data-v="${k}" aria-pressed="${f === k}" tabindex="${f === k ? 0 : -1}">${l}</button>`).join("")}</div>
    <div class="cpanes"><div class="clist">${groups.map(g => `<div class="grp">${esc(g.id ? sheetTitle(g.id) : "Whole report")}</div>${g.ts.map(t => tcardHTML(t, t === sel)).join("")}`).join("") || `<p class="empty">${S.threads.length ? "Nothing matches this filter." : "No notes or questions yet."}</p>`}</div>${two ? `<section class="cpane" aria-label="Selected thread">${convPaneHTML(sel)}</section>` : ""}</div>
    <p class="muted" style="font-size:12.5px;margin-top:24px">⌘J returns to the report. ${two ? "Go to chapter opens a thread at its words." : "Opening a thread takes you to its chapter."}</p></div>`;
}
const CONV2 = matchMedia("(min-width: 1200px)");
CONV2.addEventListener("change", () => { if (S && S.route === "desk" && S.conv) { renderSheet(); renderPanel(); } });
function convPaneHTML(th) {
  if (!th) return `<p class="empty">${S.threads.length ? "Nothing matches this filter." : "No notes or questions yet."}</p>`;
  // a reading view: the thread's actions (reply, resolve, edit, delete) stay with its balloon on the chapter
  const on = !!(th.anchor && th.anchor.section_id), t = document.createElement("div"); t.innerHTML = threadHTML(th, true); $$(".acts", t).forEach(e => e.remove());
  return `<div class="cph"><span>${esc(on ? sheetTitle(th.anchor.section_id) : "Whole report")}</span><button class="btn" data-act="gothread" data-th="${esc(th.id)}">${on ? "Go to chapter" : "Open in the chat tray"}</button></div>${t.innerHTML}`;
}
// the open Conversation view follows a turn that lands while it is open (a live answer, a failure, a decision): its count, list
// and selected thread are painted again only when they changed, and focus stays on the same row
function convSync() {
  const c = $("#content .conv"); if (!S.conv || !c) return;
  const n = document.createElement("div"); n.innerHTML = convHTML(); const a = document.activeElement, th = a && c.contains(a) && a.dataset.th;
  let moved = false;
  for (const sel of [".kicker", ".clist", ".cpane"]) { const o = $(sel, c), x = $(sel, n.firstElementChild); if (o && x && o.innerHTML !== x.innerHTML) { moved = moved || o.contains(a); o.innerHTML = x.innerHTML; } }
  if (moved) { const f = th && $(`.conv [data-act="${a.dataset.act}"][data-th="${CSS.escape(th)}"]`); (f || $(".conv .tcard") || $("#main")).focus({ preventScroll: true }); }
}
function convSelect(id) {
  S.convSel = id; const p = $(".conv .cpane"); if (!p) return;
  p.innerHTML = convPaneHTML(threadById(id)); p.scrollTop = 0;
  $$(".conv .tcard").forEach(c => c.dataset.th === id ? c.setAttribute("aria-current", "true") : c.removeAttribute("aria-current"));
}
// the selected thread stays in view beside a long list: held under the sheet header, above the chat bar, scrolling inside itself
function layConv() { const p = $(".conv .cpane"), hd = $("#sheet .shead"); if (!p || !hd) return; const h = hd.offsetHeight, B = band(); p.style.top = h + 12 + "px"; p.style.maxHeight = Math.max(200, B.bot - h - 24) + "px"; }

/* ---------- work panel: Probe ↔ Thread with a back stack ---------- */
const topView = () => S.panel[S.panel.length - 1];
const activeProbe = () => { const t = topView(); return t && t.t === "probe" ? t : null; };
function pushView(v, replaceSame) { const t = topView(); if (replaceSame && t && t.t === v.t) S.panel[S.panel.length - 1] = v; else S.panel.push(v); }
// desktop: report-level work (nothing anchored on this sheet) lives in the chat tray; anchored work lives in the lane
const onSheetA = a => !!(a && a.section_id && S.route === "desk" && !S.conv && a.section_id === S.sheet);
const viewAnchor = v => !v ? null : v.t === "compose" ? v.anchor || (v.thread && (threadById(v.thread) || {}).anchor) || null : v.t === "thread" ? (threadById(v.id) || {}).anchor || null : null;
const inTray = v => !!v && v.t !== "probe" && !v.host && !onSheetA(viewAnchor(v));
const miniRoses = root => root && $$("canvas[data-mini]", root).forEach(c => rose(c, 120, () => roseModel(docV()), () => ({ rev: S.view, ring: S.changed && S.changed.ring, hi: S.changed ? S.changed.sector : null, drawnAt: S.changed && S.changed.at ? { [S.changed.sector]: S.changed.at } : null, small: false })));
function renderPanel() {
  const p = $("#wpanel"); if (!p) return;
  const phone = isPhone(), rk = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.receipt;
  if (!phone) { if (p.innerHTML) p.innerHTML = ""; p.classList.add("closed"); renderTray(); renderLane(); }
  else {
    const v = topView(), tray = S.tray && (!v || inTray(v)), open = (v || tray) && !S.st;
    p.classList.toggle("closed", !open); p.classList.toggle("full", S.panelFull);
    const title = tray ? "Ask about this report" : !v ? "" : v.t === "probe" ? "Probe" : v.t === "compose" ? INTENT[v.intent].lbl : "Thread";
    const pb = open && !tray && v.t === "probe" ? probeHTML(v) : "";
    p.innerHTML = !open ? "" : `<div class="grab" data-act="panelsize" role="button" aria-label="Resize"><span></span></div><div class="wp-h">${S.panel.length > 1 ? `<button class="ib" data-act="pback" aria-label="Back">${IC.back}</button>` : ""}<span class="ttl3">${esc(title)}</span>${pb ? keyHTML(pb) : ""}${tray ? `<span class="tag">${LIVE() ? "Live" : "Sample"} · AI text</span>` : ""}<button class="ib" data-act="panelsize" aria-label="${S.panelFull ? "Smaller" : "Larger"}">${IC.expand}</button>${tray ? `<button class="ib" id="trayMin" data-act="traymin" aria-label="Minimise the chat tray" title="Minimise">${IC.chev}</button>` : ""}<button class="ib" data-act="${tray ? "trayclose" : "pclose"}" aria-label="Close">${IC.x}</button></div>
    <div class="wp-b" id="wpb">${tray ? trayInnerHTML(v && v.t === "compose" ? v : null) : v.t === "probe" ? pb + pactsHTML() : v.t === "compose" ? composeHTML(v) : threadHTML(threadById(v.id))}</div>`;
    miniRoses(p); renderTray();
  }
  paintRoses(); markActiveFig(); paintAnchors(); renderRail();
  if (rk && document.activeElement === document.body) aprFocus(`[data-receipt="${CSS.escape(rk)}"]`);
}
/* ---------- chat tray: report-wide questions only; it never holds figure readings ---------- */
function trayInnerHTML(cmp) {
  const ts = S.threads.filter(t => !(t.anchor && t.anchor.section_id)), top = topView();
  const list = ts.length ? ts.map(t => threadHTML(t).replace('<div class="th">', top && top.t === "thread" && top.id === t.id ? `<div class="th on" tabindex="-1" data-tth="${t.id}">` : `<div class="th" data-tth="${t.id}">`)).join("") : `<p class="muted" style="margin:10px 0 0;font-size:13.5px;line-height:20px">Questions about the whole report go here. Questions about one passage or figure open in the margin beside it.</p>`;
  return `<div class="tr-b" id="trayList">${list}</div><div class="tr-f">${trayFootHTML(cmp)}</div>`;
}
function trayFootHTML(cmp) {
  const ac = LIVE() && askChips(), qs = ac ? ac.qs : dockQs();
  return cmp ? composeHTML(cmp) : `<div class="chiprow" role="group" aria-label="${ac ? esc(`Suggested questions about ${ac.where}`) : "Sample questions"}">${qs.map(q => `<button class="chip" data-act="trayq" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <form class="trayform" data-act="trayask"><label class="vh" for="trayIn">Ask Athena about this report</label><textarea id="trayIn" rows="1" placeholder="Ask about the whole report…" autocomplete="off"${ac ? ` maxlength="${ASK_MAX}"` : ""}>${esc(S.trayDraft || "")}</textarea><button class="btn primary" type="submit">Ask <kbd>↵</kbd></button></form>
    <div class="how">${LIVE() ? "Answers come from this report only" : "Pre-written samples, no model call. For live answers, add your own Meta API key"} · <span class="tag">${LIVE() ? "Live answers" : "Sample answers"}</span></div>`;
}
// live answers: suggested questions for the sheet in view, from the edition's own structure (no model call): a chapter's own
// question and two short templates; elsewhere the whole year and the first chapters' questions
const askChips = () => { const s = S.route === "desk" && !S.conv && secById(docV(), S.sheet);
  if (s && !s.absent && s.blocks.length) return { where: s.title, qs: [s.question, `What are the key figures in ${s.title}?`, `What changed from the prior year in ${s.title}?`] };
  return { where: "this report", qs: ["Summarize the year in two sentences.", ...HAVE.filter(x => x.blocks.length).slice(0, 2).map(x => x.question)] }; };
// the minimised tray, one line like a chat inbox row: how many questions so far and where the last one stands
const TRAY_STATE = { answered: "Answered", refused: "Can't answer", needs_approval: "Needs your approval", error: "No answer" };
const PROP_STATE = { pending: TRAY_STATE.needs_approval, applied: "Applied", discarded: "Discarded", stale: "Out of date" };
const trayState = m => !m || m.role !== "assistant" ? "" : m.waiting ? (m.mode === "edit" ? "Drafting…" : "Answering…")
  : !m.live ? (m.cant || m.refusal ? TRAY_STATE.refused : m.demo ? "Live answers off" : m.proposal ? PROP_STATE[m.proposal.status] : TRAY_STATE.answered)
  : TRAY_STATE[m.live] || { part: "Partly checked", none: "Replied", all: "Not checked" }[chkOf(m).k];
// the dot beside a thread's name shows the same state: colour and a pulse while it works, with the words next to it
const DOT = { "Answering…": "busy", "Drafting…": "busy", Answered: "ok", Replied: "ok", Applied: "ok", "Partly checked": "part", "Not checked": "part", "Out of date": "part", [TRAY_STATE.needs_approval]: "need", [TRAY_STATE.refused]: "stop", [TRAY_STATE.error]: "stop", "Live answers off": "stop" };
const trayTs = () => S.threads.filter(t => !(t.anchor && t.anchor.section_id));
const trayAsked = () => trayTs().reduce((a, t) => a + t.messages.filter(m => m.role === "user" && (t.kind !== "note" || m.mode === "explain")).length, 0); // a memo is no question
function trayLineHTML() {
  const ts = trayTs().filter(t => t.messages.some(m => m.role === "assistant")), q = trayAsked();
  const th = ts.find(t => t.id === S.askTh) || ts.at(-1), st = th ? trayState(th.messages.at(-1)) : ""; // the thread last asked in, not the last one opened
  return `<button class="traybar min" id="trayBar" data-act="tray" aria-expanded="false" aria-controls="tray" aria-label="${esc(`Open Ask about this report${q ? `: ${nOf(q, "question")}` : ""}${st ? ", " + st : ""}`)}"><span class="mk ai ${DOT[st] || ""}"></span><span class="t">Ask about this report</span>${q ? `<span class="cnt" aria-hidden="true">${IC.chat}${q}</span>` : ""}${st ? `<span class="stt${st.endsWith("…") ? " busy" : ""}" aria-hidden="true">${esc(st)}</span>` : ""}<span class="up" aria-hidden="true">${IC.chev}</span></button>`;
}
function renderTray() {
  const box = $("#tray"); if (!box) return;
  const phone = isPhone(), top = topView();
  const open = !phone && S.tray, n = S.threads.filter(t => !(t.anchor && t.anchor.section_id)).length;
  box.classList.toggle("open", open); box.hidden = phone && (!!top || S.tray || !!S.st);
  const ae = document.activeElement, keep = ae && box.contains(ae) ? (ae.id ? "#" + ae.id : ae.matches(".th") ? ".th.on" : null) : null;
  const caret = ae && ae.id === "trayIn" ? [ae.selectionStart, ae.selectionEnd] : null; // the box is rebuilt below; S.trayDraft keeps the words
  const read = S.trayProbe && $("#trayList", box), readTop = read ? read.scrollTop : null; // a Probe opened from an answer keeps the reader's place in it
  box.innerHTML = open ? `<section class="traybox" id="trayBox" aria-label="Ask about this report"><div class="tr-h"><span class="mk ai"></span><h2>Ask about this report</h2><span class="tag">${LIVE() ? "Live" : "Sample"} · AI text</span><button class="ib" id="trayMin" data-act="traymin" aria-label="Minimise the chat tray" title="Minimise">${IC.chev}</button><button class="ib" id="trayFold" data-act="trayclose" aria-label="Fold the chat tray" title="Fold (Esc)">${IC.x}</button></div>${trayInnerHTML(inTray(top) && top.t === "compose" ? top : null)}</section>`
    : S.trayMin ? `<section class="traybox min" id="trayBox" aria-label="Ask about this report">${trayLineHTML()}<div class="tr-f">${trayFootHTML()}</div></section>`
    : `<button class="traybar" id="trayBar" data-act="tray" aria-expanded="false" aria-controls="tray"><span class="mk ai"></span><span class="t">Ask Athena about this whole report…</span>${n ? `<span class="n">${n} thread${n === 1 ? "" : "s"}</span>` : ""}<span class="go">Ask</span></button>`;
  if (open) { miniRoses(box); const on = $(".th.on", box) || (top && top.t === "compose" && $("#cmp", box)); const l = $("#trayList", box); if (readTop != null && l) l.scrollTop = readTop; else if (on && l) l.scrollTop += on.getBoundingClientRect().top - l.getBoundingClientRect().top - 4; else if (l) l.scrollTop = l.scrollHeight; }
  if (keep) { const k = $(keep, box); if (k) { k.focus({ preventScroll: true }); if (caret) k.setSelectionRange(...caret); } }
  padTop();
}
// opening the tray folds the margin's balloons to labels (renderLane); they come back when it folds
function openTray() {
  S.tray = true; S.trayProbe = false; renderPanel();
  const i = $("#trayIn") || $("#cmp"); i && i.focus({ preventScroll: true });
}
function foldTray(min) {
  S.tray = false; S.trayMin = !!min; S.panel = S.panel.filter(v => !inTray(v)); renderPanel();
  const b = $("#trayBar"); b && b.focus({ preventScroll: true });
}
function trayAsk(q) { S.trayDraft = ""; const i = $("#trayIn"); if (i) i.value = ""; S.tray = true; pushView({ t: "compose", intent: "explain", anchor: null, text: q }); renderPanel(); return send(topView(), q); }
// a figure cited in a balloon or the tray opens its Probe beside the figure on the sheet (the first sheet that shows it);
// an open tray stays open, and the sheet moves the figure into the band above it
function citeProbe(f) {
  const keep = S.tray && !isPhone(); let on = $(`#content .fig[data-fact="${CSS.escape(f)}"]`);
  if (!on) { const u = usersOf(f).find(id => sheetIds().includes(id)); if (u) { goSheet(u, { keepPanel: true }); on = $(`#content .fig[data-fact="${CSS.escape(f)}"]`); } }
  if (on) { const r = on.getBoundingClientRect(), B = band(); if (keep) { if (r.top < B.top + 8 || r.bottom > B.bot - 8) scrollBy({ top: r.top + r.height / 2 - (B.top + B.bot) / 2, behavior: "instant" }); }
    else if (r.top < 90 || r.bottom > innerHeight * .6) on.scrollIntoView({ block: "center", behavior: RM.matches || FAST ? "auto" : "smooth" }); }
  openProbe(f, on || null, 0, keep); if (on) on.focus({ preventScroll: true }); // focus follows the citation to the figure it opened
}
// keyboard keeps its place: after a submit, focus moves to the conversation it went to
function focusThread(th) {
  const t = $(`#lane .bal[data-k="th:${CSS.escape(th.id)}"]`) || $("#trayBox .th.on") || (isPhone() && $("#wpb .th")); if (!t) return;
  // WCAG 2.4.7: focus that the app moves here after a save, a kept answer or a marker's list shows a ring (.fx) until it
  // leaves, also when a pointer started it (:focus-visible alone stays off then); a later click inside shows none
  if (!t.hasAttribute("tabindex")) t.tabIndex = -1; t.classList.add("fx"); t.addEventListener("blur", () => t.classList.remove("fx"), { once: true }); t.focus({ preventScroll: true });
}
// the one page move the desk makes for an element that left the visible band: just enough to bring it 8 px inside (scrollIntoView
// "nearest"; WAI-ARIA APG listbox: the active option is kept visible); an element taller than the band shows its top
function follow(el) { if (!el) return 0; const B = band(), r = el.getBoundingClientRect();
  const d = r.top < B.top + 8 || r.height > B.bot - B.top - 16 && r.bottom > B.bot - 8 ? r.top - (B.top + 8) : r.bottom > B.bot - 8 ? r.bottom - (B.bot - 8) : 0;
  if (Math.abs(d) >= 1) scrollBy({ top: d, behavior: "instant" }); return d; }
// back to the figure (or the passage) a closed balloon read, scrolled into the visible band, with a ring
function focusBack(v, top) {
  let el = v && v.el != null && $$("#content .fig")[v.el];
  if (!el) { const a = viewAnchor(top), b = a && a.block_id && blockEl(a.block_id), fid = a && (a.fig || a.fact);
    el = b && fid && $(`.fig[data-fact="${CSS.escape(fid)}"]`, b); if (el) rovingFigs($$("#content .fig").indexOf(el)); else if ((el = b)) el.tabIndex = -1; }
  if (!el) return $("#main").focus({ preventScroll: true });
  if (follow(el)) layLane();
  el.focus({ preventScroll: true });
}
// a prefilled composer starts selected, so typing replaces the sample; a memo being edited keeps its words with the caret at the end
function focusCmp(edit) {
  const c = $("#cmp"); if (!c) return; c.focus({ preventScroll: true });
  if (edit) c.setSelectionRange(c.value.length, c.value.length); else if (c.value) c.select();
  const bb = c.closest(".bal-b"); if (bb) bb.scrollTop = bb.scrollHeight;
}
/* ---------- margin lane: balloons at their anchors' height, joined by leader lines ---------- */
const kindOfTh = th => th.kind === "note" ? "memo" : th.messages[0] && th.messages[0].mode === "edit" ? "edit" : "ai";
// a reader's words inside a spoken name end with one stop: "…capitalized." never becomes "…capitalized.."
const sen = x => { x = String(x || "").trim(); return x && !/[.!?…]$/.test(x) ? x + "." : x; };
function balThreadHTML(th, mode, reply) {
  const k = kindOfTh(th), n = th.messages.filter(m => !m.waiting).length, first = (th.messages.find(m => m.role === "user") || {}).text || "", ans = th.messages.find(m => m.role === "assistant" && !m.waiting && m.text);
  const name = k === "memo" ? "Memo" : k === "edit" ? "Suggested edit" : "Question";
  if (mode === "fold") return `<button class="bal conv fold" data-k="th:${th.id}" data-act="unfold" data-th="${th.id}" aria-expanded="false" aria-label="${esc(`${name}: ${sen(first)} ${n} message${n === 1 ? "" : "s"}. Expand`)}"><span class="mk ${k}"></span><span class="ft">${esc(first.split(/\s+/).slice(0, 7).join(" "))}</span><span class="n">${n}</span><span class="chev" aria-hidden="true">▸</span></button>`;
  if (mode === "mini") return `<button class="bal conv mini" data-k="th:${th.id}" data-act="openthread" data-th="${th.id}" aria-label="${esc(`Open ${name.toLowerCase()}: ${first}`)}"><span class="hd"><span class="mk ${k}"></span>${k === "memo" ? "Memo · only you" : `Athena · ${k === "edit" ? "suggest edit" : "ask"}`}<span class="n">${n}</span></span><span class="q">${esc(first)}</span>${ans ? `<span class="a"><b>${ans.live ? cap1(LIVE_WHO[ans.live]) : "Sample answer"}</b>${esc(plain(ans.text))}</span>` : ""}</button>`;
  // like the Probe, an open balloon keys its colours in a fixed header and scrolls only its body, so a long proposed edit
  // never scrolls its key out of sight
  const body = threadHTML(th) + (reply ? `<div class="incmp">${composeHTML(reply)}</div>` : ""), kh = keyHTML(body);
  return `<div class="bal conv on" data-k="th:${th.id}" role="region" aria-label="${esc(name)}" tabindex="-1"><button class="ib x" data-act="balclose" data-k="th:${th.id}" aria-label="Close ${esc(name.toLowerCase())}">${IC.x}</button>${kh ? `<div class="bal-h">${kh}</div>` : ""}<div class="bal-b">${body}</div></div>`;
}
// the box a balloon points at: the Probe's figure, or the first line of a note's words (its block when the words changed)
function laneBox(v) { if (v.t === "probe") return laneAnchor(v); const r = v.anchor && findAnchor(v.anchor); return r ? r.getBoundingClientRect() : laneAnchor(v); }
function laneAnchor(v) {
  if (v.t === "probe") { const fs = $$("#content .fig"), el = v.el != null && fs[v.el] && fs[v.el].dataset.fact === v.stack[0] ? fs[v.el] : fs.find(e => e.dataset.fact === v.stack[0]); return el ? el.getBoundingClientRect() : null; }
  const a = v.anchor, r = a && findAnchor(a);
  if (r) { const rs = r.getClientRects(); return rs[0] || r.getBoundingClientRect(); }
  const b = a && a.block_id && blockEl(a.block_id); return b ? b.getBoundingClientRect() : null;
}
// the part of the screen the reader can see: below the sheet header, above the chat tray (on the phone: above whichever of the
// show-through bar, the open panel and the chat bar shows)
function band() {
  if (isPhone()) { const st = $("#strip"), t = st ? parseFloat(getComputedStyle(st).top) + st.offsetHeight : 0, on = /* where the sticky strip stays: the server's status strip sits above it only at the page's top */["#stbar", "#wpanel", "#tray"].map(s => $(s)).filter(e => e && !e.hidden && e.getClientRects().length); return { top: Math.max(0, t), bot: Math.min(innerHeight, ...on.map(e => e.getBoundingClientRect().top)) }; }
  const hd = $("#sheet .shead"), tr = $("#trayBox") || $("#trayBar"), t = hd ? hd.getBoundingClientRect().bottom : 0, b = tr && tr.getClientRects().length ? tr.getBoundingClientRect().top - 4 : innerHeight;
  return { top: Math.max(0, t), bot: Math.min(innerHeight, b) };
}
let LANE = null, GK = null, LMX = null, MRET = null; const RY = {}; // MRET: the thread opened from a lane marker or its list (Esc returns there) // LMX: the threads of the lane-edge marker whose list is open; RY: each sheet's scroll when Conversation opened
const guideRows = () => $$("#guide .gr").filter(b => !b.closest(".gall[hidden]"));
// the unit a table's caption or a chart's axis prints for a value the sheet prints bare ("2,225.0" under "$ millions")
function figUnit(e) {
  const v = e.textContent; if (!/\d/.test(v) || /[$%×A-Za-z]/.test(v)) return "";
  const blk = e.closest(".blk.table, .blk.chart"), bo = blk && blockOf(docV(), blk.dataset.block); if (!bo) return "";
  if (bo.b.kind === "table") return tableUnit(bo.b);
  // a chart's unit is the one of the series the figure belongs to (a chart may mix series), not its first series'
  const se = bo.b.series.find(x => x.facts.includes(e.dataset.fact)), g = se && F[se.facts[0]]; return g ? spec(g, "chart").unit : "";
}
// the idle chapter lane: this chapter's notes and questions, then its key figures (the ones its key point and text print, once
// each in reading order, as printed there); every figure the sheet prints waits behind one disclosure line that opens in place.
// One tab stop: arrows move between rows. A value printed bare carries its table's or chart's unit
function guideHTML() {
  const ths = S.threads.filter(t => onSheetA(t.anchor) && anchorState(t).st !== "later"), once = els => { const s = new Set(); return els.filter(e => F[e.dataset.fact] && !s.has(e.dataset.fact) && s.add(e.dataset.fact)); };
  const figs = once($$("#content .fig")), keys = once($$("#content .keypoint .fig, #content .blk.prose .fig, #content .blk.callout .fig")), kset = new Set(keys.map(e => e.dataset.fact)), open = S.gx === S.sheet;
  const row = (k, attrs, label, inner) => `<button type="button" class="gr" data-gk="${esc(k)}" ${attrs} aria-label="${esc(label)}">${inner}</button>`;
  const nr = th => { const k = kindOfTh(th), name = k === "memo" ? "Memo" : k === "edit" ? "Suggested edit" : "Question", first = (th.messages.find(m => m.role === "user") || {}).text || "", st = th.status === "resolved" ? "Resolved" : "Open";
    return row("t:" + th.id, `data-act="openthread" data-th="${esc(th.id)}"`, `${name}: ${sen(first)} ${st}. Open it at its words`, `<span class="gn"><span class="mk ${k}"></span>${name}<span class="gs">${st}</span></span><span class="gt">${esc(first)}</span>`); };
  const fr = (e, k) => { const id = e.dataset.fact, f = F[id], v = e.textContent.trim(), tag = f.kind === "calculated" ? "□ Calculated" : isText(f) ? "■ Quoted from text" : "■ Quoted";
    const u = figUnit(e), where = e.closest(".blk.chart") ? "in the chart" : e.closest(".blk.table") ? "in the table" : "";
    return row(k + id, `data-act="gfig" data-f="${esc(id)}"`, `${f.label}, ${f.period}, ${v}${u ? " " + u : ""}${where ? ", " + where : ""}, ${tag.slice(2).toLowerCase()}. Open its Probe`, `<span class="gl">${esc(f.label)}</span><span class="gv">${esc(v)}</span><span class="gp">${esc(f.period)}${u ? ` · <span class="gu">${esc(u)}</span>` : ""}${where ? " · " + where : ""}</span><span class="gh">${tag}</span>`); };
  const more = figs.filter(e => !kset.has(e.dataset.fact)).length;
  return `<div class="guide" id="guide" role="region" aria-label="In this chapter" hidden><div class="gh1">In this chapter</div>
    <div class="gsec">Notes and questions · ${ths.length}</div>${ths.length ? ths.map(nr).join("") : `<p class="gnone">None yet. Select words on the sheet to write a memo or ask Athena.</p>`}
    <div class="gsec">Key figures · ${keys.length}<span>in the key point and text, as printed</span></div>${keys.length ? keys.map(e => fr(e, "k:")).join("") : `<p class="gnone">The key point and text print no figures.</p>`}
    ${figs.length ? `<button type="button" class="gr gx" data-gk="x" data-act="gall" aria-expanded="${open}" aria-controls="gall"><span class="gxl">All ${nOf(figs.length, "figure")} on this sheet</span><span class="gxs">${more ? `${more} more in its tables and charts · ` : ""}in reading order</span><span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span></button>
    <div class="gall" id="gall" role="group" aria-label="All figures on this sheet"${open ? "" : " hidden"}>${figs.map(e => fr(e, "f:")).join("")}</div>` : `<p class="gnone">This chapter prints no figures.</p>`}
    <p class="gfoot">Touch any figure to read it here at four depths: Read, Exact, Work and Filing. Select words to write a private memo, ask Athena, or suggest an edit. Hold Space over a table or paragraph to see through it.</p><div class="keys">[ ] sheet · ↑ ↓ figure map · 1–4 or ← → depth · Backspace steps out · M memo · ⌘↵ ask · ⌘J Conversation · Esc closes</div></div>`;
}
// open panels arrive from the right and leave the same way (WAAPI on transform, opacity and a 4 px blur); nothing for
// keyboard-initiated changes; an opacity fade only under reduced motion
let VIAKEY = false, stLead = null;
addEventListener("keydown", () => { VIAKEY = true; }, true); addEventListener("pointerdown", () => { VIAKEY = false; }, true);
function pMove(el, out) { el.style.transformOrigin = "100% 50%"; const k = RM.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: "translateX(24px) scale(.98)", opacity: 0, filter: "blur(4px)" }, { transform: "none", opacity: 1, filter: "none" }];
  return el.animate(out ? k.reverse() : k, { duration: out ? 160 : 220, easing: "cubic-bezier(.23, 1, .32, 1)", fill: out ? "forwards" : "none" }); }
// a lane laid out again while a panel arrives (a scroll) measures it mid-motion: once it rests, the lane and the show-through leader
// are laid out again, so every leader ends on the panel's edge
// where a panel rests: while its entrance moves it (a transform), its offset box, which no transform touches
const restBox = el => { if (!el.getAnimations().length) return el.getBoundingClientRect(); const p = el.offsetParent, o = p ? p.getBoundingClientRect() : { left: 0, top: 0 },
  l = o.left + (p ? p.clientLeft - p.scrollLeft : 0) + el.offsetLeft, t = o.top + (p ? p.clientTop - p.scrollTop : 0) + el.offsetTop;
  return { left: l, top: t, right: l + el.offsetWidth, bottom: t + el.offsetHeight, width: el.offsetWidth, height: el.offsetHeight }; };
function pEnter(el) { if (!VIAKEY && el && el.animate) pMove(el, false).finished.then(() => { if (el.isConnected) { layLane(); stLead && stLead(); } }, () => {}); }
function pLeave(el, r) { if (VIAKEY || !el || !el.animate || !r || !r.width) return; $$("[id]", el).forEach(e => e.removeAttribute("id")); el.removeAttribute("id"); el.classList.add("ghost"); el.setAttribute("aria-hidden", "true"); el.inert = true;
  Object.assign(el.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", right: "auto", bottom: "auto", margin: "0", maxHeight: "none" });
  document.body.appendChild(el); pMove(el, true).finished.then(() => el.remove(), () => el.remove()); }
function renderLane() {
  const lane = $("#lane"), binder = $("#binder"); if (!lane || !binder) return;
  const top = topView(), probe = [...S.panel].reverse().find(v => v.t === "probe"), hosted = top && top.t === "compose" && top.host ? top : null;
  const items = [];
  if (probe) items.push({ k: "probe", v: probe, open: true, act: !top || top === probe || top === hosted || inTray(top) });
  const cmp = top && top.t === "compose" && !top.host && onSheetA(viewAnchor(top)) ? top : null, replyTo = cmp && cmp.thread && threadById(cmp.thread);
  if (cmp && !replyTo) items.push({ k: "compose", v: cmp, open: true, act: true });
  if (!S.conv) S.threads.filter(t => onSheetA(t.anchor) && anchorState(t).st !== "later" && (t.status === "open" || top && top.t === "thread" && top.id === t.id)).forEach(t => {
    const act = !!(top && (top.t === "thread" && top.id === t.id || replyTo === t));
    items.push({ k: "th:" + t.id, th: t, act, open: act, mode: act ? "full" : "mini" });
  });
  // the chat tray and open balloons never share the screen: while the tray is open every balloon folds to a one-line label
  if (S.tray) items.forEach(it => { if (it.k !== "probe" || !S.trayProbe) { it.mode = "fold"; it.act = false; } });
  // the Summary drops its lane while nothing is anchored; Conversation spreads over the lane (same paper, the frame of the sheet it
  // was opened from, Summary included); a chapter keeps its lane at every width, so opening or closing a balloon never reflows the
  // reading column
  const sum = S.sheet === "summary", nolane = S.conv || sum && !items.length;
  if (binder.classList.contains("sum") !== sum || binder.classList.contains("nolane") !== nolane) { binder.classList.toggle("sum", sum); binder.classList.toggle("nolane", nolane); const r = $("#sumRose"); r && summaryRoseInit(r); }
  const chap = !S.conv && !!secById(docV(), S.sheet); if (S.conv) layConv();
  if (!items.length && !nolane && !chap) items.push({ k: "hint" });
  const html = it => it.k === "probe" && it.mode === "fold" ? `<button class="bal probe fold" data-k="probe" data-act="laneback" aria-label="${esc(`Probe, folded while the chat tray is open: ${F[it.v.stack[0]].label} ${F[it.v.stack[0]].period}. Show it`)}"><span class="ft">Probe · ${esc(F[it.v.stack[it.v.stack.length - 1]].label)} ${esc(fmt(F[it.v.stack[it.v.stack.length - 1]], "kpi"))}</span><span class="chev" aria-hidden="true">▸</span></button>`
    : it.k === "compose" && it.mode === "fold" ? `<button class="bal conv fold" data-k="compose" data-act="laneback" aria-label="${esc(INTENT[it.v.intent].name)} draft, folded while the chat tray is open. Show it"><span class="mk ${it.v.intent === "note" ? "memo" : it.v.intent === "edit" ? "edit" : "ai"}"></span><span class="ft">${esc(INTENT[it.v.intent].name)} draft${it.v.text ? ": " + esc(it.v.text) : ""}</span><span class="chev" aria-hidden="true">▸</span></button>`
    : it.k === "probe" ? (pb => `<div class="bal probe${it.act ? " on" : ""}" data-k="probe" role="region" aria-label="Probe" tabindex="-1"><div class="bal-h"><span class="ttl3">Probe · reading window</span>${keyHTML(pb)}<button class="ib" data-act="balclose" data-k="probe" aria-label="Close Probe">${IC.x}</button></div><div class="bal-b">${pb}</div>${hosted ? "" : pactsHTML()}</div>`)(probeHTML(it.v, !!hosted) + (hosted ? `<div class="incmp">${composeHTML(hosted)}</div>` : ""))
    : it.k === "compose" ? `<div class="bal conv on" data-k="compose" role="region" aria-label="${esc(INTENT[it.v.intent].name)}" tabindex="-1">${composeHTML(it.v)}</div>`
    : it.k === "hint" ? `<div class="bal hint" data-k="hint"><p><b>Touch any figure</b> to read it in the margin at four depths: Read, Exact, Work and Filing. ■ quoted from the filing, □ calculated by code.</p><p>Select words to write a private memo, ask Athena, or suggest an edit. Hold Space over a table or paragraph to see through it.</p><div class="keys">[ ] sheet · ↑ ↓ figure map · 1–4 or ← → depth · Backspace steps out · M memo · ⌘↵ ask · ⌘J Conversation · Esc closes</div></div>`
    : balThreadHTML(it.th, it.mode, replyTo === it.th ? cmp : null);
  // re-rendering keeps keyboard focus where it was (the balloon, or the control inside it)
  const ae = document.activeElement, fb = ae && lane.contains(ae) ? ae.closest(".bal") : null, fk = fb && fb.dataset.k,
    fsel = fb && (ae === fb ? "" : ae.id ? "#" + CSS.escape(ae.id) : ae.dataset.receipt ? `[data-receipt="${CSS.escape(ae.dataset.receipt)}"]` : null);
  const bb = $("#lane > .bal.probe .bal-b"), bscroll = bb ? bb.scrollTop : 0;
  const gk = ae && ae.closest && ae.closest("#guide") ? ae.dataset.gk : null;
  const was = new Map(LANE ? LANE.items.filter(i => i.open && i.mode !== "fold" && i.el && i.el.isConnected && !i.away).map(i => [i.k, { el: i.el, r: i.el.getBoundingClientRect() }]) : []);
  lane.innerHTML = items.map(html).join("") + (chap ? guideHTML() : ""); miniRoses(lane);
  { const g = guideRows(), i = Math.max(0, g.findIndex(b => b.dataset.gk === GK)); $$("#guide .gr").forEach(b => b.tabIndex = b === g[i] ? 0 : -1); }
  const els = $$(":scope > .bal", lane); items.forEach((it, i) => { it.el = els[i]; });
  LANE = { items };
  layLane();
  // the entrance motion starts after the lane is laid out: layLane measures each balloon where it rests, so a leader ends on the
  // panel's edge, not where the panel's first frame (24 px to the right, scaled) puts it
  { const now = new Set(items.filter(i => i.open && i.mode !== "fold" && i.el).map(i => i.k)); items.forEach(i => now.has(i.k) && !was.has(i.k) && pEnter(i.el)); was.forEach((g, k) => now.has(k) || pLeave(g.el, g.r)); }
  const nb = $("#lane > .bal.probe .bal-b"); if (nb && fk === "probe") nb.scrollTop = bscroll;
  if (fk) { const b = $(`#lane .bal[data-k="${CSS.escape(fk)}"]`), t = b && (fsel ? $(fsel, b) : fsel === "" ? b : null); (t || b) && (t || b).focus({ preventScroll: true }); }
  if (gk) { const r = $(`#guide .gr[data-gk="${CSS.escape(gk)}"]`); r && !$("#guide").hidden && r.focus({ preventScroll: true }); }
}
// placement: the active balloon sits level with its anchor and inside the visible band (below the sheet header, above the
// chat tray), taller content scrolls inside it; the others keep their order and move just enough not to overlap; when
// crowded, the most displaced inactive balloon folds to a one-line label. Runs again on scroll, without re-rendering.
// the least height at which a panel is usable: a Probe keeps its header, its body through the depth control (the title
// in full, the value line, the depth slider with its names) and its actions; any other panel 160 px, or its whole height if less
// a marker level with an open panel that reaches over the body sits at the panel's left edge and never on
// the panel's words or controls. First choice, a spot that covers nothing: on the panel just inside its edge, on the page just
// outside it, centred on the edge, or flush (its right edge on the panel's content edge, so it covers only the panel's border and
// padding); at its line's height or the nearest such spot up to 24 px above or below (less than one body line), its centre at most
// 9 px beyond the panel's top or foot (lx takes a marker as level with a panel within 10 px). Else a spot at the edge (flush first,
// then centred on it) where it meets body text only on a line the panel cuts at its border, by at most 3 px of that line's glyph box:
// 3 px of its end at the edge, or a strip at most 3 px deep along its top or foot (a marker is 18 or 20 px
// wide, the panel's border and padding 17, and beside the depth control, whose slider reaches 12 px from the edge, no spot is free).
// Else, of the spots that cover no panel word or control (the one outside the edge always qualifies), the one that covers the least
// body text. Words the panel hides do not count. o: the panel's resting box and element; cy: the marker's centre; w: its width.
// Returns the marker's left edge and centre, viewport px
function markSpot(o, cy, w) {
  const lo = o.top + w / 2 - 9, hi = Math.max(lo, o.bottom - w / 2 + 9), c0 = clamp(cy, lo, hi), a = c0 - w / 2 - 26, b = c0 + w / 2 + 26, PW = [], BW = [];
  const cur = o.el.getBoundingClientRect(), sx = o.left - cur.left, sy = o.top - cur.top, cs = getComputedStyle(o.el), ce = o.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
  const walk = (root, dx, dy, out, body) => { if (!root) return; let t;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => { if (n.nodeType === 1) { const r = n.getBoundingClientRect(); return r.bottom + dy < a || r.top + dy > b ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP; }
      return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
    while ((t = tw.nextNode())) { const rg = document.createRange(); rg.selectNodeContents(t); for (const q of rg.getClientRects()) { const l = q.left + dx, tp = q.top + dy, bt = q.bottom + dy;
      // a body line wholly level with the panel that runs under its border is cut there: only its part left of the edge is in sight
      const cut = body && tp >= o.top && bt <= o.bottom && q.right + dx > o.left, r = cut ? o.left : q.right + dx; if (r - l > 0 && bt > a && tp < b) out.push([l, r, tp, bt, cut]); } } };
  walk(o.el, sx, sy, PW, false); walk($("#content"), 0, 0, BW, true);
  $$("button, [role=slider], input, select, textarea, a[href], .sleeve", o.el).forEach(e => { const q = e.getBoundingClientRect(); if (q.width && q.bottom + sy > a && q.top + sy < b) PW.push([q.left + sx, q.right + sx, q.top + sy, q.bottom + sy]); });
  const ov = (x, c, [l, r, t, bt]) => [Math.min(x + w, r) - Math.max(x, l), Math.min(c + w / 2, bt) - Math.max(c - w / 2, t)];
  const panel = (x, c) => PW.some(q => { const [h, v] = ov(x, c, q); return h > .5 && v > .5; });
  const body = (x, c, tol) => BW.reduce((n, q) => { const [h, v] = ov(x, c, q); return h >= 1 && v >= 2 && !(tol && q[4] && x + w > o.left && (h <= 3 || v <= 3)) ? n + h * v : n; }, 0);
  // 1 px steps, nearest first (4 px steps skipped the few rows where a marker fits between a cut line and the next)
  const D = [0]; for (let d = 1; d <= 24; d++) D.push(-d, d); const X = [o.left + 1, o.left - w - 1, o.left - w / 2, ce - w];
  for (const d of D) { const c = clamp(c0 + d, lo, hi); for (const x of X) if (!panel(x, c) && !body(x, c, false)) return [x, c]; }
  for (const d of D) { const c = clamp(c0 + d, lo, hi); for (const x of [ce - w, o.left - w / 2]) if (!panel(x, c) && !body(x, c, true)) return [x, c]; }
  let best = null;
  for (const d of D) { const c = clamp(c0 + d, lo, hi); for (const x of X) { if (panel(x, c)) continue; const k = body(x, c, true); if (!best || k < best[2]) best = [x, c, k]; } }
  return best.slice(0, 2);
}
function usableH(el) { const b = $(".bal-b", el), t = b && ($(".travel", b) || $(".win", b));
  if (!t) return Math.min(160, el.scrollHeight);
  return Math.ceil(el.offsetHeight - b.clientHeight + t.getBoundingClientRect().bottom - b.getBoundingClientRect().top + b.scrollTop + (parseFloat(getComputedStyle(b).paddingBottom) || 0)); }
function layLane() {
  const lane = $("#lane"), svg = $("#leaders"), sheet = $("#sheet"); if (!lane || !LANE || !sheet || !lane.getClientRects().length || isPhone()) return;
  const items = LANE.items.filter(it => it.el && it.el.isConnected), B = band(), lr = lane.getBoundingClientRect(), sr = sheet.getBoundingClientRect(), GAP = 8, CAP = 8, AT = 14;
  sheet.classList.toggle("ovb", lr.width - 24 < (parseFloat(getComputedStyle(lane).getPropertyValue("--panelW")) || 440));
  items.forEach(it => { it.ar = it.k === "hint" ? null : laneAnchor(it.v || it.th); });
  // the open balloon leaves room in the band for the folded labels of the other notes on screen (up to two above, two below)
  const mid = r => r && (r.top + r.bottom) / 2, inB = r => r && mid(r) >= B.top && mid(r) <= B.bot, A = items.find(it => it.act && it.mode !== "fold"), LBH = 42;
  const others = A && (!A.ar || inB(A.ar)) ? items.filter(it => it !== A && inB(it.ar)) : [];
  const nUp = others.filter(it => A.ar && mid(it.ar) < mid(A.ar)).length, up = Math.min(2, nUp) * LBH, dn = Math.min(2, others.length - nUp) * LBH;
  items.forEach(it => { it.cover = it.avoid = false; }); if (A && A.el) A.el.style.maxHeight = "";
  lane.style.setProperty("--balMax", Math.max(160, B.bot - B.top - 16 - up - dn) + "px");
  items.forEach(it => { const r = it.ar;
    it.want = r ? Math.max(CAP, r.bottom - lr.top - AT) : it.k === "hint" ? CAP + 4 : Math.max(CAP, B.top + 8 - lr.top);
    if (it === A && (!r || inB(r))) {
      // no rule here ever sizes the panel under its usable height: neither the lane cap (--balMax) nor a room beside the anchor
      const need = Math.min(usableH(it.el), B.bot - B.top - 16); if (it.el.offsetHeight < need) it.el.style.maxHeight = need + "px";
      const h = it.el.offsetHeight;
      it.want = clamp(r ? r.bottom - AT : B.top + 8, B.top + 8 + up, Math.max(B.top + 8 + up, B.bot - 8 - h - dn)) - lr.top;
      // a panel wider than the lane covers the body's right edge; over its anchor it moves below the anchor, or above it,
      // or takes the larger of the two rooms (Floating UI's flip and size), first beside the folded labels it keeps room for, then
      // over them. With neither room at its usable height (coverage allowed) it keeps that height and, of the places
      // in the band, takes the one that covers the least of the anchor's line; the page does not move
      const ab = r && laneBox(it.v || it.th), pl = restBox(it.el).left;
      if (ab && ab.right > pl - 4) { it.avoid = true; const size = (lo, hi) => { const rd = hi - ab.bottom - 8, ru = ab.top - 8 - lo;
          if (h <= rd) it.want = ab.bottom + 8 - lr.top; else if (h <= ru) it.want = ab.top - 8 - h - lr.top;
          else if (Math.max(rd, ru) >= need) { const m = Math.max(rd, ru); it.el.style.maxHeight = m + "px"; it.want = (rd >= ru ? ab.bottom + 8 : ab.top - 8 - m) - lr.top; }
          else return false; return true; };
        if (!size(B.top + 8 + up, B.bot - 8 - dn) && !size(B.top + 8, B.bot - 8)) {
          const lo = B.top + 8, hi = Math.max(lo, B.bot - 8 - need), cov = y => Math.max(0, Math.min(y + need, ab.bottom) - Math.max(y, ab.top));
          const y = [ab.bottom + 8, hi, ab.top - 8 - need, lo].map(y => clamp(y, lo, hi)).reduce((m, y) => cov(y) < cov(m) ? y : m);
          it.el.style.maxHeight = need + "px"; it.want = y - lr.top; it.cover = cov(y) > 0; } } } });
  const place = () => {
    const L = items.filter(it => it.el).sort((a, b) => a.want - b.want || (a.act ? -1 : 1)); L.forEach(it => it.h = it.el.offsetHeight);
    let ai = L.findIndex(it => it.act); if (ai < 0) { let y = CAP; L.forEach(it => { it.y = Math.max(it.want, y); y = it.y + it.h + GAP; }); return L; }
    L[ai].y = L[ai].want;
    for (let i = ai + 1; i < L.length; i++) L[i].y = Math.max(L[i].want, L[i - 1].y + L[i - 1].h + GAP);
    for (let i = ai - 1; i >= 0; i--) L[i].y = Math.min(L[i].want, L[i + 1].y - L[i].h - GAP);
    if (L[0].y < CAP) { // no room above the active balloon: those balloons go below it, in order
      const up = L.slice(0, ai), rest = L.slice(ai); let y = rest[0].y + rest[0].h + GAP; const below = [...up, ...rest.slice(1)].sort((a, b) => a.want - b.want);
      below.forEach(it => { it.y = Math.max(it.want, y); y = it.y + it.h + GAP; }); }
    return L;
  };
  let L = place();
  for (let guard = 0; guard < 40; guard++) {
    const hint = L.find(it => it.k === "hint"); if (hint && L.length > 1) { hint.el.remove(); hint.el = null; L = place(); continue; }
    const cand = L.filter(it => it.th && !it.act && it.mode !== "fold" && S.unfold !== it.th.id && Math.abs(it.y - it.want) > 28).sort((a, b) => Math.abs(b.y - b.want) - Math.abs(a.y - a.want))[0];
    if (!cand) break;
    cand.mode = "fold"; const t = document.createElement("div"); t.innerHTML = balThreadHTML(cand.th, "fold"); const nel = t.firstElementChild; cand.el.replaceWith(nel); cand.el = nel; L = place();
  }
  const nat = L.reduce((m, it) => Math.max(m, it.y + it.h), 0); // the lane's height comes from where items sit by their anchors, so holding them in the band never changes the page's height
  // on screen every balloon and label sits wholly inside the band: one that would run under the sheet header, the chat bar
  // or the open tray is held at the band's edge and its neighbours stack away from it (the open balloon steps up to make room);
  // a label left with no room, or overlapping the one above, waits hidden
  const T = B.top + 4 - lr.top, E = B.bot - 4 - lr.top, onScr = it => it.y + lr.top < innerHeight && it.y + it.h + lr.top > 0, held = it => it === A && A.ar && inB(A.ar);
  const keep = it => it.act || it.k === "probe" || it.el.contains(document.activeElement); // the open balloon, the Probe's label and the focused one always show
  let prev = -Infinity; L.forEach(it => { if (!held(it)) { if (onScr(it)) it.y = Math.max(it.y, T); it.y = Math.max(it.y, prev + GAP); } prev = it.y + it.h; });
  let next = Infinity; [...L].reverse().forEach(it => { if (!held(it) && onScr(it)) it.y = Math.min(it.y, E - it.h); if (!(held(it) && it.avoid)) it.y = Math.min(it.y, next - GAP - it.h); if (keep(it) && onScr(it)) it.y = clamp(it.y, T, Math.max(T, E - it.h)); next = it.y; });
  let pb = -Infinity; L.forEach(it => { it.away = !keep(it) && onScr(it) && (it.y < T - .5 || it.y + it.h > E + .5 || it.y < pb - .5); it.el.classList.toggle("away", it.away); if (!it.away) pb = it.y + it.h; });
  // idle: while no Probe, draft or opened thread shows in the band, the chapter guide fills it and the notes' cards wait hidden
  // (the guide lists them); opening one hides the guide, and it returns when the lane is idle again
  const G = $("#guide", lane);
  if (G) { const busy = L.some(it => it.open && it.y < E && it.y + it.h > T); G.hidden = busy;
    if (!busy) { L.forEach(it => { if (!it.open && !it.away) { it.away = true; it.el.classList.add("away"); } });
      const y = Math.max(CAP, T), bot = Math.min(E, lane.offsetHeight - 8); G.style.top = y + "px"; G.style.maxHeight = Math.max(0, bot - y) + "px"; } }
  L.forEach(it => { it.el.style.top = it.y + "px"; });
  // every thread whose words are in the band and whose label is not (it waits hidden behind a Probe, the chat tray or the chapter
  // guide, or the Probe pushed it out of the band) keeps a marker on the lane's edge, level with its words; it opens the thread.
  // Markers closer than one marker's height merge into one marker with a count that opens a list of their threads, one row each
  // (the marker clustering of map and chart libraries), so threads on one line never hide one another
  $$(":scope > .lmark, :scope > .lmlist", lane).forEach(e => e.remove());
  // a marker level with an open panel that reaches over the body rides the panel's left edge, at a spot that covers no
  // text in sight (markSpot); its spot is in viewport px, so it discounts the lane's 1 px border, which the absolute
  // offset starts after (a flush marker drew 1 px onto the panel's words)
  // the lane's box read again here: placing the balloons can change the page's height, and at the foot of the page the browser
  // then pulls the scroll back, which moves the lane (and its markers) but not the spots measured after it
  const lm = lane.getBoundingClientRect();
  const OP = L.filter(it => it.open && !it.away && it.mode !== "fold").map(it => Object.assign(restBox(it.el), { el: it.el })), lx = y => OP.find(q => y + lm.top >= q.top - 10 && y + lm.top <= q.bottom + 10 && q.left < lm.left - 1);
  const inSight = it => !it.away && it.y + lm.top >= B.top - 1 && it.y + it.h + lm.top <= B.bot + 1;
  // a thread's marker stands on whichever line of its words is in the band (a two-line anchor whose first line is under the
  // header keeps its handle on the second)
  const vr = it => { const r = findAnchor(it.th.anchor), rs = r ? [...r.getClientRects()] : [it.ar]; return rs.find(q => q && q.height && inB(q)); };
  const ms = L.filter(it => it.th && (it.vr = vr(it)) && !inSight(it)).map(it => ({ th: it.th, y: clamp(mid(it.vr), B.top + 10, B.bot - 10) - lm.top })).sort((a, b) => a.y - b.y), groups = [];
  ms.forEach(m => { const g = groups[groups.length - 1]; if (g && m.y - g[0].y < 20) g.push(m); else groups.push([m]); });
  const about = th => { const k = kindOfTh(th); return { k, name: k === "memo" ? "Memo" : k === "edit" ? "Suggested edit" : "Question", first: (th.messages.find(m => m.role === "user") || {}).text || "" }; };
  if (LMX && !groups.some(g => g.map(m => m.th.id).join(",") === LMX)) LMX = null;
  lane.insertAdjacentHTML("beforeend", groups.map(g => { const o = lx(g[0].y), hh = g.length > 1 ? 10 : 9, [mx, my] = o ? markSpot(o, g[0].y + lm.top, 2 * hh) : [lm.left - hh, g[0].y + lm.top], bl = o ? lane.clientLeft : 0, top = `top:${(my - lm.top - hh).toFixed(1)}px;margin-left:${(mx - lm.left - bl + hh).toFixed(1)}px`;
    if (g.length === 1) { const { k, name, first } = about(g[0].th); return `<button class="lmark" data-act="openthread" data-th="${esc(g[0].th.id)}" tabindex="-1" style="${top}" aria-label="${esc(`Open ${name.toLowerCase()}: ${first}`)}" title="${esc(`${name}: ${first}`)}"><span class="mk ${k}"></span></button>`; }
    const key = g.map(m => m.th.id).join(","), open = LMX === key, id = "lml-" + g[0].th.id, kinds = g.map(m => about(m.th).name.toLowerCase());
    const what = [...new Set(kinds)].map(w => nOf(kinds.filter(x => x === w).length, w === "suggested edit" ? "suggested edit" : w)).join(", ");
    return `<button class="lmark n" data-act="lmx" data-ths="${esc(key)}" tabindex="-1" style="${top}" aria-expanded="${open}" aria-controls="${id}" aria-label="${esc(`${g.length} threads here: ${what}. ${open ? "Hide" : "Show"} them`)}" title="${esc(`${g.length} threads here: ${what}`)}"><span class="ct">${g.length}</span></button>`
      + (open ? `<div class="lmlist" id="${id}" role="group" aria-label="${esc(`${g.length} threads on this line`)}" style="${top}">${g.map(m => { const { k, name, first } = about(m.th); return `<button data-act="openthread" data-th="${esc(m.th.id)}" aria-label="${esc(`Open ${name.toLowerCase()}: ${first}`)}"><span class="mk ${k}"></span><span class="lt"><b>${esc(name)}</b> ${esc(first)}</span></button>`; }).join("")}</div>` : ""); }).join(""));
  { const ll = $(":scope > .lmlist", lane); if (ll) { const r = ll.getBoundingClientRect(); if (r.bottom > B.bot - 4) ll.style.top = Math.max(B.top + 4, B.bot - 4 - r.height) - lm.top + "px"; }
    // the open list never leaves a guide line half cut: a guide line it reaches waits hidden while the list is open
    $$("#guide .lmcut").forEach(e => e.classList.remove("lmcut"));
    if (ll) { const q = ll.getBoundingClientRect(); $$("#guide :is(.gh1, .gsec, .gr, .gnone, .gfoot, .keys)").forEach(e => { const b = e.getBoundingClientRect(); if (b.height && b.bottom > q.top && b.top < q.bottom && b.right > q.left && b.left < q.right) e.classList.add("lmcut"); }); } }
  lane.style.minHeight = nat ? nat + 32 + "px" : "";
  // leaders: from the anchor's end along its line to the lane, then to the balloon's edge (solid for the Probe, dotted for notes)
  if (!svg) return;
  const x0 = lr.left - sr.left;
  svg.innerHTML = L.filter(it => it.ar && it.k !== "hint" && !it.away).map(it => {
    const br = restBox(it.el), bx = br.left - sr.left, ex = Math.min(x0, bx), ay = it.ar.bottom - sr.top, cls = it.k === "probe" ? "probe" : "conv", on = it.act ? " on" : "";
    if (it.cover) return "";
    // an anchor under the panel's span (the panel moved below or above it) takes a straight drop to the panel's edge
    if (it.ar.left - sr.left + 4 >= ex - 14) { const x = clamp((it.ar.left + it.ar.right) / 2, br.left + 12, br.right - 12) - sr.left, below = br.top >= it.ar.bottom - 1, y0 = below ? ay : it.ar.top - sr.top, y1 = below ? br.top - sr.top : br.bottom - sr.top;
      return `<path class="${cls}${on}" data-k="${esc(it.el.dataset.k)}" data-ay="${ay.toFixed(1)}" d="M${x.toFixed(1)} ${y0.toFixed(1)} V${y1.toFixed(1)}"/><circle cx="${x.toFixed(1)}" cy="${y0.toFixed(1)}" r="2.5"/>`; }
    const ax = Math.min(it.ar.right - sr.left + 2, ex - 14), by = clamp(ay, br.top - sr.top + 10, br.bottom - sr.top - 10);
    return `<path class="${cls}${on}" data-k="${esc(it.el.dataset.k)}" data-ay="${ay.toFixed(1)}" d="M${ax.toFixed(1)} ${ay.toFixed(1)} H${(ex - 6).toFixed(1)} L${bx.toFixed(1)} ${by.toFixed(1)}"/><circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="2.5"/>`;
  }).join("");
}
/* ---------- show-through: one block turns to vellum; its working and its filing lines show beneath ---------- */
const ST_BLK = ".blk.prose, .blk.callout, .blk.table";
function stRows(blk) { return blk.classList.contains("table") ? $$("tbody tr", blk).filter(tr => $(".fig", tr)) : $$(".fig", blk); }
function startST(bid, hold, i = 0) {
  const blk = blockEl(bid); if (!blk || !stRows(blk).length) { live("This block has no figures to see through"); return; }
  S.st = { block: bid, hold, i }; renderST(); live("See through on. Up and down move between " + (blk.classList.contains("table") ? "rows" : "figures") + ". " + (hold ? "Release Space" : "Escape") + " returns.");
}
// the one way out of show-through: every path that ends it (Done, Escape, a released Space, a new sheet, a block that is gone)
// clears the state, the sheet's .stx (which hides the lane while the panel is up), the panel, its leader and the phone bar together
function clearST() { S.st = null; renderST(); }
function endST(focusBack) {
  if (!S.st) return; const bid = S.st.block; clearST(); if (isPhone()) renderPanel();
  if (focusBack) { const b = $('[data-act="seethrough"]') || blockEl(bid); b && b.focus({ preventScroll: true }); }
  live("See through off");
}
function renderST() {
  const oldU = $(".under.mg:not(.ghost)"), oldR = oldU && oldU.getBoundingClientRect(); stLead = null;
  // focus inside the panel or its phone bar stays there when the panel is rebuilt for the next row
  const fa = document.activeElement, fKeep = fa && fa.closest ? (fa.closest(".under:not(.ghost)") ? ".under:not(.ghost) .sth" : fa.closest("#stbar") && fa.dataset.act ? `#stbar [data-act="${fa.dataset.act}"]` : null) : null; if (S.st && !blockEl(S.st.block)) S.st = null; { const sh = $("#sheet"); sh && sh.classList.toggle("stx", !!S.st && !isPhone()); }
  $$("#content .vellum").forEach(b => b.classList.remove("vellum")); $$("#content .st-on").forEach(e => e.classList.remove("st-on")); $$(".under:not(.ghost), #content .thr-svg, .stl").forEach(e => e.remove());
  const sb = $("#stbar"); if (sb) sb.hidden = !(S.st && isPhone());
  $$('[data-act="seethrough"]').forEach(b => b.setAttribute("aria-pressed", String(!!S.st)));
  const st = S.st; if (!st) { oldU && pLeave(oldU, oldR); return; }
  const blk = blockEl(st.block);
  const rows = stRows(blk), table = blk.classList.contains("table"); st.n = rows.length; st.i = clamp(st.i, 0, rows.length - 1);
  blk.classList.add("vellum"); rows[st.i].classList.add("st-on");
  // one row's panel. WORKING: the row's calculated figures, then the calculated figures they stand on; each line names its scale.
  // FILING: each quoted line once, verbatim, digits marked, in the order the row uses them; each names where it is in the filing
  const chain = id => { const out = [], walk = x => { const g = F[x]; if (!g || g.kind !== "calculated" || out.includes(x)) return; out.push(x); g.inputs.forEach(walk); }; walk(id); return out; };
  const actOf = k => table ? $$(".fig", rows[k]) : [rows[k]];
  // the panel's header repeats the active row (its label and every value cell under its column head), so a panel that
  // covers the row's right columns loses nothing
  const rowHd = k => { const c = e => esc(e.textContent.replace(/\s+/g, " ").trim());
    if (!table) { const e = rows[k], f = F[e.dataset.fact]; return `<div class="ulr"><b><span class="kw">${esc(f.label)}</span></b><em>${esc(f.period)}<strong ${hlA(f)}>${c(e)}</strong></em></div>`; }
    const hs = $$("thead th", blk), cs = [...rows[k].cells]; return `<div class="ulr"><b><span class="kw">${c(cs[0].firstChild || cs[0])}</span></b>${cs.slice(1).map((d, j) => { const g = $(".fig", d), f = g && F[g.dataset.fact]; return `<em>${hs[j + 1] ? c(hs[j + 1]) : ""}<strong ${f ? hlA(f) : ""}>${c(d)}</strong></em>`; }).join("")}</div>`; };
  const panel = k => { const act = actOf(k), ids = [...new Set(act.map(f => f.dataset.fact))];
    const shownIn = id => { const q = `.fig[data-fact="${CSS.escape(id)}"]`, e = act.find(f => f.dataset.fact === id) || $(q, blk) || $("#content " + q); return e ? e.textContent.trim() : fmt(F[id], "kpi"); };
    const calc = []; ids.forEach(id => chain(id).forEach(c => calc.includes(c) || calc.push(c)));
    const wk = calc.map(id => { const f = F[id], ov = operandView(f);
      // the formula breaks only before an operator: each operator starts a segment that keeps its operand
      const ops = ftoks(f.formula).reduce((a, t) => { const s = F[t] ? `<span data-op="${esc(t)}" ${hlA(F[t])}>${esc(ov.show(F[t]))}</span>` : esc(OPS[t] || t); if (OPS[t] || !a.length) a.push([s]); else a[a.length - 1].push(s); return a; }, []).map(g => `<span class="t">${g.join(" ")}</span>`).join(" ");
      return `<div class="wk" data-f="${esc(id)}"><div class="wc"><b><span class="kw">${esc(f.label)} · ${esc(f.period)}</span></b><span class="sc">${esc(ov.scale)}</span></div> <div class="fx">${ops} <span class="t">${ov.exact ? "=" : "→"} <span ${hlA(f, "res")}>${esc(ov.result)}</span>${ov.range ? ` (between ${esc(ov.range[0])} and ${esc(ov.range[1])})` : ""}</span> <span class="t">→ shown as <b ${hlA(f)}>${esc(shownIn(id))}</b></span></div></div>`; }).join("");
    const leaves = []; ids.forEach(id => leavesOf(id).forEach(l => leaves.includes(l) || leaves.push(l)));
    const srcs = [...new Set(leaves.map(l => F[l].source).filter(x => SRC[x]))];
    const fl = srcs.map((sid, i) => `${i ? '<div class="fold" aria-hidden="true"></div>' : ""}<div class="fl" data-src="${esc(sid)}">${markQuote(sid, leaves.filter(l => F[l].source === sid))}</div><div class="loc">${esc(SRC[sid].locator)}</div>`).join("");
    // the key to the two highlight colours sits in the sticky header, so it stays in view while the lines page under it
    const body = `${wk ? `<div class="ulh"><span>${SW("c")}Working</span><span>computed by code</span></div>${wk}` : ""}<div class="ulh"><span>${SW("q")}Filing</span><span>verbatim · in the order this ${table ? "row" : "figure"} uses them</span></div>${fl || '<div class="fl">No filing line for these figures.</div>'}`,
      hd = isPhone() ? "" : rowHd(k);
    return `<div class="ulh top"><span class="sth" role="heading" aria-level="2" tabindex="-1">See through · ${table ? "row" : "figure"} ${k + 1} of ${st.n}</span>${keyHTML(hd + body)}<span>↑ ↓ move · ${st.hold ? "release Space" : "Esc"} returns${st.hold ? "" : ` <span class="acts"><button class="btn" data-act="stprev" aria-label="Previous">↑</button><button class="btn" data-act="stnext" aria-label="Next">↓</button><button class="btn" data-act="stdone">Done</button></span>`}</span>${hd}</div>${body}`; };
  const act = actOf(st.i), u = document.createElement("div"); u.className = "under"; u.setAttribute("role", "region"); u.setAttribute("aria-label", "Beneath this block: working and filing lines");
  // the lines the active row's threads go to: its working lines and the filing lines with its digits
  const markHot = () => { const hot = new Set(), ts = act.map(el => { const id = el.dataset.fact, out = [];
      chain(id).forEach(c => { const w = $(`.wk[data-f="${CSS.escape(c)}"]`, u); w && out.push(w); });
      leavesOf(id).forEach(l => { const m = $(`mark[data-f="${CSS.escape(l)}"]`, u), line = m ? m.closest(".fl") : F[l] && $(`.fl[data-src="${CSS.escape(F[l].source)}"]`, u); m && hot.add(m); line && !out.includes(line) && out.push(line); });
      out.forEach(t => hot.add(t)); return out; });
    hot.forEach(e => e.classList.add("hot")); return ts; };
  u.innerHTML = panel(st.i); blk.appendChild(u); let targets = markHot();
  // on the desk the panel leaves the block for the margin, like the Probe: a window at the lane's right edge as tall as the band
  // allows, at least --panelW wide (over the body's right edge where the lane is narrower); its header repeats the active row, the
  // row keeps its highlight and one leader runs from it to the panel. The page moves only when the active row leaves the band, by
  // just enough to show it 8 px inside (scrollIntoView "nearest", as a WAI-ARIA APG listbox keeps its active option in view)
  if (!isPhone()) { follow(rows[st.i]); const B = band(), lane = $("#lane"), sh = $("#sheet"), lv = lane && lane.getClientRects().length, lr = (lv ? lane : sh).getBoundingClientRect(),
      W = Math.max(lv ? lr.width - 24 : 0, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--panelW")) || 440), room = Math.max(0, B.bot - B.top - 16);
    u.classList.add("mg"); sh.appendChild(u); Object.assign(u.style, { left: lr.right - 12 - W + "px", width: W + "px", top: B.top + 8 + "px" });
    // too tall for its room (as Floating UI's size does: fit the room) the panel keeps its own scroll. A solid cue at each clipped
    // end counts the lines waiting there and always covers whole lines, so no line is ever cut and every line in sight sits inside
    // the panel's padded content box. The panel opens scrolled (scrollIntoView "nearest", applied to the row's hot lines as one
    // span, inside the panel only) so that all of the active row's hot lines show when they fit; when they do not, its first
    // filing line and as many of its working lines as fit. PageUp / PageDown turn the panel a page, the next whole line at the
    // top, while show-through is on
    if (u.scrollHeight > room) { u.style.maxHeight = room + "px"; u.scrollTop = 0; stPanel(u); }
    sh.insertAdjacentHTML("beforeend", '<svg class="stl" width="1" height="1" aria-hidden="true"></svg>');
    // the leader: it starts on the active figure (a table row: its figure nearest the panel with a
    // part in sight, else its label), drops into the gap under that figure's line and runs along the gap to the panel's edge. A row
    // beyond the panel's straight edge reaches it through a free column: beside the panel, else up to the panel's foot, else in the
    // margin left of the block (outside its vellum ring) and along another line gap. It meets no other word and keeps clear of
    // other figures' rules (stObstacles). Solid from a quoted figure, dotted from a calculated one. Only a figure wholly
    // under the panel draws none (the panel's header repeats its row): one in sight left of the panel's edge comes first, then a
    // table row's label, then (a figure below the panel's foot drew none) any part of the row the panel does not cover
    stLead = () => { const g = $(".stl"); if (!g || !u.isConnected || !blk.isConnected) return; g.innerHTML = "";
      const ur = restBox(u), b = band(), pl = ur.left, lo = ur.top + 24, hi = ur.bottom - 24, bx = stObstacles(b);
      const free = ([x, y], [X, Y], m = 0) => !bx.some(q => q.right + m > Math.min(x, X) + .5 && q.left - m < Math.max(x, X) - .5 && q.bottom > Math.min(y, Y) + .5 && q.top < Math.max(y, Y) - .5);
      const cols = (x1, x2) => { const o = []; for (let x = x1; x <= x2; x += 4) o.push(x); return o; };
      const hid = r => r.left >= pl - 4 && r.right <= ur.right && r.top >= ur.top - 4 && r.bottom <= ur.bottom + 4, inB = r => r.width && r.bottom > b.top && r.top < b.bot;
      const all = act.filter(e => e.isConnected).map(e => ({ e, r: e.getBoundingClientRect() })), vis = all.filter(o => inB(o.r) && o.r.left < pl - 4);
      if (!vis.length && table && act.length) { const c = rows[st.i].cells[0], rg = document.createRange(); rg.selectNodeContents(c); const q = [...rg.getClientRects()].find(q => q.width && q.left < pl - 4); q && vis.push({ e: act[act.length - 1], r: q }); }
      const past = !vis.length; if (past) vis.push(...all.filter(o => inB(o.r) && !hid(o.r)));
      if (!vis.length) return; const { e, r: a } = vis.reduce((m, o) => o.r.right > m.r.right ? o : m), x0 = (a.left + (past ? a.right : Math.min(a.right, pl - 4))) / 2;
      // the gap under the figure's line over x1..x2: the first free band below its middle (a run into blank space keeps 6 px from it)
      const under = (x1, x2) => { const f = stGaps(bx, x1, x2, b.top, b.bot).find(([t]) => t >= a.top + a.height / 2 - .5); return f ? f[0] + Math.min(6, (f[1] - f[0]) / 2) : null; };
      // the point nearest y in a free band over x1..x2 along the panel's straight edge
      const near = (x1, x2, y) => { const c = stGaps(bx, x1, x2, lo, hi).map(([t, z]) => clamp(y, t + Math.min(6, (z - t) / 2), z - Math.min(6, (z - t) / 2)));
        return c.length ? c.reduce((m, v) => Math.abs(v - y) < Math.abs(m - y) ? v : m) : null; };
      const route = () => { const y = under(x0, pl); if (y == null) return null; if (y >= lo && y <= hi) return [[x0, y], [pl, y]];
        const yt = clamp(y, lo, hi);
        for (const xc of [pl - 8, ...cols(x0 + 8, pl - 16).reverse()]) if (free([xc, y], [xc, yt], 3) && free([xc, yt], [pl, yt])) return [[x0, y], [xc, y], [xc, yt], [pl, yt]];
        if (y > ur.bottom + 2) for (const xc of cols(Math.max(x0, pl + 24), ur.right - 24)) { const yy = under(x0, xc); if (yy != null && yy > ur.bottom + 2 && free([xc, yy], [xc, ur.bottom], 3)) return [[x0, yy], [xc, yy], [xc, ur.bottom]]; }
        const xl = blk.getBoundingClientRect().left - 16, yl = under(xl, pl), yz = yl != null ? near(xl, pl, yl) : null;
        return yz != null && free([xl, yl], [xl, yz], 3) ? [[x0, yl], [xl, yl], [xl, yz], [pl, yz]] : null; };
      const pts = route(); if (!pts) return; const y0 = Math.min(a.bottom - 1, pts[0][1]), f = F[e.dataset.fact], k = f && f.kind === "calculated" ? "c" : "q";
      g.innerHTML = `<path class="${k}" d="M${x0.toFixed(1)} ${y0.toFixed(1)}${pts.map(([x, y]) => ` L${x.toFixed(1)} ${y.toFixed(1)}`).join("")}"/><circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="2.5"/>`; };
    stLead(); if (!oldU) pEnter(u); }
  // threads in the margin: each active figure drops to its row's lower edge (a gap between lines of text), runs out to its own
  // lane left of the block and along it to the lines it stands on; it touches text only at its two ends.
  // Solid from a quoted figure, dotted from a calculated one.
  if (isPhone()) {
  const br = blk.getBoundingClientRect(), ur = u.getBoundingClientRect(), vt = u._crisp ? u._crisp[0] - 2 : Math.max(ur.top, $(".ulh.top", u).getBoundingClientRect().bottom), vb = u._crisp ? u._crisp[1] + 4 : ur.bottom, rr = rows[st.i].getBoundingClientRect(), n = act.length, X = x => (x - br.left).toFixed(1), Y = y => (y - br.top).toFixed(1);
  // in prose the run out to the margin leaves the figure's left edge along the middle of the gap between the text of its line
  // and whatever sits on the next line to its left (source chips ride high on their line)
  const gapY = a => { let lo = Infinity, hi = -Infinity; const tw = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT), boxes = $$(".stag, .per", blk).map(e => e.getBoundingClientRect()); let t;
    while ((t = tw.nextNode())) { if (!t.data.trim() || t.parentElement.closest(".under")) continue; const rg = document.createRange(); rg.selectNodeContents(t); boxes.push(...rg.getClientRects()); }
    boxes.forEach(b => { if (b.right < br.left - 16 || b.left > a.right || !b.height) return; if (b.top + b.height / 2 > a.bottom) lo = Math.min(lo, b.top); else hi = Math.max(hi, b.bottom); });
    return lo - hi >= 3 && lo < Infinity ? (hi + lo) / 2 : a.bottom + 2; };
  const paths = act.map((el, j) => { const id = el.dataset.fact, a = el.getBoundingClientRect(), gx = br.left - 12 - j * (n > 1 ? Math.min(4, 8 / (n - 1)) : 0);
    const yr = table ? rr.bottom - 1.5 - j * (n > 1 ? Math.min(2, 4 / (n - 1)) : 0) : gapY(a), ax = a.left + a.width / 2;
    const ends = targets[j].map(t => t.getBoundingClientRect()).map(t => ({ y: t.top + Math.min(10, t.height / 2), x: t.left })).filter(e => e.y > vt + 2 && e.y < vb - 4);
    const far = ends.length ? ends.reduce((m, e) => Math.abs(e.y - yr) > Math.abs(m - yr) ? e.y : m, yr) : yr;
    const d = (yr < a.bottom ? `M${X(a.left - 1)} ${Y(yr)}` : `M${X(ax)} ${Y(a.bottom)} V${Y(yr)}`) + ` H${X(gx)} V${Y(far)}` + ends.map(e => ` M${X(gx)} ${Y(e.y)} H${X(e.x)}`).join("");
    return `<path class="${F[id].kind === "calculated" ? "c" : "q"}" data-f="${esc(id)}" d="${d}"/>`; }).join("");
  blk.insertAdjacentHTML("beforeend", `<svg class="thr-svg" width="1" height="1" aria-hidden="true">${paths}</svg>`); }
  if (sb) sb.innerHTML = `<span class="t"><b>See through</b> · ${table ? "row" : "figure"} ${st.i + 1} of ${st.n}</span><button class="btn" data-act="stprev" aria-label="Previous">↑</button><button class="btn" data-act="stnext" aria-label="Next">↓</button><button class="btn primary" data-act="stdone">Done</button>`;
  if (fKeep) { const t = $(fKeep); t && t.focus({ preventScroll: true }); }
}
// a scrolling show-through panel: lines (.wk, .fl) in the panel's own coordinates; the header's foot H and the padding box's foot E
// bound the view; a cue appears at an end with lines not wholly in sight, at least one text line tall, and grows to cover any line
// it would cut. Pure geometry, so the opening scroll can be chosen before anything moves
const ST_UP = 22, ST_DN = 26;
// what a leader must not cross: the content's text lines, source tags and graphics in the band
function stObstacles(b) { const out = [], c = $("#content"); if (!c) return out; const tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let t;
  while ((t = tw.nextNode())) { if (!t.data.trim() || t.parentElement.closest(".under")) continue; const rg = document.createRange(); rg.selectNodeContents(t); for (const q of rg.getClientRects()) if (q.width && q.bottom > b.top && q.top < b.bot) out.push(q); }
  $$("#content :is(.stag, .per, svg, canvas, img)").forEach(e => { if (e.closest(".under")) return; const q = e.getBoundingClientRect(); if (q.width && q.bottom > b.top && q.top < b.bot) out.push(q); });
  // each figure's rule (the quoted hairline, the calculated double rule) with 1 px clear above and below: a leader never runs on
  // one or within 1 px of it, so it never reads as part of another figure's underline
  $$("#content .fig:not(.bar)").forEach(e => { if (e.closest(".under")) return; const bw = parseFloat(getComputedStyle(e).borderBottomWidth) || 0; if (!bw) return;
    for (const q of e.getClientRects()) if (q.width && q.bottom > b.top && q.top < b.bot) out.push({ left: q.left, right: q.right, top: q.bottom - bw - 1, bottom: q.bottom + 1 }); });
  return out; }
// the free bands (at least 3 px) between lo and hi over x1..x2 among the boxes
function stGaps(bx, x1, x2, lo, hi) { const iv = bx.filter(q => q.right > Math.min(x1, x2) && q.left < Math.max(x1, x2)).map(q => [q.top, q.bottom]).sort((p, q) => p[0] - q[0]), out = []; let y = lo;
  for (const [t, z] of iv) { if (t - y >= 3) out.push([y, Math.min(t, hi)]); y = Math.max(y, z); if (y >= hi) break; } if (hi - y >= 3) out.push([y, hi]); return out.filter(([t, z]) => z - t >= 3); }
function stBands(bx, H, E, P = E) {
  let a = H, z = E; const above = bx.some(([t]) => t < H - .5), below = bx.some(([, b]) => b > E + .5);
  if (above) { a = H + ST_UP; for (let k = 0, ch = true; ch && k < bx.length + 1; k++) { ch = false; for (const [t, b] of bx) if (t < a - .5 && b > a + .5) { a = b + 1; ch = true; } } }
  if (below) { z = P - ST_DN; for (let k = 0, ch = true; ch && k < bx.length + 1; k++) { ch = false; for (const [t, b] of bx) if (b > z + .5 && t < z - .5) { z = t - 1; ch = true; } } }
  if (z < a) z = a;
  return { a, z, up: above ? bx.filter(([t]) => t < a - .5).length : 0, dn: below ? bx.filter(([, b]) => b > z + .5).length : 0, vis: bx.map(([t, b]) => t >= a - .5 && b <= z + .5) };
}
function stPanel(u) {
  const hd = $(".ulh.top", u), mk = c => { const e = document.createElement("div"); e.className = c; e.hidden = true; e.setAttribute("aria-hidden", "true"); e.innerHTML = "<span></span>"; return e; }, m = mk("more"), mu = mk("moreup");
  u.appendChild(m); hd.after(mu); mu.style.top = hd.offsetHeight - 8 + "px";
  const ls = $$(".wk, .fl", u), u0 = u.getBoundingClientRect().top, H = hd.getBoundingClientRect().bottom - u0, P = () => u.clientTop + u.clientHeight,
    pb = parseFloat(getComputedStyle(u).paddingBottom) || 0, E = () => P() - pb, B = S => stBands(at(S), H, E(), P());
  // a line's box: a working line, or a filing line with the locator caption that follows it
  const bx0 = ls.map(l => { const r = l.getBoundingClientRect(), n = l.nextElementSibling, q = n && n.classList.contains("loc") ? n.getBoundingClientRect() : r;
    return [Math.min(r.top, q.top) - u0, Math.max(r.bottom, q.bottom) - u0]; }), at = S => bx0.map(([t, b]) => [t - S, b - S]);
  const hotF = ls.map(l => l.classList.contains("hot") && l.classList.contains("fl")), hotW = ls.map(l => l.classList.contains("hot") && l.classList.contains("wk"));
  // the opening scroll: every hot line if they fit; else a filing line and the most working lines; then the most lines in sight
  // (the least cue), then the least scroll
  const max = u.scrollHeight - u.clientHeight, cand = new Set([0, max]);
  bx0.forEach(([t, b]) => { cand.add(Math.round(t - H - ST_UP - 1)); cand.add(Math.round(b - (P() - ST_DN) + 1)); cand.add(Math.round(b - E())); });
  const nh = hotF.filter(Boolean).length + hotW.filter(Boolean).length, rank = S => { const v = B(S).vis, f = v.filter((x, i) => x && hotF[i]).length, w = v.filter((x, i) => x && hotW[i]).length; return [f + w === nh ? 1 : 0, f ? 1 : 0, w, f, v.filter(Boolean).length, -S]; };
  const best = [...cand].map(S => clamp(S, 0, max)).map(S => ({ S, r: rank(S) })).sort((p, q) => { for (let k = 0; k < 6; k++) if (p.r[k] !== q.r[k]) return q.r[k] - p.r[k]; return 0; })[0];
  u.scrollTop = best ? best.S : 0;
  // a cue that had to grow over a cut line: the panel gives that space up instead (shorter at that end, the same lines in sight,
  // each cue one text line), unless that would leave it under 96 px
  { const mh = () => parseFloat(u.style.maxHeight), c = B(u.scrollTop), w = c.up ? Math.ceil(c.a - H - ST_UP) : 0;
    if (w > 0 && u.clientHeight - w >= 96) { const S0 = u.scrollTop; u.style.maxHeight = Math.max(0, mh() - w) + "px"; u.scrollTop = S0 + w; }
    const d = B(u.scrollTop), v = P() - ST_DN - d.z; if (d.dn && v > .5 && u.clientHeight - v >= 96) u.style.maxHeight = Math.max(0, mh() - v) + "px"; }
  // a place where no whole line is in sight (two tall lines, each under a cue: a short window) is no place to rest: the panel moves
  // on, in the direction of travel, to the nearest place that shows one, as CSS scroll snap would; never against the travel
  let last = u.scrollTop;
  const cue = () => { let S = u.scrollTop, c = B(S); const r = u.getBoundingClientRect();
    if (!c.vis.some(Boolean)) { const d = S >= last ? 1 : -1, mx = u.scrollHeight - u.clientHeight;
      const T = [...new Set(bx0.flatMap(([t, b]) => [t - H - ST_UP - 1, b - (P() - ST_DN) + 1]).map(x => clamp(Math.round(x), 0, mx)))]
        .filter(x => d > 0 ? x > S : x < S).sort((p, q) => d * (p - q)).find(x => B(x).vis.some(Boolean));
      if (T != null) { u.scrollTop = T; S = u.scrollTop; c = B(S); } }
    last = S;
    mu.hidden = !c.up; m.hidden = !c.dn; mu.firstChild.style.height = c.a - H + "px"; m.firstChild.style.height = P() - c.z + "px";
    mu.firstChild.textContent = c.up ? `↑ ${nOf(c.up, "line")} above · PgUp` : ""; m.firstChild.textContent = c.dn ? `↓ ${nOf(c.dn, "more line")} below · PgDn or scroll` : "";
    u.dataset.up = c.up; u.dataset.dn = c.dn; u._crisp = [r.top + c.a, r.top + c.z]; return c; };
  // a page: the first line waiting below comes to the top (under the least "above" cue); back: the last line waiting above comes
  // to the foot (over the least "below" cue); a line taller than the view moves by the view instead
  u._page = d => { const S = u.scrollTop, c = B(S), bx = at(S), view = Math.max(40, c.z - c.a); let T;
    if (d > 0) { const j = bx.findIndex(([, b]) => b > c.z + .5); T = j < 0 ? S + view : S + bx[j][0] - H - ST_UP - 1; if (T <= S) T = S + view; }
    else { const k = bx.map(([t]) => t < c.a - .5).lastIndexOf(true); T = k < 0 ? S - view : S - (P() - ST_DN - 1 - bx[k][1]); if (T >= S) T = S - view; }
    u.scrollTop = clamp(Math.round(T), 0, u.scrollHeight - u.clientHeight); };
  cue(); u.addEventListener("scroll", cue, { passive: true });
}
function stMove(d) { if (!S.st) return; S.st.i = clamp(S.st.i + d, 0, (S.st.n || 1) - 1); renderST(); }
let hoverBlk = null;
document.addEventListener("pointermove", e => { hoverBlk = e.target.closest ? e.target.closest(ST_BLK) : null; }, { passive: true });
let spaceT = null; // a Space press over a block: a tap scrolls like the browser would, a hold (200 ms) starts show-through
document.addEventListener("keyup", e => { if (e.key !== " ") return; const t = spaceT; spaceT = null;
  if (t && t.t) { clearTimeout(t.t); e.preventDefault(); if (t.fig) { t.fig.click(); return; } const B = band(); scrollBy({ top: (t.shift ? -1 : 1) * Math.max(80, B.bot - B.top - 40), behavior: "instant" }); return; }
  if (S && S.st && S.st.hold) { e.preventDefault(); endST(); } });
addEventListener("blur", () => { if (spaceT) { clearTimeout(spaceT.t); spaceT = null; } if (S && S.st && S.st.hold) endST(); });
function idleHTML() {
  const ts = S.threads.filter(t => t.anchor && t.anchor.section_id === S.sheet);
  return `<div class="idle"><h3>Touch any figure</h3><p>A linked number is either quoted from the filing (■ on the figure map at the sheet's edge) or calculated by code (□). Touch one, or move along the figure map, to read it at four depths: Read, Exact, Work and Filing.</p><p>Select words to write a private memo, ask Athena, or suggest an edit.</p>
    <div class="listh">On this sheet · ${ts.length} thread${ts.length === 1 ? "" : "s"}</div>${ts.map(tcardHTML).join("") || '<p class="empty">No notes here yet.</p>'}
    <div class="keys">[ and ] previous / next sheet · ↑ ↓ on the figure map · 1–4 or ← → depth · Backspace steps out · M memo · ⌘↵ ask · ⌘⇧↵ suggest edit · ⌘J Conversation · Esc closes</div></div>`;
}
const DET = ["Read", "Exact", "Work", "Filing"];
function vernierHTML(f) {
  // lower row: every digit the filing printed (zeros included), or a result to the digits its operands support
  const p = spec(f, "kpi"), shown = roundStr(f.value, p.k, dpFor(f, p)).replace("−", "-"), sup = f.kind === "calculated" ? supDp(f) : printedDp(f, p);
  const ex = f.kind === "calculated" ? (sup == null ? shiftStr(f.value, p.k) : roundStr(f.value, p.k, Math.max(0, sup - p.k)).replace("−", "-")) : roundStr(f.value, p.k, sup).replace("−", "-");
  const ip = s => s.replace("-", "").split(".")[0].length, w = Math.max(ip(shown), ip(ex));
  const pad = s => " ".repeat(w - ip(s)) + s.replace("-", "");
  const a = pad(shown), b = pad(ex).slice(0, 34) + (pad(ex).length > 34 ? "…" : "");
  return `<div class="vern" aria-label="Shown ${esc(shown)} over full value ${esc(ex)} ${esc(p.unit)}"><div class="vsc"><div class="row main">${[...a].map(c => `<span>${c === " " ? "&nbsp;" : esc(c)}</span>`).join("")}</div><div class="sc"></div><div class="row ex">${[...b].map((c, i) => `<span class="${i < a.length ? "hit" : ""}">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("")}</div></div>
    <div class="lbl"><span>Shown · ${esc(p.unit)}</span><span>${esc(honesty(f))}</span></div></div>`;
}
function probeHTML(v, compact) {
  const fid = v.stack[v.stack.length - 1], f = F[fid], det = v.det, p = spec(f, "kpi"), shown = fmt(f, "kpi");
  if (compact) return `<div class="plabel"><h3><span class="kw">${esc(f.label)}</span></h3><span class="k ${hlK(f)}">${f.kind === "calculated" ? "□ Calculated" : isText(f) ? "■ Quoted from text" : "■ Quoted"}</span></div><div class="win"><div class="big"><span ${hlA(f)}>${esc(shown)}</span><span class="pchip" title="Period">${esc(f.period)}</span></div></div>`;
  let h = "";
  if (v.stack.length > 1) h += `<div class="crumb">${v.stack.map((c, i) => i < v.stack.length - 1 ? `<button data-crumb="${i}">${esc(fmt(F[c], "kpi"))}</button> ›` : `<span>${esc(fmt(F[c], "kpi"))}</span>`).join(" ")}<span class="muted">· Backspace steps out</span></div>`;
  h += `<div class="plabel"><h3><span class="kw">${esc(f.label)}</span></h3><span class="k ${hlK(f)}">${f.kind === "calculated" ? "□ Calculated" : isText(f) ? "■ Quoted from text" : "■ Quoted"}</span></div>${ctxLabel(f) ? `<div class="carried">${esc(ctxLabel(f))}</div>` : ""}`;
  h += `<div class="win" role="group" aria-label="Reading window"><div class="big"><span ${hlA(f)}>${esc(shown)}</span><span class="pchip" title="Period">${esc(f.period)}</span></div><div class="meta"><span>${isText(f) ? `as stated in the filing text${roundedText(f) ? " (rounded)" : ""}` : isDash(f) ? "printed as a dash: nil" : esc(p.unit) + " · " + esc(shownAll(f, "kpi") ? "shown in full" : p.rule)}${f.context_period && f.context_period !== f.period ? " · filing context " + esc(f.context_period) : ""}</span><span class="${hlK(f)}">${f.kind === "calculated" ? "□ calculated" : isText(f) ? "■ stated in text" : "■ as filed"}</span></div>${det === 1 && !isDash(f) && !isText(f) ? vernierHTML(f) : ""}</div>`;
  h += `<div class="travel"><div class="t" id="travel" role="slider" tabindex="0" aria-label="Probe depth" aria-valuemin="1" aria-valuemax="4" aria-valuenow="${det + 1}" aria-valuetext="${DET[det]}" aria-keyshortcuts="1 2 3 4"><div class="grad"></div><div class="track"></div>${DET.map((_, i) => `<i class="det" style="left:${i * 100 / 3}%"></i>`).join("")}<div class="sleeve" style="left:${det * 100 / 3}%"></div></div>
    <div class="labs">${DET.map((n, i) => `<button tabindex="-1" data-det="${i}" class="${i === det ? "on" : ""}" style="left:${i * 100 / 3}%">${n}<kbd>${i + 1}</kbd></button>`).join("")}</div></div>`;
  if (det === 1) {
    h += `<div class="layer" id="lyExact"><div class="lh"><span>Exact</span><span>${esc(honesty(f))}</span></div><p class="hon"><span class="lbl">${esc(honesty(f))}</span> ${esc(exactLine(f))}</p></div>`;
  }
  if (det === 2) {
    // the key to the operands' colour sits beside their count (a reported operand is teal, a calculated one yellow like the result)
    const oq = f.kind === "calculated" && f.inputs.some(i => F[i] && F[i].kind !== "calculated");
    h += `<div class="layer" id="lyWork"><div class="lh"><span>${SW("c")}Work</span><span>${f.kind === "calculated" ? f.inputs.length + " operands" + (oq ? ` · <span class="key">${SW("q")}reported</span>` : "") : "no arithmetic"}</span></div>`;
    if (f.kind !== "calculated") h += `<p class="hon">Quoted from the filing. There is no arithmetic: the Filing detent shows the line it comes from.</p>`;
    else {
      const ov = operandView(f); let rows = "", op = "";
      for (const t of ftoks(f.formula)) {
        if (OPS[t]) { op = OPS[t]; continue; }
        if (F[t]) rows += `<div class="r"><span>${op}</span><button class="opchip ${F[t].kind === "calculated" ? "c" : ""}" data-step="${esc(t)}" aria-label="Step into ${esc(F[t].label + " " + F[t].period)}"><span class="l">${esc(F[t].label)} · ${esc(F[t].period)}</span><span ${hlA(F[t], "v")}>${esc(ov.show(F[t]))}</span><span class="k">${F[t].kind === "calculated" ? "□" : "■"} ${ov.kind(F[t])} · step in ›</span></button></div>`;
        else rows += `<div class="r"><span>${op}</span><span>${esc(t)}</span></div>`;
        op = "";
      }
      h += `<div class="work" aria-label="Working"><div class="u sc">${esc(ov.scale[0].toUpperCase() + ov.scale.slice(1))}</div>${rows}<hr><div class="r"><span>${ov.exact ? "=" : "→"}</span><span ${hlA(f, "res")}>${esc(ov.result)}</span></div><div class="u">${esc(ov.note)}</div><div class="r"><span>→</span><span><b ${hlA(f)}>${esc(shown)}</b> <span class="u">${esc(shownAll(f, "kpi") ? "every digit shown" : p.rule)}</span></span></div></div><p class="also" style="margin-top:6px">Computed by code, not by a model. Enter on an operand steps in.</p>`;
    }
    h += `</div>`;
  }
  if (det === 3) {
    const lv = leavesOf(fid), srcs = [...new Set(lv.map(l => F[l].source).filter(s => SRC[s]))];
    h += `<div class="layer" id="lyFiling"><div class="lh"><span>${SW("q")}Filing</span><span>${srcs.length} line${srcs.length === 1 ? "" : "s"}</span></div>${srcs.map(sid => `<div class="qt">${markQuote(sid, lv.filter(l => F[l].source === sid))}</div><div class="loc">${esc(SRC[sid].locator)} · verbatim · Form ${FIL.form} · accession <span class="mono">${esc(SRC[sid].accession || FIL.accession)}</span></div><button class="btn text" style="padding:0" data-act="openref" data-src="${esc(sid)}">Open in References ›</button>`).join("")}${v.block && blockEl(v.block) && blockEl(v.block).matches(ST_BLK) ? `<div class="acts" style="margin-top:8px"><button class="btn" data-act="seethrough" aria-pressed="${!!S.st}">See through this block</button><span class="muted" style="font-size:12px">or hold Space over it</span></div>` : ""}</div>`;
  }
  const users = DOC.facts.filter(g => g.inputs && g.inputs.includes(fid)), secs = usersOf(fid);
  if (det === 0) h += `<div class="also">Also used in: ${secs.map(id => `<button data-act="gofig" data-sheet="${id}" data-fact="${esc(fid)}">${esc(sheetTitle(id))}</button>`).join(" · ") || "—"}${users.length ? `<br>Figures that stand on it: ${users.slice(0, 4).map(u => `<button data-act="probefact" data-fact="${esc(u.id)}">${esc(u.label)} ${esc(u.period)}</button>`).join(" · ")}${users.length > 4 ? ` +${users.length - 4} more` : ""}` : ""}</div>`;
  return h;
}
// live answers add quick actions on the figure: Explain this number asks at once, Add memo is the Memo composer, Show source
// is the Filing depth here in the page (the row below then leaves out its own Memo)
function pactsHTML() {
  const q = LIVE();
  return `${q ? `<div class="pacts qa" role="group" aria-label="Quick actions on this figure"><button class="btn" data-act="explainfig"><span class="mk ai" style="margin:0"></span>Explain this number</button><button class="btn" data-act="intent" data-intent="note"><span class="mk memo" style="margin:0"></span>Add memo</button><button class="btn" data-act="showsrc">Show source</button></div>` : ""}<div class="pacts"><button class="btn" data-act="intent" data-intent="explain"><span class="mk ai" style="margin:0"></span>Ask about this</button>${q ? "" : `<button class="btn" data-act="intent" data-intent="note"><span class="mk memo" style="margin:0"></span>Memo</button>`}<button class="btn" data-act="intent" data-intent="edit" ${S.view < S.latest ? "disabled title='Suggest edit works on the latest revision'" : ""}><span class="mk edit" style="margin:0"></span>Suggest edit</button><button class="btn" data-act="slip">Reading slip</button></div>`;
}
function setDet(d, keepFocus = true) {
  const v = activeProbe(); if (!v) return; v.det = clamp(d, 0, 3); renderPanel();
  if (keepFocus) $("#travel") && $("#travel").focus({ preventScroll: true });
  live(`${DET[v.det]} depth`);
}
function markActiveFig() {
  $$("#content .fig.on").forEach(e => e.classList.remove("on"));
  const v = activeProbe(); if (!v || v.el == null) return;
  const el = $$("#content .fig")[v.el]; if (el && el.dataset.fact === v.stack[0]) el.classList.add("on");
}
function openProbe(fid, el, det = 0, keepTray = false) {
  if (!F[fid]) return;
  const i = el ? $$("#content .fig").indexOf(el) : -1; if (i >= 0) rovingFigs(i);
  const block = el && el.closest("[data-block]");
  S.panel = S.panel.filter(v => v.t !== "probe" && !v.host); S.tray = S.trayProbe = keepTray; S.unfold = null;
  pushView({ t: "probe", stack: [fid], det, el: i >= 0 ? i : null, block: block ? block.dataset.block : null, section: block ? block.dataset.section : null });
  renderPanel();
  if (el && !isPhone() && follow(el)) layLane();
  // phone: the sheet covers the lower 62%; keep the tapped figure in view just under the header
  if (el && isPhone()) { const st = $("#strip"), hdr = (st ? st.getBoundingClientRect().bottom : 56) + 20, y = el.getBoundingClientRect().top; if (y > innerHeight * .38 - 40 || y < hdr) scrollBy({ top: y - hdr, behavior: "instant" }); }
}

/* ---------- threads ---------- */
const INTENT = {
  note: { name: "Memo", lbl: "Memo · only you", how: "<b>Only you can see this.</b> No AI call; nothing is sent to a model.", go: "Save memo", ph: "Write a note to yourself…" },
  explain: { name: "Ask", lbl: "Ask Athena · answer only", how: "Athena answers here. The report does not change.", go: "Ask", ph: "Ask about this…" },
  edit: { name: "Suggest edit", lbl: "Suggest edit · pencil draft", how: "Athena drafts a change in pencil. Nothing changes until you apply it.", go: "Request draft", ph: "Describe the change…" },
};
function composeHTML(v) {
  const ii = INTENT[v.intent], a = v.anchor, th = v.thread && threadById(v.thread);
  return `<div class="th"><div class="hd"><span class="mk ${v.intent === "note" ? "memo" : v.intent === "edit" ? "edit" : "ai"}"></span>${esc(ii.lbl)}</div>
    ${a ? `<div class="ex">“${esc(a.exact)}”</div><div class="carried">${esc(a.section_id ? sheetTitle(a.section_id) : "")}${a.fact ? " · figure" : ""}</div>` : th ? "" : `<div class="carried">About the whole report</div>`}
    <form class="composer" data-act="send"><label class="vh" for="cmp">${esc(ii.name)}</label><textarea id="cmp" class="field" rows="4" placeholder="${esc(ii.ph)}"${LIVE() && v.intent === "explain" ? ` maxlength="${ASK_MAX}"` : ""}>${esc(v.text ?? "")}</textarea>
      <div class="acts"><button class="btn primary" type="submit">${esc(v.memoEdit != null ? "Save changes" : ii.go)} <kbd>⌘↵</kbd></button><button class="btn text" type="button" data-act="pback">Cancel</button></div>
      <div class="how">${ii.how}${v.intent === "edit" && S.view < S.latest ? "<br>Suggest edit works on the latest revision." : ""}</div>
      ${v.hint && v.hint.length ? `<div class="how">This demo has no sample ${v.intent === "edit" ? "edit" : "answer"} for this spot. Samples: <span class="chiprow">${v.hint.map(c => c.q ? `<button class="chip" type="button" data-act="trycompose" data-q="${esc(c.q)}">${esc(c.q)}</button>` : `<button class="chip" type="button" data-act="trysuggest" data-v="${c.demo}">${esc(c.label)}</button>`).join("")}</span></div>` : ""}</form></div>`;
}
function threadHTML(th, pane) {
  if (!th) return idleHTML();
  const a = anchorState(th), kind = th.kind === "note" ? "memo" : th.messages[0].mode === "edit" ? "edit" : "ai";
  const now = kind === "memo" ? "" : trayState(th.messages.at(-1));
  let h = `<div class="th"><div class="hd"><span class="mk ${kind} ${DOT[now] || ""}"></span>${kind === "memo" ? "Memo · only you" : `<span class="ai">Athena · ${kind === "edit" ? "suggest edit" : "ask"}</span>`}${now ? `<span class="ss">${esc(now)}</span>` : ""}<span class="st">${th.status === "resolved" ? "Resolved" : "Open"}</span></div>`;
  h += th.anchor ? `<div class="ex">“${esc(th.anchor.exact)}”</div>${pane ? "" : `<div class="carried">${esc(sheetTitle(th.anchor.section_id))}${th.anchor.section_id !== S.sheet || S.conv ? ` · <button class="btn text" style="padding:0;min-height:24px" data-act="gothread" data-th="${th.id}">Show on the sheet</button>` : ""}</div>`}` : pane ? "" : `<div class="carried">About the whole report</div>`;
  if (a.st === "outdated") { const rv = esc(th.anchor.revision_id.slice(4)); h += `<span class="outd">Written on Rev ${rv}</span><div class="carried">These words changed in Rev ${S.view}. <button class="btn text" style="padding:0;min-height:24px" data-act="seeold" data-th="${th.id}">See it in Rev ${rv}</button></div>`; }
  else if (a.st === "carried") h += `<div class="carried">Carried to Rev ${S.view}: these words are unchanged.</div>`;
  // app mode: the app server refused this memo (also announced by live()). The box sits above the messages, next to the
  // memo however long its text is. Retry only where sending the same memo again can succeed: no answer from the
  // server, or a server error (5xx); a refusal (4xx) needs a change first. A memo written while a Demo state shows is never sent
  if (th.saveErr) h += `<div class="cant" style="margin:8px 0 10px"><div class="h">${esc(th.saveErr)}</div>${th.failJ && !th.demoNS && th.retry ? `<div class="acts"><button class="btn text" data-act="memoretry" data-th="${th.id}">Retry</button></div>` : ""}</div>`;
  const lastU = th.messages.map(m => m.role).lastIndexOf("user"), hist = lastU > 0 && th.messages.slice(0, lastU).some(m => m.refusal) ? lastU : 0;
  th.messages.forEach((m, i) => {
    if (hist && i === 0) h += `<details class="hist"><summary>Earlier in this thread · ${hist} message${hist === 1 ? "" : "s"}, including the refused draft</summary>`;
    if (hist && i === hist) h += `</details>`;
    if (m.role === "user") {
      const memo = m.mode === "note";
      h += `<div class="msg${memo ? "" : " you"}"><div class="who">You · ${memo ? "memo" : m.mode === "edit" ? "suggest edit" : "ask"} · ${esc(/^\d{4}-\d\d-\d\dT/.test(m.created_at) ? now(new Date(m.created_at)) : m.created_at)}</div><div class="tx ${memo ? "memo-t" : ""}">${esc(m.text)}</div>${memo ? `<div class="meta">${m.fromSample ? `<span class="tag">Saved from a sample answer</span> · ` : ""}Only you can see this · no AI call${m.updated_at ? " · edited " + esc(m.updated_at) : ""}</div>${th.status === "open" ? `<div class="acts" style="margin-top:2px"><button class="btn text" data-act="memoedit" data-th="${th.id}" data-i="${i}">Edit</button>${S.memoDel === th.id + ":" + i ? `<span class="confirm"><span>Delete this memo?</span><button class="btn text danger" data-act="memodelyes" data-th="${th.id}" data-i="${i}">Delete</button><button class="btn text" data-act="memodelno">Keep</button></span>` : `<button class="btn text" data-act="memodel" data-th="${th.id}" data-i="${i}">Delete</button>`}<span class="soon" title="Memos are private; sharing comes later">Share with team <span class="tag dash">Later</span></span></div>` : ""}` : ""}</div>`;
      return;
    }
    if (m.live) { h += liveMsgHTML(th, m, i); return; }
    if (m.waiting) { h += `<div class="msg"><div class="who ai">Athena</div><div class="meta">${m.mode === "edit" ? "Drafting" : "Answering"}… usually a few seconds</div></div>`; return; }
    // an answer that cites figures keys their hues on its own label line, so the key shows whenever they do
    // (the whole message, so a proposed edit's diff and newly cited figure are keyed too)
    const tx = m.text ? inline(m.text) : "", px = (m.proposal ? proposalHTML(th, m.proposal) : "") + (m.refusal ? refusalHTML(m.refusal) : ""), ks = ["q", "c"].filter(k => (tx + px).includes(k === "c" ? 'class="fig c ' : 'class="fig  '));
    h += `<div class="msg"><div class="who ai">Athena · ${m.refusal ? "draft refused" : m.proposal ? "proposed edit" : m.cant ? "can't answer from this report" : m.demo ? "live answers off" : m.mode === "edit" ? "note on the draft" : "answer"}${ks.map(k => `<span class="wk"> · <span class="key">${SW(k)}${k === "c" ? "calculated" : "reported"}</span></span>`).join("")}</div>`;
    if (m.demo) { h += `<div class="cant"><div class="h">${esc(m.text)}</div><div class="tx">Your words are kept above; nothing was sent to a model. ${NOKEY_TX}</div><div class="chiprow">${m.chips.map(c => c.q ? `<button class="chip" data-act="trysample" data-th="${th.id}" data-q="${esc(c.q)}">${esc(c.q)}</button>` : `<button class="chip" data-act="trysuggest" data-v="${c.demo}">${esc(c.label)}</button>`).join("")}</div></div><div class="meta"><span class="tag demo">No API key</span></div></div>`; return; }
    if (m.cant) h += `<div class="cant"><div class="h">This report can't answer this.</div><div class="tx">${tx}</div></div>`;
    else if (m.text) h += `<div class="tx">${tx}</div>`;
    h += px;
    h += `<div class="meta">Pre-written, no model call · reads Rev ${m.reads} · <span class="tag">Sample answer</span></div>`;
    if (m.convert && th.status === "open") h += `<div class="acts"><button class="btn" data-act="keepmemo" data-th="${th.id}" data-i="${i}">Keep as memo</button>${m.convert.block ? `<button class="btn" data-act="toedit" data-th="${th.id}" data-i="${i}">Turn into a suggested edit</button>` : ""}</div>`;
    h += `</div>`;
  });
  if (th.status === "open") h += `<div class="acts" style="border-top:1px solid var(--line);padding-top:10px;margin-top:14px">${kind === "memo" ? `<button class="btn text" data-act="reply" data-th="${th.id}">Ask Athena about this</button>` : `<button class="btn text" data-act="reply" data-th="${th.id}">Reply</button>`}<button class="btn text" data-act="resolve" data-th="${th.id}">Resolve</button></div>`;
  else h += `<div class="acts"><button class="btn text" data-act="reopen" data-th="${th.id}">Reopen</button></div>`;
  return h + `</div>`;
}
function proposalHTML(th, p) {
  const blk = blockOf(S.docs[1], p.block) || blockOf(docV(), p.block);
  const old = blk ? blk.b.text : "", parts = old ? diffWords(old, p.text) : [], ch = parts.map((d, i) => d.k !== "=" && d.t.trim() ? i : -1).filter(i => i >= 0);
  const cut = (t, head) => { const w = t.split(/(\s+)/); return w.length <= 15 ? t : head ? w.slice(0, 14).join("") + " …" : "… " + w.slice(-14).join(""); };
  const snip = ch.length ? parts.slice(Math.max(0, ch[0] - 1), ch[ch.length - 1] + 2).map((d, i, all) => d.k === "=" ? inline(i === 0 && ch[0] > 0 ? cut(d.t, false) : i === all.length - 1 ? cut(d.t, true) : d.t) : /^\s+$/.test(d.t) ? d.t : `<span class="${d.k === "+" ? "p-ins" : "p-del"}">${inline(d.t)}</span>`).join("") : "";
  let h = `<div class="prop"><div class="sum">${esc(p.summary)}</div>${snip && p.status === "pending" ? `<div class="pdiff" aria-label="The change, as a pencil diff">${snip}</div>` : ""}<div class="chk">1 paragraph in ${esc(blk ? sheetTitle(blk.s.id) : "")}${p.newly ? ` · newly cited: ${figHTML(p.newly, "prose")} (${esc(F[p.newly].label)}, already a figure in the report)` : ""}</div>
    <div class="chk"><b>Report checks:</b> no new findings. Apply runs them again before it writes.</div>`;
  if (p.status === "pending") h += `<div class="acts"><button class="btn primary" data-act="apply" data-th="${th.id}" ${p.busy ? "disabled" : ""}>${p.busy ? "Applying…" : "Apply as your Rev " + (S.latest + 1)}</button><button class="btn text" data-act="discard" data-th="${th.id}">Discard</button>${blk && blk.s.id !== S.sheet ? `<button class="btn text" data-act="gothread" data-th="${th.id}">Show the pencil</button>` : ""}</div><div class="chk">Applying makes your private Rev ${S.latest + 1}; the shared edition R1 never changes and stays readable on the dial.</div>`;
  else if (p.status === "applied") h += `<div class="receipt" tabindex="-1" data-receipt="${esc(th.id)}">Applied as your Rev ${p.rev} · private · ${p.at}. The shared edition R1 is unchanged for every reader.</div><div class="minirose"><canvas data-mini aria-label="Rosette, Rev ${p.rev}: the new ring is highlighted"></canvas><span>The rosette re-engraved for Rev ${p.rev}. The highlighted ring is the figure this edit added to ${esc(blk ? sheetTitle(blk.s.id) : "")}; the centre now reads R${p.rev}.</span></div>`;
  else if (p.status === "discarded") h += `<div class="receipt">Discarded. The report has no trace of it.</div>`;
  else if (p.status === "stale") h += `<div class="receipt">Written for Rev ${p.base}. The report has changed since.</div>`;
  return h + `</div>`;
}
function refusalHTML(r) {
  return `<div class="refusal" role="note"><div class="h">The report checks refused this draft. Nothing in the report changed.</div>
    <div class="attempt"><span class="vh">Refused draft: </span>${plainHTML(r.attempt)}</div><div>${r.plain}</div>
    <div class="acts"><button class="btn text" data-act="probefact" data-fact="${esc(r.tokFact)}" data-det="3">See ${esc(asFiled(F[r.tokFact]))} in the filing</button><button class="btn text" data-act="redo" data-th="${r.th}">Ask Athena to redo it from the tag</button></div>
    <details ${r.open ? "open" : ""}><summary>Technical line, as the checks wrote it</summary><code>${esc(r.message)}</code></details></div>`;
}

/* ---------- live answers (app mode with ask_url): answered, not checked, refused, or writes waiting for the reader ---------- */
const LIVE_WHO = { answered: "answer", unchecked: "answer, not checked", refused: "can't answer from this report", needs_approval: "asks for your approval", error: "no answer" };
// how far the check got on an answer it could not pass: "none" had nothing to check (a greeting: no figure, no citation), "part"
// names the figures it could not match and counts the rest (a {fact:id} figure is the report's own), "all" is any other reason
const chkOf = m => { const ns = m.numbers || [], bad = ns.filter(n => !n.supported_by), toks = textFacts(m.text).length;
  if (!ns.length && !toks && m.problems.length === 1 && m.problems[0] === "the answer cites nothing in the report") return { k: "none" };
  return bad.length && bad.length < ns.length + toks && m.cites.length && m.problems.length === bad.length ? { k: "part", bad, n: ns.length + toks } : { k: "all" }; };
const liveWho = m => { const c = m.live === "unchecked" ? chkOf(m) : {}; return c.k === "none" ? "reply" : c.k === "part" ? "answer, partly checked" : LIVE_WHO[m.live]; };
const chkHead = c => `${c.bad.length} of ${nOf(c.n, "figure")} couldn't be checked`;
const chkWhy = c => { const ok = c.n - c.bad.length; return `${c.bad.some(x => x.span) ? "Marked in the answer" : "Not matched"}: ${[...new Set(c.bad.map(x => x.text))].join(", ")}. The report text it cites doesn't show ${c.bad.length === 1 ? "this figure" : "these figures"}; it may be Athena's own arithmetic. ${ok === 1 ? "The other figure matches." : `The other ${ok} figures match.`}`; };
// one live turn; false when the server has live answers off, and the sample answer follows exactly as without them
async function liveAsk(th, w, text, v, intent) {
  const t0 = performance.now();
  let r; try { r = await ASK.ask(text, { thread: th.live, anchor: th.anchor || v.anchor, intent }).then(catFor); } catch (e) { liveFail(th, w, e); return true; }
  if (r.state === "disabled") { ASK_OFF = true; return false; }
  liveShow(th, w, r, t0); return true;
}
// a refused or failed request in plain words (by the server's code, else its HTTP status); the server's own words follow, smaller
const ASK_ERR = {
  pending_actions: "This conversation has proposals waiting for your decision. Approve, edit or reject them first.",
  busy: "Athena is still answering in this conversation. Wait for that answer, then ask again.",
  no_pending_actions: "Those proposals were already decided, so nothing more was sent.",
  bad_decisions: "Your decisions could not be applied: each proposal needs one decision. Nothing was saved.",
  contributor_refused: "Live answers are not set up correctly on this server, so nothing was sent to a model. Tell the person who runs it.",
  model_not_allowed: "Live answers are not set up correctly on this server, so nothing was sent to a model. Tell the person who runs it.",
  cost_cap_reached: "Live answers have reached this server's spending limit for now. Try again later.",
  model_busy: "The answer model is busy right now. Try again in a minute.",
  model_auth_failed: "The server could not sign in to its answer model. Tell the person who runs it.",
  model_error: "The answer model failed on this question. Try again, or ask it another way.",
  model_turn_limit: "This question needed more steps than Athena allows. Try a narrower question.",
  model_timeout: "The answer took too long and was stopped. Try again, or ask a narrower question.",
  model_output_limit: "The answer ran out of room. Try a narrower question.",
  model_content_filter: "The model service held back this answer. Try asking it another way.",
  ask_failed: "The answer could not be completed. Try again.",
  question_too_long: `This question is too long: a question can have up to ${ASK_MAX.toLocaleString("en-US")} characters. Shorten it and ask again.`,
  400: "This question could not be sent. Type a question, or use a quick action on a figure of this report.",
  404: "This conversation is no longer available to you. Start a new question.",
  422: "This page sent a request the server could not read. Nothing was sent to a model.",
  429: "You have reached the most memos and conversations one reader can keep, so a new conversation can't start. Deleting a memo you no longer need makes room; otherwise, tell the person who runs this server.",
};
const askErr = e => ASK_ERR[e.code] || ASK_ERR[e.status] || (e.status === undefined ? "The app server did not answer. Check the connection and try again."
  : e.status >= 500 ? "The server failed on this request. Try again in a minute." : "The server refused this request.");
// a failed turn still names its thread (a reply continues it) and runs the view actions of tools that ran before it; after
// applied decisions the server's notice (what was saved) is the main message
function liveFail(th, w, e) {
  const t = e.turn || {}; th.live = t.thread || th.live;
  Object.assign(w, { waiting: false, live: "error", err: askErr(e), notice: t.notice || "", more: e.status === undefined ? "" : e.message, text: "", cites: [], problems: [], pending: [] });
  refresh(); if (document.activeElement === document.body) focusThread(th); runUi(t.ui);
  live(`${w.notice || "Athena could not answer."} ${w.err}`);
}
function liveShow(th, w, r, t0) {
  th.live = r.thread || th.live;
  Object.assign(w, { waiting: false, live: r.state, text: r.text, cites: r.cites, numbers: r.numbers, problems: r.problems, pending: r.pending, latency_s: (performance.now() - t0) / 1000 });
  refresh(); if (document.activeElement === document.body) focusThread(th);
  runUi(r.ui);
  const n = r.pending.length, c = r.cites.length;
  live(r.state === "answered" ? `Athena answered: ${plain(r.text)}${r.numbers.length ? " Figures match the cited report." : ""}${c ? ` ${nOf(c, "citation")} below the answer.` : ""}`
    : r.state === "refused" ? `Athena can't answer that from this report. ${plain(r.text)}`
    : r.state === "needs_approval" ? `Athena asks for your approval: ${nOf(n, "proposed action")}.`
    : (c2 => c2.k === "none" ? `Athena: ${plain(r.text)}` : c2.k === "part" ? `Athena answered. ${chkHead(c2)}. ${chkWhy(c2)}`
      : `Athena answered, but the answer couldn't be checked against the report${r.problems.length ? ": " + r.problems.join("; ") : ""}.`)(chkOf(w)));
}
// the view actions a live turn asks for, run here in the page (they change nothing on the server)
function runUi(list) {
  for (const a of list || []) {
    if (a.type === "open_chapter" && sheetIds().includes(a.section_id)) goSheet(a.section_id, { keepPanel: true });
    else if (a.type === "highlight") citeGo(a, false);
    else if (a.type === "open_library") goRoute("library");
    else if (a.type === "overlay_added" && a.kind === "memo") reloadMemos();
    else if (a.type === "overlay_added" && a.kind === "revision" && S.persist) loadRevs(true).catch(e => live("Your revision is saved, but it could not be shown: " + e.message));
    else if (a.type === "open_report_request") { S.newForm = { co: "", form: "10-K", fy: "FY" + FY, lang: "en" }; S.newOpen = true; S.newLive = APP; ljOpenForm(); if (LJ.form && a.filing_id) { LJ.form.filing_id = a.filing_id; ljOne(); } renderLayer(); }
  }
}
// a citation names a block, a figure, a source or a chapter of this edition: its chip opens the sheet and marks the block
const blockName = id => { const x = blockOf(docV(), id); if (!x) return "a passage"; const i = x.s.blocks.indexOf(x.b) + 1;
  return `${sheetTitle(x.s.id)} · ${x.b.title || (x.b.kind === "table" ? "table" : x.b.kind === "chart" ? "chart" : "paragraph")} ${x.b.title ? "" : i}`.trim(); };
const citeName = c => c.kind === "fact" && F[c.id] ? `${F[c.id].label} ${F[c.id].period}` : c.kind === "source" && SRC[c.id] ? SRC[c.id].locator
  : c.kind === "section" || sheetIds().includes(c.id) ? sheetTitle(c.id) : blockName(c.id);
function citeEl(c) {
  if (c.kind === "section" || sheetIds().includes(c.id)) return $("#content h1");
  if (c.kind === "fact") { const f = $(`#content .fig[data-fact="${CSS.escape(c.id)}"]`); return f && (f.closest("[data-block]") || f); }
  if (c.kind === "source") { const s = $(`#content .stag[data-src="${CSS.escape(c.id)}"]`); return s && s.closest("[data-block]"); }
  return blockEl(c.id);
}
function citeSheet(c) {
  if (c.kind === "section" || sheetIds().includes(c.id)) return c.id;
  if (c.section_id && sheetIds().includes(c.section_id)) return c.section_id;
  const has = c.kind === "fact" ? `{fact:${c.id}}` : `[${c.id}]`, d = docV();
  if (c.kind === "block") { const x = blockOf(d, c.id); return x && x.s.id; }
  // a figure or a source used on several sheets: the sheet in view when it is there, else the first that uses it
  const on = s => s.blocks.some(b => JSON.stringify(b).includes(has)), cur = S.route === "desk" && !S.conv && secById(d, S.sheet);
  if (cur && cur.blocks && on(cur)) return cur.id;
  const s = d.sections.find(on); return s ? s.id : null;
}
function citeGo(c, focus = true) {
  const sh = citeSheet(c);
  if (sh && (S.route !== "desk" || S.conv || S.sheet !== sh)) goSheet(sh, { keepPanel: true });
  const el = sh && citeEl(c);
  if (!el) { live(`${citeName(c)} is not on a sheet of this report.`); return; }
  $$("#content .cited").forEach(e => e.classList.remove("cited"));
  el.classList.add("cited"); setTimeout(() => el.classList.remove("cited"), 2600);
  if (isPhone() && S.panelFull) { S.panelFull = false; renderPanel(); } // the larger panel leaves no band for the mark
  follow(el); // the desk's one page move: into the band the tray, the header and the phone strip leave visible
  if (focus) { if (!el.hasAttribute("tabindex")) el.tabIndex = -1; el.focus({ preventScroll: true }); }
  live(`${citeName(c)}, marked on the sheet.`);
}
// a long answer cites many facts: a few chips show and the rest fold behind "… N more", so the answer stays in front
const CITES_SHOWN = 4, CITES_OPEN = new WeakSet();
const citeChip = c => `<button class="chip" data-act="cite" data-id="${esc(c.id)}" data-kind="${esc(c.kind || "")}" data-sec="${esc(c.section_id || "")}" title="${esc(citeName(c))}">${esc(citeName(c))}</button>`;
const citesHTML = (m, th, i) => { const a = m.cites.slice(0, CITES_SHOWN), b = m.cites.slice(CITES_SHOWN), open = CITES_OPEN.has(m);
  return m.cites.length ? `<div class="chiprow cites" role="group" aria-label="Cited in this report">${a.map(citeChip).join("")}${b.length > 1 ? `<button class="chip" type="button" data-act="cmore" data-th="${th.id}" data-i="${i}" aria-expanded="${open}">… ${b.length} more</button><div class="chiprow"${open ? "" : " hidden"}>${b.map(citeChip).join("")}</div>` : b.map(citeChip).join("")}</div>` : ""; };
// a long answer reads in short paragraphs, cut at sentences by the browser's own segmenter, never inside a **bold** run
const SENT = Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;
const parasOf = t => t.split(/\n\s*\n/).flatMap(b => { if (!SENT || plain(b).length < 260) return [b];
  const out = [], stray = !(b.split("**").length % 2); let cur = ""; // a stray ** opens no bold run, so it holds back no cut
  for (const { segment } of SENT.segment(b)) { cur += segment; if (plain(cur).length >= 180 && (stray || cur.split("**").length % 2)) { out.push(cur); cur = ""; } }
  return cur ? [...out, cur] : out; });
const parasHTML = t => parasOf(t).map(p => `<p>${inline(p).replace(/\uE000/g, '<mark class="unm">').replace(/\uE001/g, "</mark>")}</p>`).join("");
// the figures the check could not match, marked where the server found them (span, in code points like [...t]). An answer
// stored before spans has none, and chkWhy then lists its figures without saying they are marked
const markBad = (t, bad) => { const c = [...t]; for (const { span: s } of bad) if (s) { c[s[0]] = "\uE000" + c[s[0]]; c[s[1] - 1] += "\uE001"; } return c.join(""); };
// what the server's check covers: figures only, so an answer never carries a blanket badge
const CHECK_NOTE = "Athena checks that every figure in an answer appears in the report text the answer cites, or follows from it by rounding. It does not check words of direction, such as “grew” or “fell”, which line or year a figure is said to belong to, or the reasoning; read the cited passages for those. Form and section numbers, the day of a date and a length of time don't count as figures, and a year only has to be one the report prints.";
const checkNote = label => `<details class="chk-n"><summary>${label}</summary><p>${CHECK_NOTE}</p></details>`;
function liveMsgHTML(th, m, i) {
  const k = m.live, c = k === "unchecked" ? chkOf(m) : {}, tx = k === "answered" ? parasHTML(undouble(m.text)) : c.k === "part" ? parasHTML(markBad(m.text, c.bad)) : plainHTML(m.text);
  let h = `<div class="msg" data-live="${k}"><div class="who ai">Athena · ${liveWho(m)}</div>`;
  if (k === "error") h += `<div class="cant"><div class="h">${esc(m.notice || "Athena could not answer.")}</div><div class="tx">${esc(m.err)}</div>${m.more ? `<div class="meta">From the server: ${esc(m.more)}</div>` : ""}</div>`;
  else if (k === "refused") h += `<div class="cant"><div class="h">This report can't answer this.</div><div class="tx">${tx}</div></div>`;
  else if (c.k === "none") h += `<div class="tx">${tx}</div><div class="meta">This reply has no figures to check and cites nothing from the report.</div>`;
  else if (c.k === "part") h += `<div class="tx">${tx}</div><div class="cant unchk"><div class="h">${esc(chkHead(c))}</div><div class="tx">${esc(chkWhy(c))}</div>${checkNote("What the check covers")}</div>${citesHTML(m, th, i)}`;
  else if (k === "unchecked") h += `<div class="cant unchk"><div class="h">Couldn't check this against the report</div><div class="tx">${m.problems.length ? `Why: ${m.problems.map(esc).join("; ")}.` : "No reason was given."} Its figures are shown as plain text, not as the report's figures.</div>${checkNote("What the check covers")}</div>${m.text ? `<div class="tx">${tx}</div>` : ""}`;
  else if (m.text) h += `<div class="tx">${tx}</div>`;
  if (k === "answered") h += ((m.numbers || []).length ? checkNote("Figures match the cited report") : "") + citesHTML(m, th, i);
  h += m.pending.map((p, j) => aprHTML(th, i, j, p)).join("");
  if (k !== "error") h += `<div class="meta">${k === "needs_approval" ? "Proposed" : "Answered"}${m.latency_s == null ? "" : ` in ${m.latency_s.toFixed(1)} s`} · reads the shared edition R${(DOC.edition && DOC.edition.number) || 1} · <span class="tag">Live answer</span></div>`;
  return h + `</div>`;
}
// a write the agent proposes waits for the reader: what it would do, in plain words, then Approve, Edit or Reject
const TOOLS = {
  add_memo: { what: "Save a private memo", rows: a => [["Memo", a.text], ["On", a.block_id ? blockName(a.block_id) + (a.quote ? ` · “${plain(a.quote)}”` : "") : "The whole report"]], edit: [["text", "Memo"]] },
  propose_revision: { what: "Rewrite one passage as your private revision (the shared edition does not change)", rows: a => [["Passage", blockName(a.block_id)], ["What changes", a.summary], ["New text", plain(a.text)]], edit: [["summary", "What changes"], ["text", "New text"]] },
  request_report: { what: "Open the New report form for another filing", rows: a => [["Filing", (e => e ? `${e.issuer} · ${e.form} · ${e.period}` : a.filing_id)(Array.isArray(LJ.cat) && LJ.cat.find(e => e.filing_id === a.filing_id))], ["Language", a.language === "ko" ? "한국어" : a.language === "en" ? "English" : a.language, rrKo(a) ? '<span lang="ko">한국어</span><span class="later">later</span>' : null]], edit: null,
    no: a => rrKo(a) && "Korean reports arrive in a later version, so this request can't start a report. Reject it to answer Athena." },
};
// a Korean filing carries the catalog's later tag, and its request can be rejected but not approved
const rrKo = a => a.language === "ko" || Array.isArray(LJ.cat) && LJ.cat.some(e => e.filing_id === a.filing_id && ljLater(e));
// a request_report card names the filing as the catalog lists it: the catalog is loaded before such a card is first shown
const catFor = r => !r.pending.some(p => p.tool === "request_report") || Array.isArray(LJ.cat) ? r
  : api("GET", JAPI + "/catalog").then(c => { if (Array.isArray(c) && !Array.isArray(LJ.cat)) LJ.cat = c; }, () => {}).then(() => r);
const toolOf = p => TOOLS[p.tool] || { what: `Run “${p.tool}”`, rows: a => Object.entries(a).map(([k, v]) => [cap1(uword(k)), typeof v === "string" ? v : JSON.stringify(v)]), edit: null };
function aprHTML(th, i, j, p) {
  const t = toolOf(p), key = `${th.id}-${i}-${j}`, at = `data-th="${th.id}" data-i="${i}" data-j="${j}"`;
  // a card that came back with its thread: a keyless server can't take a decision, and a proposal written for an earlier Rev can only be rejected
  const stale = p.tool === "propose_revision" && p.base < S.latest, no = !ASK ? "Live answers are off on this server, so this proposal can't be decided now." : stale ? `Written for Rev ${p.base}. The report has changed since. Reject it and ask again.` : t.no && t.no(p.args);
  let h = `<div class="prop apr" role="group" aria-labelledby="apr-${key}" data-apr="${key}"><div class="sum" id="apr-${key}">Athena asks to: ${esc(t.what)}</div>
    <dl class="edst">${t.rows(p.args).map(([d, v, x]) => `<dt>${esc(d)}</dt><dd>${x != null ? x : esc(v ?? "")}</dd>`).join("")}</dl>${p.problems.length ? `<div class="chk"><b>Can't be approved as it is:</b> ${p.problems.map(esc).join("; ")}.</div>` : ""}${no && !p.d ? `<div class="chk"><b>Can't be approved yet:</b> ${esc(no)}</div>` : ""}`;
  if (p.d) h += `<div class="receipt" tabindex="-1" data-receipt="apr-${key}">${p.busy ? "Sending your decision…" : { approve: "Approved.", edit: "Edited and approved.", reject: "Rejected. Nothing was saved." }[p.d.type]}${p.waitOthers ? " Decide the other proposal to send both." : ""}</div>`;
  else if (p.editing) h += `<form class="apredit" data-act="aprsave" ${at}>${t.edit.map(([f, l]) => `<label class="lb" for="apr-${key}-${f}">${esc(l)}</label><textarea id="apr-${key}-${f}" class="field" data-f="${f}" rows="${f === "text" ? 4 : 2}">${esc(p.args[f] ?? "")}</textarea>`).join("")}
      <div class="acts"><button class="btn primary" type="submit">Save and approve</button><button class="btn text" type="button" data-act="aprcancel" ${at}>Cancel</button></div></form>`;
  else h += `<div class="acts">${no ? "" : `<button class="btn primary" data-act="apr" data-d="approve" ${at} ${p.problems.length ? "disabled" : ""}>Approve</button>`}${t.edit && ASK && !stale ? `<button class="btn" data-act="apr" data-d="edit" ${at}>Edit</button>` : ""}${ASK ? `<button class="btn text" data-act="apr" data-d="reject" ${at}>Reject</button>` : ""}</div>`;
  return h + `</div>`;
}
// focus, kept in view: inside the tray's list or the phone panel (the tray's own scroll margins keep scrollIntoView from moving
// them), or by the desk's one page move for a balloon in the margin
function keepIn(e) { // the nearest of them that scrolls (on the phone the tray's list does not; its panel does)
  const l = ["#trayList", "#wpb", "#wpanel"].map(s => e.closest(s)).find(x => x && x.scrollHeight > x.clientHeight + 1); if (!l) { if (e.closest("#lane")) follow(e); return; }
  // a receipt keeps the failure that followed it in view too (its notice, reason and server line), never scrolling the receipt out
  const n = e.matches(".receipt") && e.closest(".msg"), x = n && n.nextElementSibling, to = x && x.matches('.msg[data-live="error"]') ? x : e;
  const r = e.getBoundingClientRect(), b = l.getBoundingClientRect(), bot = to.getBoundingClientRect().bottom;
  const d = bot > b.bottom - 8 ? Math.min(bot - b.bottom + 8, r.top - b.top - 8) : r.top < b.top + 8 ? r.top - b.top - 8 : 0;
  if (d) l.scrollTop += d; }
const aprFocus = (sel) => { const e = $(sel); if (e) { if (!e.hasAttribute("tabindex") && !/^(BUTTON|TEXTAREA)$/.test(e.tagName)) e.tabIndex = -1; e.focus({ preventScroll: true }); keepIn(e); } };
// every proposal of a turn is decided before the decisions go to the server together; the next turn follows in the thread
async function aprDecide(th, i, j, type, args) {
  const m = th.messages[i], p = m.pending[j], key = `${th.id}-${i}-${j}`;
  p.editing = false; p.d = { id: p.id, type, ...(type === "edit" ? { args } : {}) };
  const open = m.pending.filter(x => !x.d);
  m.pending.forEach(x => { x.waitOthers = !!open.length; });
  if (open.length) { refresh(); aprFocus(`[data-apr="${th.id}-${i}-${m.pending.indexOf(open[0])}"] .acts .btn:not([disabled])`); live("Decision noted. Decide the other proposal to send both."); return; }
  m.pending.forEach(x => { x.busy = true; }); refresh(); aprFocus(`[data-receipt="apr-${key}"]`);
  const w = { role: "assistant", mode: "explain", waiting: true }; th.messages.push(w); S.askTh = th.id; refresh(); aprFocus(`[data-receipt="apr-${key}"]`);
  const t0 = performance.now();
  try { const r = await ASK.decide(th.live, m.pending.map(x => x.d)).then(catFor); m.pending.forEach(x => { x.busy = false; });
    if (r.state === "disabled") { ASK_OFF = true; th.messages.pop(); m.pending.forEach(x => { x.d = null; }); refresh(); aprFocus(`[data-apr="${key}"] .acts .btn:not([disabled])`); live(`Live answers are off on the server; nothing was sent. ${r.notice}`); return; }
    liveShow(th, w, r, t0); }
  catch (e) { const applied = !!(e.turn && e.turn.notice); // the server applied them before the answer failed: they stay decided
    m.pending.forEach(x => { x.busy = false; if (!applied) x.d = null; }); liveFail(th, w, e); }
  // a dialog the answer opened (an approved New report request) keeps the keyboard
  if (!$('#layer [aria-modal="true"]')) aprFocus(p.d ? `[data-receipt="apr-${key}"]` : `[data-apr="${key}"] .acts .btn:not([disabled])`);
}

/* ---------- sample turns: every figure is a {fact:id} of the data ---------- */
const DOCK_QS = ["Summarize the year in two sentences.", "What was free cash flow after stock compensation?", "What is the share price today?"];
const has = (...ids) => ids.every(id => F[id]);
const dockQs = () => DOCK_QS.filter(q => q !== DOCK_QS[1] || has("fcf-after-sbc-fy2025", "fcf-fy2025", "sbc-fy2025")); // only what this report can answer
const inFY = (...ids) => `In ${andJoin([...new Set(ids.filter(i => F[i]).map(i => F[i].period))])}, `;
const sr = (...ids) => [...new Set(ids.map(i => F[i] && F[i].source).filter(Boolean))].map(x => ` [${x}]`).join("");
// the blocks the sample turns use, found by the figures they cite (ids may differ between data builds)
const proseWith = (inc, exc) => { for (const s of DOC.sections) for (const b of s.blocks) if (b.kind === "prose" && b.text.includes(`{fact:${inc}}`) && !(exc && b.text.includes(`{fact:${exc}}`))) return { s, b }; return null; };
const EDIT_OK = () => has("fcf-after-sbc-fy2025", "sbc-fy2025", "fcf-fy2025") && proseWith("sbc-fy2025", "fcf-fy2025");
const EDIT_REFUSE = () => has("revenue-fy2024") && proseWith("revenue-fy2025", "fcf-fy2025");
const INVEST = () => has("sec-purchases-fy2025", "sec-proceeds-fy2025", "net-sec-purchases-fy2025", "capex-fy2025") && proseWith("net-sec-purchases-fy2025");
const ANSWERS = {
  invest: () => INVEST() && `Because the cash went into securities, not equipment. ${inFY("sec-purchases-fy2025")}purchases of marketable securities were {fact:sec-purchases-fy2025} and proceeds from sales and redemption were {fact:sec-proceeds-fy2025}${sr("sec-purchases-fy2025", "sec-proceeds-fy2025")}, so net purchases were {fact:net-sec-purchases-fy2025}. Purchases of property and equipment were only {fact:capex-fy2025}${sr("capex-fy2025")}.`,
};
const PRICE_Q = /share price|stock price|price today|today's price|market (cap|value)|trading at/i;
function cantPrice() {
  const eps = DOC.facts.find(f => f.unit === "usd_per_share" && f.label.toLowerCase().includes("diluted") && String(f.period).includes(String(FY)));
  return { cant: true, text: `This report is built from the ${FIL.form} for the fiscal year ended ${FIL.period_end}. It does not contain today's share price, and Athena does not fetch market prices in this demo, so I won't guess one.${eps && DOC.sections.some(s => s.blocks.some(b => b.kind === "lab")) ? ` If you type a price into the Valuation lab, I can show what it implies against diluted earnings per share of {fact:${eps.id}}.` : ""}` };
}
function factAnswer(fid) {
  const f = F[fid];
  if (f.kind !== "calculated") return `${f.label} for ${f.period} is quoted from the filing: {fact:${fid}}${f.source ? ` [${f.source}]` : ""}. ${SRC[f.source] ? `It is in ${SRC[f.source].locator}; the Filing depth of the Probe shows the line with its digits marked.` : ""}`;
  const ins = f.inputs.filter(i => F[i]);
  return `${f.label} for ${f.period} is calculated by code, not taken from the filing. It works from ${ins.map(i => `${lc1(F[i].label)} of {fact:${i}}`).join(" and ")}${ins.map(i => F[i].source ? ` [${F[i].source}]` : "").join("")}. The Work depth shows each step, and every operand opens on its own.`;
}
// Typed input never gets another question's answer: a sample answers only text that asks for it;
// questions the filing cannot answer get the calm refusal; anything else gets an honest demo card.
const OUT_Q = /\b(today|tomorrow|next (year|quarter)|forecast|predict|guidance|price target|target price|should i (buy|sell|hold)|buy or sell|worth buying|undervalued|overvalued)\b/i;
const cantOther = () => ({ cant: true, text: `This report is built from the ${FIL.form} for fiscal ${FY}. It can't say what happens next or whether to buy or sell, and Athena won't guess or give investment advice.` });
const demoCard = (chips, edit) => ({ demo: true, text: `Live ${edit ? "edits" : "answers"} are off: this copy has no Meta API key.`, chips });
const SAMPLE_RE = {
  summary: /summar|overview|two sentences|in short|the year/i,
  fcf: /free cash flow|\bfcf\b/i,
  fact: /where|come from|calculat|comput|derive|source|filing|what is this|explain/i,
  invest: /invest|securit|capital spend|capex|so large|tiny/i,
  passage: /rest on|based on|which figures|what figures|source|where .* from/i,
  editOk: /free cash flow|stock(-based)? comp|real cost|\bsbc\b/i,
  editNo: /revenue|last year|prior year|2024/i,
};
function sampleTurn(mode, anchor, text, th) {
  if (PRICE_Q.test(text)) return cantPrice();
  if (OUT_Q.test(text)) return cantOther();
  if (mode === "edit") {
    const bid = anchor && anchor.block_id, blk = bid && blockOf(S.docs[S.latest], bid), ok = EDIT_OK(), no = EDIT_REFUSE();
    const others = [ok && { demo: "suggest", label: `Suggest edit in ${sheetTitle(ok.s.id)}` }, no && { demo: "refused", label: `Suggest edit in ${sheetTitle(no.s.id)} (refused first)` }].filter(Boolean);
    const refused = th ? th.messages.some(m => m.refusal) : false;
    const d = blk && blk.b.kind === "prose" && draftFor(blk.b, refused);
    if (!d) return demoCard(others, true);
    const asks = ok && ok.b.id === bid ? SAMPLE_RE.editOk : SAMPLE_RE.editNo;
    if (!asks.test(text)) return demoCard([{ q: sampleReq("edit", anchor) }, ...others], true);
    if (d.refuse) return { text: "", refusal: d.refuse };
    return { text: d.note || "", proposal: { block: bid, text: d.text, summary: d.summary, newly: d.newly, status: "pending", base: S.latest } };
  }
  if (!anchor || !anchor.section_id) {
    if (SAMPLE_RE.fcf.test(text) && has("fcf-after-sbc-fy2025", "fcf-fy2025", "sbc-fy2025")) { const ok = EDIT_OK(), used = usersOf("fcf-after-sbc-fy2025", docV());
      return { text: `${inFY("fcf-after-sbc-fy2025")}simple free cash flow after stock compensation was {fact:fcf-after-sbc-fy2025}: simple free cash flow of {fact:fcf-fy2025} less stock-based compensation of {fact:sbc-fy2025}${sr("sbc-fy2025")}. ${used.length ? "It appears in " + used.map(id => sheetTitle(id)).join(", ") + "." : "No sheet shows this figure yet."}${ok && !used.includes(ok.s.id) ? ` ${sheetTitle(ok.s.id)}, which discusses stock compensation, does not show it.` : ""}`, convert: ok && !used.includes(ok.s.id) ? { block: ok.b.id, req: "Add simple free cash flow after stock compensation to this paragraph, and call stock compensation a real cost." } : {} }; }
    if (SAMPLE_RE.summary.test(text)) { const ks = (DOC.cover.kpis ? DOC.cover.kpis.items : []).filter(k => F[k.fact]).slice(0, 3);
      return { text: `${inFY(...ks.map(k => k.fact))}${ks.map((k, i) => `${i ? (i === ks.length - 1 ? " and " : ", ") : ""}${lc1(k.label)} was {fact:${k.fact}}${k.delta && F[k.delta] ? ` (change {fact:${k.delta}})` : ""}`).join("")}. ${plain(DOC.cover.standfirst)}`, convert: {} }; }
    return demoCard(dockQs().map(q => ({ q })));
  }
  if (anchor.fact) return SAMPLE_RE.fact.test(text) ? { text: factAnswer(anchor.fact) } : demoCard([{ q: sampleReq("explain", anchor) }]);
  const inv = INVEST() && INVEST().b.id === anchor.block_id;
  if (inv && SAMPLE_RE.invest.test(text)) return { text: ANSWERS.invest() };
  if (SAMPLE_RE.passage.test(text)) {
    const blk = blockOf(docV(), anchor.block_id), ids = blk ? blockFacts(blk.b).slice(0, 3) : [];
    return { text: ids.length ? `This passage stands on ${ids.map(i => `{fact:${i}} (${F[i].period})`).join(", ")}. Each is ${ids.every(i => F[i].kind !== "calculated") ? "quoted from the filing" : "either quoted from the filing or calculated from figures that are"}; touch one for its working and its filing line.` : "This passage cites no figures." };
  }
  return demoCard([inv ? { q: SAMPLE_REQ.explain } : { q: "What does this passage rest on?" }]);
}
function draftFor(b, refusedBefore) {
  const t = b.text;
  const ok = EDIT_OK(), no = EDIT_REFUSE();
  if (ok && ok.b.id === b.id) {
    const add = " Subtracting it from simple free cash flow of {fact:fcf-fy2025} leaves {fact:fcf-after-sbc-fy2025}.";
    let nt = t.replace("The largest noncash add-back was", "The largest noncash add-back, and a real cost paid in shares rather than cash, was").replace("stock-based compensation was {fact:sbc-fy2025}", "stock-based compensation, a real cost paid in shares rather than cash, was {fact:sbc-fy2025}");
    nt = /\{fact:sbc-fy2025\}(?: \[src-[\w-]+\])*\./.test(nt) ? nt.replace(/\{fact:sbc-fy2025\}(?: \[src-[\w-]+\])*\./, m => m + add) : nt.replace(/\.?\s*$/, ".") + add;
    return { text: nt, summary: "Add simple free cash flow after stock compensation", newly: "fcf-after-sbc-fy2025" };
  }
  if (no && no.b.id === b.id) {
    const g = F["revenue-fy2024"], X = "{fact:revenue-fy2025}", at = t.includes(X + ", up {fact:revenue-growth-fy2025}") ? X + ", up {fact:revenue-growth-fy2025}" : X;
    if (!refusedBefore) return { refuse: { attempt: t.replace(at, at + " from total revenue of {fact:revenue-fy2024}"), tokFact: g.id,
      plain: `My draft registered the number <b class="mono">${esc(asFiled(g))}</b> ($ ${esc(g.scale)}) as a new figure, “total revenue FY2025”, from a text quote. The filing tags that number as <b>${esc(g.label)}, ${esc(g.period)}</b>. A new figure must be taken from its filing tag, so the checks refused the draft.`,
      message: "The edit fails the report checks: high tag-required facts.total-revenue-fy2025: the filing tags this figure (t-88: Revenue, FY2024); register it from its tag, not from a text quote" } };
    return { text: t.replace(at, at + " from {fact:revenue-fy2024}"), summary: "Add FY2024 revenue, from the report's existing figure", newly: "revenue-fy2024", note: "Redone from the tag: the sentence now cites the report's existing FY2024 revenue figure, so no new figure is registered." };
  }
  return null;
}
const SAMPLE_REQ = { note: "Use this in Thursday's note: stock comp is a cost even without cash.", explain: "Why is investing cash flow so large when capital spending is tiny?", edit: "Add free cash flow after stock compensation, and call stock compensation a real cost." };
function sampleReq(intent, anchor) {
  if (intent === "explain" && anchor && anchor.fact) return `Where does ${fmt(F[anchor.fact], "kpi")} come from?`;
  if (intent === "edit" && anchor && anchor.block_id) { const no = EDIT_REFUSE(); if (no && no.b.id === anchor.block_id) return "Add last year's revenue to this sentence."; }
  if (intent === "explain" && anchor && !(INVEST() && INVEST().b.id === anchor.block_id)) return "What does this passage rest on?";
  if (intent === "note" && anchor && anchor.fact) return "Check this against next year's filing.";
  return SAMPLE_REQ[intent];
}
function startIntent(intent, anchor, thread) {
  if (intent === "edit" && S.view < S.latest) { live("Suggest edit works on the latest revision"); return; }
  hideToolbar();
  // a prefill is written only when it gets its sample answer; otherwise the composer starts empty and lists the samples
  let text = thread ? "" : sampleReq(intent, anchor), hint = null;
  if (text && intent !== "note") { const r = sampleTurn(intent, anchor, text); if (r.demo) { hint = r.chips; text = ""; } }
  const top = topView(), host = top && top.t === "probe" && anchor && anchor.fact ? "probe" : null;
  if (!host && onSheetA(anchor || (thread && (threadById(thread) || {}).anchor))) { S.tray = false; if (!thread) S.panel = S.panel.filter(v => v.t !== "probe"); }
  pushView({ t: "compose", intent, anchor, thread, text, hint, host, sample: text });
  if (!isPhone() && inTray(topView())) S.tray = true;
  renderPanel(); focusCmp();
}
async function send(v, text, intent) {
  text = text.trim(); if (!text) return;
  if (v.memoEdit != null) { const th = threadById(v.thread), m = th.messages[v.memoEdit]; m.text = text; m.updated_at = now(); S.panel.pop(); const ns = demoNS(th, "Changes not saved"); refresh(); focusThread(th); if (ns) live(th.saveErr); return; }
  let th = v.thread && threadById(v.thread);
  const mode = v.intent;
  if (!th) { th = { id: "t" + (++S.seq), kind: mode === "note" ? "note" : "ai", anchor: v.anchor, status: "open", messages: [], user: mode === "note" }; S.threads.push(th); }
  th.messages.push({ role: "user", mode, text, created_at: now() }); if (mode !== "note") S.askTh = th.id;
  if (v.host) S.panel = S.panel.filter(x => x.t !== "probe"); // the Probe balloon becomes the conversation balloon
  S.panel[S.panel.length - 1] = { t: "thread", id: th.id };
  if (mode === "note") { const ns = demoNS(th, "Not saved"); refresh(); focusThread(th); live(ns ? th.saveErr : !APP ? "Memo saved. Only you can see it." : S.persist ? "Saving the memo…" : "Demo memo: it is not saved."); return; }
  const w = { role: "assistant", mode, waiting: true }; th.messages.push(w); refresh(); focusThread(th);
  if (LIVE() && mode === "explain" && await liveAsk(th, w, text, v, intent)) return;
  const t0 = performance.now(); await wait(mode === "edit" ? 900 : 700);
  const r = sampleTurn(mode, th.anchor || v.anchor, text, th);
  Object.assign(w, r, { waiting: false, latency_s: mode === "edit" ? 6.4 : r.cant ? 2.1 : 4.8, reads: S.view, t0 });
  if (r.refusal) r.refusal.th = th.id;
  if (r.proposal) { S.pencil = { block: r.proposal.block, text: r.proposal.text, th: th.id }; }
  if (th.anchor && th.anchor.section_id && th.anchor.section_id !== S.sheet && r.proposal) { S.sheet = th.anchor.section_id; renderSheet(); }
  else if (r.proposal) renderSheet();
  refresh(); if (document.activeElement === document.body) focusThread(th);
  live(r.refusal ? "The report checks refused the draft." : r.proposal ? "Pencil draft ready." : "Athena answered.");
}
// the reader's own memos survive a reload in this browser only (demo states never read or write them)
const MEMO_KEY = "athena-v3-memos";
// app mode: memos live on the app server (kind "memo" overlays on this edition), never in this browser. Every refresh syncs
// the reader's memos in order: a new one is created, a changed one updated, a removed one deleted. A refused write keeps
// the memo on the page with the server's reason under it and is not sent again until it changes
const MEMO_SYNCED = new Map(); let SYNC = Promise.resolve();
// app mode while a Demo state shows: the reader's session (and their saved memos) was replaced, so nothing is sent; a memo the
// reader writes there says so on the page instead of looking saved. A reload returns to the report and its memos
const DEMO_NS = ": a Demo state is showing, so nothing is sent. Reload the page to return to your report and your saved memos.";
const demoNS = (th, what) => { if (!APP || S.persist || FAST) return false; th.saveErr = what + DEMO_NS; th.demoNS = true; return true; };
// other tabs on this edition: a tab that wrote memos tells the others, and a tab coming back into view asks the server again.
// The server's list wins: a memo deleted elsewhere leaves this page, one changed elsewhere takes the new words unless this tab
// holds unsent changes to it, one added elsewhere appears (a server-side conflict check is a production item)
const BC = APP && "BroadcastChannel" in window ? new BroadcastChannel("athena-memos-" + CFG.edition_id) : null;
const told = () => { try { BC && BC.postMessage("memos"); } catch (_) {} };
function reloadMemos() {
  if (!APP || !S.persist) return;
  const s0 = S; SYNC = SYNC.then(() => api("GET", CFG.overlays_url + "?kind=memo")).then(list => { if (S !== s0) return;
    const ids = new Set(list.map(o => o.id)); let ch = false;
    for (const [oid, { th }] of MEMO_SYNCED) if (!ids.has(oid)) { MEMO_SYNCED.delete(oid); if (S.threads.includes(th)) { S.threads = S.threads.filter(x => x !== th); S.panel = S.panel.filter(v => v.id !== th.id && v.thread !== th.id); ch = true; } }
    for (const o of list) { const k = MEMO_SYNCED.get(o.id), x = { anchor: memoAnchor(o.anchor), status: o.body.status || "open", messages: o.body.messages || [], live: o.body.live }, oj = JSON.stringify(memoOverlay(x));
      if (!k) { const th = { id: "t" + (++S.seq), kind: "note", ...x, user: true, oid: o.id }; S.threads.push(th); MEMO_SYNCED.set(o.id, { j: oj, th }); ch = true; }
      else if (k.j !== oj && JSON.stringify(memoOverlay(k.th)) === k.j) { k.th.status = x.status; k.th.messages = x.messages; k.j = oj; ch = true; } }
    if (ch && S.route === "desk") { const c = document.activeElement && document.activeElement.id === "cmp"; renderTabs(); renderPanel(); renderGutter(); paintAnchors(); if (S.conv) renderSheet(); if (c) focusCmp(true); }
  }, () => {});
}
if (BC) BC.onmessage = reloadMemos;
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadMemos(); });
const memoAnchor = a => !Object.keys(a).length ? null : a.exact ? { ...a, exact: plain(a.exact) } : a; // Ask stores a quote with its {fact:id} tokens
const memoOverlay = th => ({ anchor: th.anchor || {}, body: { status: th.status, messages: th.messages, ...(th.live ? { live: th.live } : {}) } }); // live: the server thread of an Ask on this memo; its turns are in these messages
async function syncMemos() {
  if (!S.persist) return; // a demo state replaced the reader's session: nothing of theirs is touched
  const cur = S.threads.filter(t => t.user && t.kind === "note"), was = cur.map(t => t.saveErr).join("|");
  for (const th of cur) {
    const o = memoOverlay(th), j = JSON.stringify(o), s = th.oid != null && MEMO_SYNCED.get(th.oid);
    if (j === th.failJ || s && s.j === j) continue;
    try {
      if (th.oid == null) { const r = await api("POST", CFG.overlays_url, { kind: "memo", ...o }); th.oid = r.id; live("Memo saved. Only you can see it."); }
      else await api("PATCH", `${CFG.overlays_url}/${th.oid}`, o);
      MEMO_SYNCED.set(th.oid, { j, th }); th.saveErr = th.failJ = null; told();
    } catch (e) { th.saveErr = (th.oid == null ? "Not saved: " : "Changes not saved: ") + (e.status === 413 ? "the memo is longer than the app server takes (64 KB per memo). Shorten it with Edit and it is saved again." : e.message);
      th.failJ = j; th.retry = e.status === undefined || e.status >= 500; live(th.saveErr); }
  }
  for (const [oid, { th }] of MEMO_SYNCED) if (!S.threads.includes(th)) {
    // 404: another tab deleted it already, which is what the reader asked for
    try { await api("DELETE", `${CFG.overlays_url}/${oid}`); MEMO_SYNCED.delete(oid); told(); }
    catch (e) { if (e.status === 404) { MEMO_SYNCED.delete(oid); continue; } th.saveErr = "Not deleted: " + e.message; S.threads.push(th); live(th.saveErr); renderGutter(); paintAnchors(); }
  }
  if (cur.map(t => t.saveErr).join("|") !== was || S.threads.some(t => t.saveErr && !cur.includes(t))) { renderTabs(); renderPanel(); if (S.conv) renderSheet(); }
}
function saveMemos() { if (APP) { if (S.persist) SYNC = SYNC.then(syncMemos, syncMemos); return; } if (!S.persist) return; try { localStorage.setItem(MEMO_KEY, JSON.stringify(S.threads.filter(t => t.user && t.kind === "note"))); } catch (_) {} }
// a question thread as the server keeps it (ask.py): an overlay with the element it was asked from and every turn. A turn's words
// and checks come back as they were shown; how long it took is not stored. Pending writes wait in the server's checkpoint, so
// their cards work as before, except one written before a later private Rev (aprHTML)
const askAnchor = a => { const f = F[a.fact], x = !f && a.block_id && blockOf(S.docs[1], a.block_id), s = f ? usersOf(a.fact).find(id => sheetIds().includes(id)) : x && x.b.text && x.s.id;
  // the server keeps the element, not the selected words: the thread shows the figure, or the opening words of the passage
  return s ? { ...a, section_id: s, exact: f ? `${f.label} ${f.period}: ${fmt(f, "kpi")}` : plain(x.b.text).slice(0, 80).replace(/\s+\S*$/, ""), prefix: "", suffix: "" } : null; };
const askGap = ms => { if ((ms.at(-1) || {}).role === "user") ms.push({ role: "assistant", mode: "explain", live: "error", err: "No answer was saved for this question. Ask it again.", notice: "", more: "", text: "", cites: [], problems: [], pending: [] }); };
function askThread(o) { const ms = [];
  for (const m of o.body.messages) {
    if (m.mode === "decisions") { const a = ms.findLast(x => (x.pending || []).length); if (a) a.pending.forEach(p => { p.d = m.decisions.find(d => d.id === p.id) || null; }); }
    else if (m.role === "user") { askGap(ms); ms.push({ role: "user", mode: "explain", text: m.text, created_at: now(new Date(m.created_at)) }); }
    else if (m.state !== "disabled") { const r = askTurn(m), later = [...REVS.values()].filter(at => at >= m.created_at).length;
      ms.push({ role: "assistant", mode: "explain", live: m.state ? r.state : "error", err: m.state ? "" : askErr({ code: m.code }), more: "", notice: r.notice, text: r.text, cites: r.cites, numbers: r.numbers, problems: r.problems, latency_s: null, pending: r.pending.map(p => ({ ...p, base: S.latest - later })) }); } }
  askGap(ms); return { id: "t" + (++S.seq), kind: "ai", anchor: askAnchor(o.anchor), status: o.body.status || "open", messages: ms, live: o.id }; }
// once per page: the hash changing again (same tab) or a demo state never adds the saved memos a second time
function loadMemos() { if (S.persist) return; S.persist = true;
  if (APP) { MEMO_SYNCED.clear(); REVS.clear(); const s0 = S; loadRevs(false).then(() => Promise.all(["memo", "thread"].map(k => api("GET", `${CFG.overlays_url}?kind=${k}`)))).then(async ([list, asks]) => { if (S !== s0) return;
    list.forEach(o => { const th = { id: "t" + (++S.seq), kind: "note", anchor: memoAnchor(o.anchor), status: o.body.status || "open", messages: o.body.messages || [], user: true, oid: o.id, live: o.body.live };
      S.threads.push(th); MEMO_SYNCED.set(o.id, { j: JSON.stringify(memoOverlay(th)), th }); });
    const held = new Set(S.threads.map(t => t.live)), ts = asks.filter(o => !held.has(o.id) && o.body.mode === "ask" && (o.body.messages || []).length).map(askThread);
    await catFor({ pending: ts.flatMap(t => t.messages.flatMap(m => m.pending || [])) }); if (S !== s0) return; // a request card names its filing and its Korean rule from the catalog
    S.threads.push(...ts);
    if (list.length || ts.length || S.latest > 1) S.route === "desk" ? (renderSheet(), refresh()) : render(); }, e => { APIERR = "Memos and questions could not be loaded: " + e.message; live(APIERR); S.route === "desk" ? refresh() : render(); }); return; }
  try { const a = JSON.parse(localStorage.getItem(MEMO_KEY) || "[]"); if (!Array.isArray(a)) return;
  a.filter(t => t && t.user && (!t.anchor || t.anchor.revision_id === "rev-1")).forEach(t => { t.id = "t" + (++S.seq); S.threads.push(t); }); } catch (_) {} }
function refresh() { saveMemos(); renderTabs(); renderPanel(); renderGutter(); paintAnchors(); convSync(); const sh = $("#sheet .shead"); if (sh) { sh.outerHTML = sheetHeadHTML(); padTop(); }
  const sj = $("#sideJob"); if (sj) sj.textContent = jobLine(); const mb = $(".mbar .who small"); if (mb) mb.innerHTML = mbarSmall(); }
// the phone's top bar; in app mode it carries the edition's status words, so they stay in sight while the sheet scrolls
const mbarSmall = () => APP ? `${S.view > 1 ? `Your Rev ${S.view} · private` : esc(cap1(edWords()))} · AI text` : `${FIL.form} · ${S.view > 1 ? `Your Rev ${S.view} · private` : "Shared R1"} · Sample · AI text`;
// the reader's next private revision, on top of the latest: a sample Apply and an approved live revision are drawn the same way
function inkRev(block, text, summary, newly) {
  const base = S.docs[S.latest], doc = clone(base), blk = blockOf(doc, block); if (!blk) return null; blk.b.text = text;
  const rev = S.latest + 1; S.docs[rev] = doc; S.latest = rev;
  const sec = blk.s, si = doc.sections.indexOf(sec), old = sectionFacts(secById(base, sec.id)), added = newly && !old.includes(newly) ? newly : textFacts(text).find(id => !old.includes(id));
  S.changed = { rev, sector: si, ring: added || null, summary, at: performance.now(), block };
  S.inks[rev] = { block, rev, dry: false }; S.pencil = null;
  return { rev, sec, block };
}
// app mode: a revision overlay is stored only after the reader approves it (ask_agent), so each one is a private Rev, in order.
// `show` (an approval just now) moves the reader to it; a page load stays on the shared edition, with the way back to their Rev
const REVS = new Map(); // overlay id -> when it was saved
const dryInk = () => setTimeout(() => { Object.values(S.inks).forEach(i => { i.dry = true; }); $$(".p-new").forEach(e => e.classList.add("dry")); }, FAST ? 0 : 60);
const loadRevs = show => { const s0 = S; return api("GET", CFG.overlays_url + "?kind=revision").then(list => { if (S !== s0) return;
  const last = list.filter(o => !REVS.has(o.id)).map(o => { REVS.set(o.id, o.created_at); return inkRev(o.body.block_id, o.body.text, o.body.summary); }).filter(Boolean).pop(); if (!last) return;
  if (!show) { S.changed.at = null; Object.values(S.inks).forEach(i => { i.dry = true; }); return; }
  S.view = last.rev; if (S.route !== "desk" || S.conv || S.sheet !== last.sec.id) goSheet(last.sec.id, { keepPanel: true }); else renderSheet();
  refresh(); follow($(`#content [data-block="${CSS.escape(last.block)}"]`)); dryInk(); live(`Saved as your private Rev ${last.rev}. The shared edition is unchanged.`); }); };
async function applyProposal(th) {
  const m = th.messages.find(x => x.proposal && x.proposal.status === "pending"); if (!m) return; const p = m.proposal;
  p.busy = true; refresh(); await wait(600); p.busy = false;
  const { rev, sec } = inkRev(p.block, p.text, p.summary, p.newly); S.view = rev; p.status = "applied"; p.rev = rev; p.at = now();
  S.threads.forEach(t => t.messages.forEach(x => { if (x.proposal && x.proposal !== p && x.proposal.status === "pending") x.proposal.status = "stale"; }));
  if (S.sheet !== sec.id) S.sheet = sec.id;
  renderSheet(); refresh(); live(`Applied as your private Rev ${rev}. The shared edition is unchanged.`);
  // the Apply button is gone: focus goes to the receipt that replaced it, the next thing to read (WAI-ARIA APG dialog pattern: a
  // logical element when the invoking one no longer exists)
  { const rc = $(`.receipt[data-receipt="${CSS.escape(th.id)}"]`); rc && rc.focus({ preventScroll: true }); }
  dryInk();
}

/* ---------- selection toolbar ---------- */
function showToolbar(anchor, rect) {
  const tb = $("#toolbar"); S.sel = { anchor, rect };
  tb.innerHTML = anchor.cross ? `<span class="why">Select within one paragraph to write a memo, ask or suggest an edit.</span>`
    : `<button class="ti" data-intent="note" aria-keyshortcuts="M"><b><span class="mk memo"></span>Memo</b><small>only you · no AI · M</small></button><button class="ti ask" data-intent="explain" aria-keyshortcuts="Meta+Enter"><b><span class="mk ai"></span>Ask</b><small>answer only · ⌘↵</small></button><button class="ti" data-intent="edit" ${S.view < S.latest ? "disabled" : ""} aria-keyshortcuts="Meta+Shift+Enter"><b><span class="mk edit"></span>Suggest edit</b><small>${S.view < S.latest ? "latest revision only" : "pencil draft · ⌘⇧↵"}</small></button>`;
  tb.hidden = false; positionToolbar();
}
function positionToolbar() {
  const tb = $("#toolbar"); if (tb.hidden || !S.sel) return;
  let r = S.sel.rect; const sel = getSelection(); if (sel.rangeCount && !sel.isCollapsed) r = sel.getRangeAt(0).getBoundingClientRect();
  const w = tb.offsetWidth, top = r.top - tb.offsetHeight - 10 < 8 ? r.bottom + 10 : r.top - tb.offsetHeight - 10;
  tb.style.top = top + "px"; tb.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + "px";
}
function hideToolbar() { $("#toolbar").hidden = true; S.sel = null; }
let selT = 0;
document.addEventListener("selectionchange", () => { clearTimeout(selT); selT = setTimeout(onSelection, 150); });
function onSelection() {
  if (!S || S.route !== "desk") return;
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) { if (!$("#toolbar").contains(document.activeElement)) hideToolbar(); return; }
  const r = sel.getRangeAt(0); if (!$("#content") || !$("#content").contains(r.commonAncestorContainer)) return;
  const a = anchorFromRange(r); if (!a) return hideToolbar();
  showToolbar(a, r.getBoundingClientRect());
}
function selectText(bid, exact) {
  const el = txtEl(bid); if (!el) return false; const t = anchorText(el), i = t.indexOf(exact); if (i < 0) return false;
  const r = rangeAt(el, i, i + exact.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  el.scrollIntoView({ block: "center" }); showToolbar(anchorFromRange(r), r.getBoundingClientRect()); return true;
}

/* ---------- reading slip ---------- */
function slipHTML(fid) {
  const f = F[fid], lv = leavesOf(fid), srcs = [...new Set(lv.map(l => F[l].source).filter(s => SRC[s]))];
  return `<div class="modal" data-act="closeslip-scrim"><div class="slip" role="dialog" aria-modal="true" aria-labelledby="slipT"><div class="t" id="slipT">Reading slip</div>
    <div class="who">${esc(FIL.issuer)} · ${FIL.form} · FY${FY} · Rev ${S.view}</div>
    <div class="win" style="margin-top:12px"><div class="big"><span>${esc(fmt(f, "kpi"))}</span><span class="pchip">${esc(f.period)}</span></div><div class="meta"><span>${esc(f.label)}</span><span>${esc(honesty(f))}</span></div>${vernierHTML(f)}</div>
    ${f.kind === "calculated" ? `<p class="hon" style="margin-top:10px">Calculated: ${esc(ftoks(f.formula).map(t => F[t] ? `${F[t].label} ${F[t].period}` : OPS[t] || t).join(" "))}</p>` : ""}
    ${srcs.map(sid => `<div class="qt">${markQuote(sid, lv.filter(l => F[l].source === sid))}</div><div class="loc">${esc(SRC[sid].locator)} · accession <span class="mono">${esc(FIL.accession)}</span></div>`).join("")}
    <div class="acts"><button class="btn" data-act="copyslip" data-fact="${esc(fid)}">Copy as text</button><button class="btn primary" data-act="closeslip">Close</button></div></div></div>`;
}
function slipText(fid) { const f = F[fid]; return `${FIL.issuer} ${FIL.form} FY${FY} · ${f.label} ${f.period}: ${fmt(f, "kpi")} (${honesty(f)})\n` + leavesOf(fid).map(l => SRC[F[l].source]).filter(Boolean).map(s => `“${s.quote}” · ${s.locator} · accession ${FIL.accession}`).filter((v, i, a) => a.indexOf(v) === i).join("\n"); }

/* ================= Developer, Settings, Markets ================= */
// the essay is long, so it reads on a page of its own, reached from the Developer page
const essayHTML = () => { const a = document.createElement("article"); a.innerHTML = $("#essay").innerHTML;
  const toc = $$("h2", a).map((h, i) => { h.id = "es-" + i; h.tabIndex = -1; return `<a href="#es-${i}" data-act="devanchor" data-id="es-${i}">${esc(h.textContent)}</a>`; }).join("");
  return `<div class="page-pad essay-page"><a class="btn text" href="#" data-go="developer">← Back to Developer</a><div class="essay"><div class="es-cols"><nav class="es-toc" aria-label="On this page"><b>On this page</b>${toc}</nav>${a.outerHTML}</div></div></div>`; };
function developerHTML() {
  // a spec table that stacks into labelled rows at phone width (explicit roles keep the table semantics when it does)
  const table = (cap, hs, rows) => `<table class="spec stack" role="table" aria-label="${cap}"><thead><tr role="row">${hs.map(h => `<th role="columnheader">${h}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(r => `<tr role="row">${r.map((c, i) => `<td role="cell" data-h="${hs[i]}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const anchors = [["dev-now", "Now"], ["dev-models", "Meta models"], ["dev-how", "How it works"], ["dev-adds", "What it adds"], ["dev-measured", "Measured"], ["dev-limits", "Limitations"], ["dev-private", "Private"], ["dev-essay", "Essay"], ["dev-changelog", "Changelog"]];
  const use = (t, d) => `<b class="ut">${t}</b>${d ? `<span class="muted">${d}</span>` : ""}`, mdl = (id, mode) => `<span class="mono">${id}</span> · ${mode}`;
  return `<div class="page-pad dev"><div class="caps muted">Developer · public build notes</div><h1 class="ph1" style="font-size:44px;line-height:52px;max-width:18ch">Financial reports that show their work.</h1>
    <p class="lead">Athena reads a public SEC filing, writes a long report from its figures, and lets you work on that report with an AI agent: private memos, questions in the margin, and suggested edits that become new revisions.</p>
    <div class="anchors">${anchors.map(([id, a]) => `<a class="chip" href="#${id}" data-act="devanchor" data-id="${id}">${a}</a>`).join("")}<button class="btn primary" data-go="desk">Open the sample report</button></div>
    <h2 id="dev-now" tabindex="-1">Now</h2><p style="max-width:64ch">This is a hackathon build. The reading app, the Ask agent and their checks are in this repository. The sample report comes from our private research engine. It is a retained draft: its financial review failed, so it stays marked review required and is not an accepted financial report.</p>
    <h2 id="dev-models" tabindex="-1">Meta models</h2><p style="max-width:64ch">Athena uses Meta's Muse models through the Meta Model API. Each use has its own model and mode, chosen by the server, not by the browser.</p>
    ${table("Meta models", ["Use", "Model and mode", "In this build"], [
      [use("Ask this report", "A reader's question about the opened edition, with approval before any action"), mdl("muse-spark-1.3", "Standard"), "Built. Off by default; it runs when the server operator adds their own Meta API key. Reader content never goes to Contributor."],
      [use("Public filing research", "Writing a report from approved public filing inputs"), mdl("muse-spark-1.3-contributor", "Contributor"), "Used by our private research engine for the sample report. Not in this repository."],
      [use("Report workspace, check and repair", "Work that involves reader or private context"), mdl("muse-spark-1.3", "Standard"), "Designed. Off until qualified."],
      [use("Advanced research (preview)"), mdl("muse-wonder-1.0", "Standard, preview"), "Designed. Not yet compared in Athena."]])}
    <ul class="devnotes"><li><b>Contributor:</b> Public research only. Inputs may be used by Meta to improve its models.</li><li><b>Standard:</b> For report work with reader or private context. Meta documents that Standard content is not used for model training.</li></ul>
    <h2 id="dev-how" tabindex="-1">How it works</h2>
    <svg class="arch" viewBox="0 0 900 150" role="img" aria-label="A filing goes through the agent workflow and code checks under the agent harness, into a specialized database, and out to the reader and Ask; a number travels from the filing quote to a fact, a check and the page">
      <text x="184" y="14" font-family="Manrope" font-size="12" fill="currentColor">Agent harness: model, tools and cost limit for each job</text><path d="M184 22H524" stroke="currentColor"/>
      ${["Filing", "Agent workflow", "Code checks", "Specialized database", "App and Ask Agent"].map((t, i) => `<g transform="translate(${i * 180 + 4} 30)"><rect width="160" height="56" fill="none" stroke="currentColor" stroke-width="1"/><text x="80" y="33" text-anchor="middle" font-family="Manrope" font-size="13" fill="currentColor">${t}</text>${i < 4 ? `<path d="M160 28h20" stroke="currentColor"/>` : ""}</g>`).join("")}
      <path d="M84 120 H 800" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 4" fill="none"/><text x="84" y="140" font-family="Athena Mono" font-size="12" fill="var(--accent)">a number's journey: filing quote → fact → check → page</text></svg>
    <p class="muted" style="font-size:12.5px;max-width:64ch">The agent workflow and its harness run in our private engine. The checks at ingest, the database, the reading app and Ask are in this repository.</p>
    <div class="method" style="margin-top:20px">${[["Agent workflow", "Muse Spark plans the analysis, researches with tools, and writes. One author writes the report; separate review steps read the draft."], ["Agent harness", "The harness sets each job's model, tools and cost limit. A failed code check refuses delivery, and nothing is stored in part. Review findings do not refuse a draft: it is stored with its findings, and while any are open it cannot be marked accepted or published. This sample is stored, held and marked review required."], ["Specialized database", "Each linked figure points to a fact record and its filing quote. Code, not a model, checks that the shown value appears in that quote. A number typed into the prose or a heading is not checked. Editions are stored once and never overwritten; an edit makes a new revision."], ["Ask is an agent with limits", "Built with LangChain create_agent. It answers from the opened edition, cites the passages it used, and asks you before it changes anything. Every amount and percentage in an answer is checked against the report text it cites before the answer shows \"Figures match the cited report\"."]].map(([t, p], i) => `<div><b>0${i + 1}</b><h3>${t}</h3><p>${p}</p></div>`).join("")}</div>
    <h2 id="dev-adds" tabindex="-1">What Athena adds to the model</h2><p style="max-width:64ch">Athena does not retrain Meta's models. It builds a workflow, code checks and a database around them, so the reader gets something they can check.</p>
    ${table("What Athena adds to the model", ["What", "A model call on its own", "With Athena"], [
      ["Figures", "Text the model wrote.", "Each linked figure opens the filing line it came from."],
      ["Checking", "Left to the reader.", "Code traces each linked figure to a record, each quote to the filing and each shown value to its quote. A failed check refuses delivery."],
      ["Repeat reads", "A new call can give a different answer.", "One stored edition. Every reader opens the same text."],
      ["Questions", "A chat answer stands alone.", "Ask cites the passages it used, checks its figures against them, and waits for approval before any change."]])}
    <h2 id="dev-measured" tabindex="-1">Measured</h2>
    ${table("Measured", ["Measure", "Result", "Basis"], [
      ["References in the sample report (app/fixtures/r14)", "125 fact records, 98 quoted and 27 calculated, tied to 84 filing sources with no broken reference.", "Code check at ingest. It proves references, not meaning: the same report failed financial review."],
      ["Ask on Muse Spark 1.3 (Standard), 24 scripted questions about the sample report", "21 answered, 2 declined (not answerable from this report), 1 waited for approval. In all 21 answers every amount and percentage matched the cited report figures; every citation pointed to a real passage.", "One run, 3 Nov 2026. The answers' wording was not independently reviewed."],
      ["Ask cost and speed (same run)", "$0.28 for 23 model calls; 91% of input tokens came from the prompt cache; median 6.7 s per answer, slowest 26.1 s.", "Provider-reported usage at Meta's published rates."],
      ["Ask on 24 unscripted questions about the sample report", "13 answered with every figure matched, 4 answered with a figure the check could not match, 7 declined. In our own read against the filing, we found no wrong figure in the 17 answers.", "One run, 4 Nov 2026. Our own check, not an independent review."]])}
    <p class="muted" style="font-size:12.5px;max-width:64ch">These are single development runs, not benchmarks or a matched comparison between models. Run logs and the unscripted questions are not in this repository.</p>
    <h2 id="dev-versions" tabindex="-1">Versions</h2>
    ${[["Sep–Oct 2026", "A multi-agent pipeline", ["Problem", "Writers, editors and reviewers handed work through long repair chains that often stopped before publication."], "The chain, not the writing, was the bottleneck.", "Research"],
      ["Oct 2026", "One author, parallel checkers", ["Change", "One author writes the whole report from collected facts; separate checkers review it."], "", "Research"],
      ["Nov 2026", "App v3 and Ask", ["Change", "A reader app with a Probe for linked figures, revisions, and an Ask agent."], "", "Built"],
      ["Nov 2026", "Code checks before review", ["Change", "Code checks now raise findings on a finished draft, so acceptance does not rest on a model review alone."], "", "Research"]].map(([d, t, [k, p], o, e]) => `<div class="ver"><span class="d">${d}</span><div class="vt">${esc(t)}</div><div><b>${k}</b>${esc(p)}</div><div>${o ? `<b>Outcome</b>${esc(o)} ` : ""}<span class="tag">${e}</span></div></div>`).join("")}
    <h2 id="dev-limits" tabindex="-1">Limitations</h2>
    <ul class="devnotes"><li><b>The sample report is a draft.</b> It is an assisted revision, its financial review failed, and it has open findings. It is not investment advice.</li><li><b>Checks prove references, not meaning.</b> A figure can trace to its quote and still sit in a wrong sentence.</li><li><b>Ask answers from the report.</b> If the report does not cover something, Ask declines, even when the filing has it.</li><li><b>English only for now.</b> Korean, German, Japanese, French, Chinese and Spanish are planned.</li><li><b>No post-trained model.</b> We work with post-training methods such as SFT and RL, but the resources available for this hackathon did not cover them, so this build has no post-trained model and no results from one. That work continues as internal research.</li></ul>
    <h2 id="dev-private" tabindex="-1">What stays private</h2><p class="muted" style="max-width:64ch">The report-writing engine, its prompts and methods, its evaluation sets and scoring rules, routing and raw traces stay private. The 24 scripted Ask questions are in eval/; the runner that scores them is app/athena_app/ask_eval.py. This repository contains the reading app, the Ask agent, the checks they use, and one retained sample report from the private engine.</p>
    <h2 id="dev-essay" tabindex="-1">Essay</h2><p style="max-width:64ch">When intelligence becomes a service: Athena and the effort to make expert work accessible.</p>
    <a class="btn" href="#" data-go="essay">Read the essay</a>
    <h2 id="dev-changelog" tabindex="-1">Changelog</h2>
    ${[["4 Nov 2026", "No-key mode", "Without a Meta API key, suggested questions show pre-written samples, and a typed question explains how to add a key."], ["4 Nov 2026", "Answer check", "The number check now skips dates and form names, which are not figures, and still flags amounts it cannot match."], ["4 Nov 2026", "Approved revisions", "An approved Ask edit opens as a private revision on the page."], ["4 Nov 2026", "Later tags", "Planned languages, other filings and Markets are marked \"later\" in the app."], ["3 Nov 2026", "Ask this report", "Reader questions with citations, a number check, and approval before any change."], ["2 Nov 2026", "Report jobs", "A jobs API with a local fake runner, so a new report can be tried without a model."], ["31 Oct 2026", "App v3 prototype", "Binder with index tabs, scale rail and Probe; rosette for writing and Summary."]].map(([d, t, p]) => `<div class="ver"><span class="d">${d}</span><div style="grid-column:span 2"><b>${t}</b>${esc(p)}</div><div><span class="tag">Built</span></div></div>`).join("")}
    <p class="muted" style="font-size:12px;margin-top:16px">Built: working in this repository · Designed: not built or not enabled yet · Research: from our private research runs. Updated 4 Nov 2026.</p>
    <p class="muted" style="font-size:12px">Before the hackathon: a private draft of the report engine (late September 2026), in research and testing, developed on Meta's Muse models during the hackathon, and reading-desk mockups (20 Oct 2026). This app started from the mockups' ideas, such as memos, Ask, suggested edits and the Probe, and reuses some of their code.</p></div>`;
}
function settingsHTML() {
  // the other languages are disabled with the later tag, never pressed; English stays chosen and
  // the later sentence always shows under the control
  const th = S.theme || "system";
  return `<div class="page-pad" style="max-width:820px"><h1 class="ph1">Settings</h1><p class="lead">These apply on this device.</p>
    <div class="setrow"><div><h3>Language</h3><p>Interface and new reports. Each report keeps the language it was written in.</p></div><div class="opts" role="group" aria-label="Language"><button data-act="lang" data-v="en" aria-pressed="true">English</button>${laterLangs('data-act="lang"')}</div></div>
    <p class="muted" style="font-size:12.5px">Other languages arrive in a later version. The interface and reports are in English for now.</p>
    <div class="setrow"><div><h3>Theme</h3><p>System follows your device.</p></div><div class="seg" role="group" aria-label="Theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => `<button data-act="theme" data-v="${k}" aria-pressed="${th === k}">${l}</button>`).join("")}</div></div>
    <div class="setrow"><div><h3>When a report is ready</h3><p>A report takes 10+ minutes. Athena can tell you when it is done.</p></div><label class="switch"><input type="checkbox" disabled> Notify me when a report is ready<span class="later">later</span></label></div>
    <div class="setrow"><div><h3>Ask model</h3><p>Reader questions use Standard mode only. Ask runs only when the server operator has added a key.</p></div><div class="setval">Muse Spark 1.3 · Standard</div></div></div>`;
}
const marketsHTML = () => `<div class="page-pad" style="max-width:820px"><div class="caps muted">Markets · later</div><h1 class="ph1">Markets</h1><p class="lead">The policy calendar and market context arrive in a later version. Athena's reports stay built from filings; nothing here fetches prices today.</p><div class="placeholder"><b>Later</b>The Fed calendar and market context will appear here.</div></div>`;

/* ================= layer (modals) ================= */
// a dialog remembers the control that opened it; Esc, Cancel or the scrim give focus back to it, with a ring (APG modal dialog)
let LAYER_FROM = null;
function renderLayer(back) {
  const L = $("#layer"), had = !!$(".mbox, .slip", L), ae = document.activeElement;
  if (!had && ae && ae !== document.body && !L.contains(ae)) LAYER_FROM = { el: ae, sel: ae.dataset && ae.dataset.act ? `[data-act="${ae.dataset.act}"]${ae.dataset.i ? `[data-i="${ae.dataset.i}"]` : ""}` : null };
  const lv = S.newOpen && S.newLive;
  L.innerHTML = lv ? liveNewHTML() : S.newOpen ? newHTML() : S.index ? indexHTML() : S.slip ? slipHTML(S.slip) : "";
  if (S.newOpen && !lv) bindNew();
  const box = $(".mbox, .slip", L); if (box) { const f = lv && ljFocusEl() || $("button.primary:not([disabled]), input, button", box); f && f.focus({ preventScroll: true }); return; }
  const o = LAYER_FROM; LAYER_FROM = null; if (!had || !back || !o) return;
  const b = o.el.isConnected && o.el.getClientRects().length ? o.el : o.sel && $$(o.sel).find(e => e.getClientRects().length); b && b.focus({ preventScroll: true, focusVisible: true });
}
function bindNew() {
  const inp = $("#nrCo"), sug = $("#nrSug");
  inp.addEventListener("input", () => { const q = inp.value.trim().toLowerCase(); const hits = COMPANIES.filter(c => (c[0] + " " + c[1]).toLowerCase().includes(q)); sug.hidden = !q || !hits.length; sug.innerHTML = hits.map(c => `<button data-act="pickco" data-v="${c[0]}"><b>${c[0]}</b>${esc(c[1])}</button>`).join("");
    S.newForm.co = inp.value; $("#nrVerdict").innerHTML = verdictHTML(); }); // typed text is looked up as typed, never replaced by a suggestion
}

/* ================= navigation ================= */
function goRoute(r) {
  if (r === "desk" && JOB.state !== "ready") r = "writing";
  setRoute(r); S.newOpen = false; S.index = false; S.slip = null; hideToolbar();
  render(); scrollTo(0, 0); $("#main").focus({ preventScroll: true });
}
function goSheet(id, opts = {}) {
  setRoute("desk");
  S.sheet = id; S.conv = false; S.index = false; hideToolbar();
  if (!opts.keepPanel) S.panel = S.panel.filter(v => v.t !== "probe");
  if (!$("#sheet")) render(); else { renderSheet(); renderTabs(); renderPanel(); renderLayer(); }
  scrollTo(0, 0);
}
// after a sheet change the keyboard keeps its place, on the tab that chose the sheet (redrawn) or else on the new
// sheet's heading, and the change is announced politely
function sheetMoved(bar) {
  const t = bar && $(`#${bar.id} [data-sheet="${CSS.escape(S.sheet)}"]`), h = !t && $("#content h1");
  if (h) h.tabIndex = -1;
  (t || h || $("#main")).focus({ preventScroll: true }); live(sheetTitle(S.sheet));
}
function gotoThread(th) {
  if (th.anchor && th.anchor.section_id) { if (S.route !== "desk" || S.sheet !== th.anchor.section_id || S.conv) goSheet(th.anchor.section_id, { keepPanel: true }); }
  else if (S.route !== "desk") { setRoute("desk"); render(); }
  S.unfold = null; if (onSheetA(th.anchor)) S.tray = false; else if (!isPhone() && !(th.anchor && th.anchor.section_id)) S.tray = true;
  pushView({ t: "thread", id: th.id }, true);
  const a = anchorState(th), el = a.range ? a.range.startContainer.parentElement : th.anchor && th.anchor.block_id && blockEl(th.anchor.block_id);
  if (el) { const r = el.getBoundingClientRect(), B = band(); if (r.top < B.top + 8 || r.bottom > B.bot - 8) el.scrollIntoView({ block: "center" }); }
  renderPanel(); renderGutter();
}

/* ================= events ================= */
document.addEventListener("click", e => {
  const t = e.target;
  if (LMX && !t.closest("#lane > .lmlist, #lane > .lmark")) { LMX = null; layLane(); }
  const go = t.closest("[data-go]"); if (go) { e.preventDefault(); const r = go.dataset.go; if (r === "writing") S.liveJob = null; if (r === "desk") { if (JOB.state !== "ready") return goRoute("writing"); return goSheet(S.sheet || "summary"); } return goRoute(r); }
  const sh = t.closest("[data-sheet]:not([data-act])"); if (sh) { e.preventDefault(); const bar = sh.closest("#idx, #strip"); goSheet(sh.dataset.sheet); return sheetMoved(bar); }
  const fig = t.closest(".fig"); if (fig && fig.closest("#content")) { e.preventDefault(); return openProbe(fig.dataset.fact, fig); }
  if (fig && fig.closest("#wpanel, #layer, #lane, #tray")) { e.preventDefault(); S.slip = null; renderLayer(); return citeProbe(fig.dataset.fact); }
  if (fig && fig.closest("#main")) { e.preventDefault(); return; }
  const rk = t.closest(".rk"); if (rk) { const el = $$("#content .fig")[+rk.dataset.ri]; if (el) { el.scrollIntoView({ block: "center", behavior: RM.matches || FAST ? "auto" : "smooth" }); openProbe(el.dataset.fact, el); { const v = activeProbe(); if (v) v.rk = +rk.dataset.ri; } setTimeout(() => { const b = $(`.rk[data-ri="${rk.dataset.ri}"]`); b && b.focus({ preventScroll: true }); }, 0); } return; }
  const step = t.closest("[data-step]"); if (step) { const v = activeProbe(); v.stack.push(step.dataset.step); renderPanel(); $("#travel").focus({ preventScroll: true }); live("Stepped into " + F[step.dataset.step].label); return; }
  const crumb = t.closest("[data-crumb]"); if (crumb) { const v = activeProbe(); v.stack = v.stack.slice(0, +crumb.dataset.crumb + 1); renderPanel(); return; }
  const det = t.closest("#wpanel [data-det], .bal.probe [data-det]"); if (det && !det.dataset.act) return setDet(+det.dataset.det);
  const trv = t.closest("#travel"); if (trv) { const r = trv.getBoundingClientRect(); return setDet(Math.round(clamp((e.clientX - r.left) / r.width) * 3)); }
  const ti = t.closest("#toolbar [data-intent]"); if (ti) { const a = S.sel && S.sel.anchor; if (a && !a.cross) startIntent(ti.dataset.intent, a); return; }
  const sp = t.closest("#sumHit path"); if (sp) return goSheet(roseModel(docV())[+sp.dataset.si].s.id);
  const act = t.closest("[data-act]"); if (!act) { if (!t.closest("#toolbar") && $("#toolbar").hidden === false && getSelection().isCollapsed) hideToolbar(); if (!t.closest("#demo, #demoBtn")) closeDemo(); return; }
  const A = act.dataset.act, th = act.dataset.th && threadById(act.dataset.th);
  if (act.tagName === "FORM") return;
  if (A !== "theme" && A !== "ljopen") e.preventDefault();
  switch (A) {
    // app mode: New report starts a live run on the server's catalog; the static prototype keeps its demo sheet
    case "new": case "newreport": S.newForm = { co: "", form: "10-K", fy: "FY" + FY, lang: "en" }; S.newOpen = true; S.newLive = APP; if (APP) ljOpenForm(); renderLayer(); break;
    case "newfor": { const c = CAT()[+act.dataset.i]; S.newForm = { co: c.tk, form: c.form, fy: c.fy, lang: c.lang }; S.newOpen = true; S.newLive = false; renderLayer(); } break;
    case "ljcat": loadCat(); break;
    case "ljpick": if (LJ.form.filing_id !== act.dataset.v) { LJ.form.filing_id = act.dataset.v; LJ.form.crid = rid(); } LJ.form.err = ""; ljPaint(); { const b = $(`[data-act="ljpick"][data-v="${CSS.escape(act.dataset.v)}"]`); b && b.focus({ preventScroll: true }); } break;
    case "ljstart": startRun(); break;
    case "ljgo": openRun(act.dataset.j); break;
    case "ljopen": seeRun(act.dataset.j); break;
    case "runs": { const u = unseenRuns(); openRun((u.length ? u[u.length - 1] : LJ.runs[LJ.runs.length - 1] || {}).id); } break;
    case "notifyme": askNotify(); break;
    case "toastx": { const id = LJ.toast && LJ.toast.id; seeRun(id); live("Notice dismissed."); $("#main").focus({ preventScroll: true }); } break;
    case "closenew": S.newOpen = false; renderLayer(true); break;
    case "closenew-scrim": if (t === act) { S.newOpen = false; renderLayer(true); } break;
    case "nf": S.newForm[act.dataset.k] = act.dataset.v; if (!PERIODS[S.newForm.form].includes(S.newForm.fy)) S.newForm.fy = PERIODS[S.newForm.form][0]; renderLayer(); break;
    case "pickco": S.newForm.co = act.dataset.v; renderLayer(); break;
    case "startjob": S.newOpen = false; S.liveJob = null; setJob(0, "running"); S.docs = { 1: clone(DOC) }; S.latest = S.view = 1; S.changed = null; S.inks = {}; S.threads = []; S.panel = []; S.persist = false; loadMemos(); goRoute("writing"); break;
    case "stop": JOB.confirmStop = true; $("#wrHead").innerHTML = wrHeadHTML(); $("[data-act=stopno]").focus(); break;
    case "stopno": JOB.confirmStop = false; $("#wrHead").innerHTML = wrHeadHTML(); break;
    case "stopyes": JOB.state = "stopped"; JOB.confirmStop = false; render(); live("Writing stopped. The work so far is kept."); break;
    case "resume": JOB.state = "running"; JOB.last = performance.now(); JOB.seen = prog(); S.liveJob = null; goRoute("writing"); break;
    case "opensummary": S.focusSector = null; goSheet("summary"); break;
    case "opennow": S.newOpen = false; S.focusSector = null; goSheet("summary"); renderLayer(); live("Opened the shared edition"); break;
    case "homeask": homeAsk($("#homeAsk").value); break;
    case "homechip": homeAsk(HOME_CHIPS[+act.dataset.i].q, HOME_CHIPS[+act.dataset.i].kind); break;
    case "trysample": { const m0 = th.messages[0]; pushView({ t: "compose", intent: m0.mode === "note" ? "explain" : m0.mode, anchor: th.anchor, thread: th.id, text: act.dataset.q }); renderPanel(); send(topView(), act.dataset.q); } break;
    case "trycompose": { const v = topView(); send(v, act.dataset.q); } break;
    case "libf": S.libFilter = act.dataset.v; render(); break;
    case "conv": { const v = act.dataset.v ? act.dataset.v === "1" : !S.conv; if (v && !S.conv) RY[S.sheet] = scrollY; S.conv = v; hideToolbar(); renderSheet(); renderTabs(); renderPanel(); scrollTo(0, S.conv ? 0 : RY[S.sheet] || 0);
      // focus stays on the view switch (the pressed side, redrawn) and the change is announced
      const f = act.closest(".seg") ? $(`.shead .seg [data-act="conv"][data-v="${S.conv ? 1 : 0}"]`) : act.closest(".mbar") && $(".mbar [data-act=conv]"); if (f) f.focus({ preventScroll: true }); live(S.conv ? "Conversation view" : "Report view"); } break;
    case "convf": S.convFilter = act.dataset.v; renderSheet(); { const c = $(`.conv .chip[data-v="${CSS.escape(act.dataset.v)}"]`); c && c.focus({ preventScroll: true }); } break;
    case "rev": S.view = +act.dataset.v; S.pencil = S.view < S.latest ? null : S.pencil; renderSheet(); refresh(); live(`Reading Rev ${S.view}`); break;
    case "index": S.index = true; renderLayer(); break;
    case "closeindex": S.index = false; renderLayer(true); break;
    case "closeindex-scrim": if (t === act) { S.index = false; renderLayer(true); } break;
    case "src": case "openref": S.litSrc = act.dataset.src; goSheet("references", { keepPanel: true }); { const li = $("#ref-" + CSS.escape(act.dataset.src)); li && (li.scrollIntoView({ block: "center" }), li.focus({ preventScroll: true })); } break;
    case "gofig": { const f = act.dataset.fact; goSheet(act.dataset.sheet, { keepPanel: false }); const el = $(`#content .fig[data-fact="${CSS.escape(f)}"]`); if (el) { el.scrollIntoView({ block: "center" }); openProbe(f, el); } } break;
    case "probefact": { const f = act.dataset.fact, on = $(`#content .fig[data-fact="${CSS.escape(f)}"]`); openProbe(f, on || null, +(act.dataset.det || 0)); } break;
    case "tray": openTray(); break;
    case "trayclose": foldTray(); break;
    case "traymin": foldTray(true); break;
    case "cmore": { const m = threadById(act.dataset.th).messages[+act.dataset.i], on = !CITES_OPEN.has(m); CITES_OPEN[on ? "add" : "delete"](m); act.setAttribute("aria-expanded", on); act.nextElementSibling.hidden = !on; if (on) act.nextElementSibling.scrollIntoView({ block: "nearest" }); } break;
    case "trayq": trayAsk(act.dataset.q); break;
    case "unfold": if (S.tray) { S.tray = false; S.panel = S.panel.filter(v => !inTray(v)); } S.unfold = act.dataset.th; renderPanel(); { const b = $(`#lane [data-k="th:${CSS.escape(act.dataset.th)}"]`); b && b.focus({ preventScroll: true }); } break;
    case "laneback": { const k = act.dataset.k; S.tray = false; S.panel = S.panel.filter(v => !inTray(v)); renderPanel(); const b = $(`#lane .bal[data-k="${CSS.escape(k)}"]`); b && b.focus({ preventScroll: true }); } break;
    case "balclose": { const k = act.dataset.k, pv = [...S.panel].reverse().find(v => v.t === "probe"), tv = topView();
      S.panel = k === "probe" ? S.panel.filter(v => v.t !== "probe" && !v.host) : S.panel.filter(v => !(v.t === "thread" && "th:" + v.id === k) && !(v.t === "compose" && "th:" + v.thread === k)); renderPanel();
      focusBack(k === "probe" ? pv : null, tv); } break;
    case "seethrough": if (S.st) endST(true); else { const pv = [...S.panel].reverse().find(v => v.t === "probe"), blk = pv && pv.block && blockEl(pv.block); if (blk) {
      // the probed row or figure is the active one; the page moves only if the block is cut by the sheet header or the chat bar
      const el = pv.el != null && $$("#content .fig")[pv.el], rows = stRows(blk), i = Math.max(0, rows.findIndex(r => r === el || r.contains(el)));
      startST(pv.block, false, i); if (isPhone()) { renderPanel(); blk.scrollIntoView({ block: "start" }); }
      // the button that started it hides with the Probe: focus goes to the panel's heading (the phone: its Done), and ↑ ↓
      // still step
      if (S.st) { const t = $(isPhone() ? '#stbar [data-act="stdone"]' : ".under.mg:not(.ghost) .sth"); t && t.focus({ preventScroll: true }); } } } break;
    case "stprev": stMove(-1); break;
    case "stnext": stMove(1); break;
    case "stdone": endST(true); break;
    case "pback": S.panel.pop(); renderPanel(); break;
    case "pclose": S.panel = []; renderPanel(); break;
    case "panelsize": S.panelFull = !S.panelFull; renderPanel(); break;
    case "intent": { const v = activeProbe(), fid = v.stack[v.stack.length - 1]; startIntent(act.dataset.intent, { revision_id: "rev-" + S.view, section_id: v.section || (S.route === "desk" && !S.conv ? S.sheet : null), block_id: v.block, exact: `${F[fid].label} ${F[fid].period}: ${fmt(F[fid], "kpi")}`, fact: fid, fig: v.stack[0] }); } break;
    case "slip": S.slip = activeProbe().stack.slice(-1)[0]; renderLayer(); break;
    // live answers: the Probe's quick actions, citation chips and the decisions on proposed writes
    case "explainfig": { const v = activeProbe(), fid = v.stack[v.stack.length - 1], f = F[fid], q = `Explain this number: ${f.label}, ${f.period}, ${fmt(f, "kpi")}.`; hideToolbar();
      pushView({ t: "compose", intent: "explain", anchor: { revision_id: "rev-" + S.view, section_id: v.section || (S.route === "desk" && !S.conv ? S.sheet : null), block_id: v.block, exact: `${f.label} ${f.period}: ${fmt(f, "kpi")}`, fact: fid, fig: v.stack[0] }, host: "probe", text: q });
      renderPanel(); send(topView(), q, "explain_figure"); } break;
    case "showsrc": setDet(3); break;
    case "cite": citeGo({ id: act.dataset.id, kind: act.dataset.kind, section_id: act.dataset.sec }); break;
    case "apr": { const i = +act.dataset.i, j = +act.dataset.j, p = th.messages[i].pending[j];
      if (act.dataset.d !== "edit") { aprDecide(th, i, j, act.dataset.d); break; }
      p.editing = true; refresh(); aprFocus(`[data-apr="${th.id}-${i}-${j}"] textarea`); } break;
    case "aprcancel": { const i = +act.dataset.i, j = +act.dataset.j; th.messages[i].pending[j].editing = false; refresh(); aprFocus(`[data-apr="${th.id}-${i}-${j}"] [data-d="edit"]`); } break;
    case "closeslip": S.slip = null; renderLayer(true); break;
    case "closeslip-scrim": if (t === act) { S.slip = null; renderLayer(true); } break;
    case "copyslip": try { navigator.clipboard.writeText(slipText(act.dataset.fact)).then(() => live("Copied"), () => live("Copy is not available here")); } catch (_) { live("Copy is not available here"); } act.textContent = "Copied as text"; break;
    case "lmx": LMX = LMX === act.dataset.ths ? null : act.dataset.ths; layLane(); { const f = LMX && $("#lane > .lmlist button"), b = !LMX && $$("#lane > .lmark").find(x => x.dataset.ths === act.dataset.ths); (f || b) && (f || b).focus({ preventScroll: true }); } break;
    case "openthread": { LMX = null; if (act.closest(".conv.two")) { convSelect(th.id); break; }
      // WAI-ARIA APG menu button: an item chosen from a lane marker's list, or a lone marker, puts focus on the thread it
      // opened (the marker or list is redrawn, so focus would drop to the page); Esc then returns it to the marker
      const lm = !!act.closest("#lane > .lmlist, #lane > .lmark");
      if (act.closest("#guide")) GK = act.dataset.gk; gotoThread(th); if (act.closest("#guide") || lm) focusThread(th); MRET = lm ? th.id : null; } break;
    case "gall": { S.gx = S.gx === S.sheet ? null : S.sheet; const o = S.gx === S.sheet, g = $("#gall"), c = $(".chev", act); act.setAttribute("aria-expanded", String(o)); if (g) g.hidden = !o; if (c) c.textContent = o ? "▾" : "▸";
      GK = "x"; $$("#guide .gr").forEach(b => b.tabIndex = b === act ? 0 : -1); act.focus({ preventScroll: true }); } break;
    case "gfig": { GK = act.dataset.gk; const el = $(`#content .fig[data-fact="${CSS.escape(act.dataset.f)}"]`); if (el) { openProbe(el.dataset.fact, el); el.focus({ preventScroll: true }); } } break;
    case "gothread": gotoThread(th); focusThread(th); break;
    // a sample suggest-edit somewhere else in the report: go there and open the composer on it; the reader's work stays as it is
    case "trysuggest": { const x = act.dataset.v === "refused" ? EDIT_REFUSE() : EDIT_OK(); if (!x) break; if (S.view < S.latest) { S.view = S.latest; live(`Reading Rev ${S.view}`); }
      // words the reader typed in this composer go with them to the sample's spot instead of the sample request
      const o = topView(), mine = o && o.t === "compose" && (o.text || "").trim() ? o.text : ""; if (mine) S.panel = S.panel.filter(v => v !== o);
      goSheet(x.s.id); const el = txtEl(x.b.id); el && el.scrollIntoView({ block: "center" }); const tx = el ? anchorText(el) : "";
      startIntent("edit", { revision_id: "rev-" + S.view, section_id: x.s.id, block_id: x.b.id, exact: tx.slice(0, 80).replace(/\s+\S*$/, ""), prefix: "", suffix: "" });
      if (mine) { const v = topView(), c = $("#cmp"); if (v && v.t === "compose") { v.text = mine; if (c) { c.value = mine; focusCmp(true); } } live("Your words are kept in the composer."); } } break;
    case "seeold": S.view = +th.anchor.revision_id.slice(4); renderSheet(); refresh(); gotoThread(th); break;
    case "reply": startIntent("explain", null, th.id); break;
    case "resolve": th.status = "resolved"; refresh(); break;
    case "reopen": th.status = "open"; refresh(); break;
    case "memoedit": pushView({ t: "compose", intent: "note", anchor: th.anchor, thread: th.id, text: th.messages[+act.dataset.i].text, memoEdit: +act.dataset.i }); renderPanel(); focusCmp(true); break;
    // the redrawn confirm keeps focus, on Keep (the safe choice); Keep returns it to the memo's Delete button
    case "memodel": S.memoDel = th.id + ":" + act.dataset.i; renderPanel(); { const k = $$('[data-act="memodelno"]').find(b => b.offsetParent); k && k.focus({ preventScroll: true }); } break;
    case "memodelno": { const [tid, i] = (S.memoDel || "").split(":"); S.memoDel = null; renderPanel(); const d = $$(`[data-act="memodel"][data-th="${CSS.escape(tid || "")}"][data-i="${CSS.escape(i || "")}"]`).find(b => b.offsetParent); d && d.focus({ preventScroll: true }); } break;
    case "memodelyes": { S.memoDel = null; S.threads = S.threads.filter(x => x !== th); S.panel = S.panel.filter(v => v.id !== th.id); refresh(); renderGutter(); live("Memo deleted");
      // the balloon and its buttons are gone: focus goes to the passage or figure the memo was on (the tray's composer for a
      // report-level memo), as Esc does
      const ti = !th.anchor && $("#trayIn"); if (ti) ti.focus({ preventScroll: true }); else focusBack(null, { t: "compose", anchor: th.anchor }); } break;
    case "memoretry": th.failJ = null; live("Saving the memo…"); saveMemos(); SYNC.then(() => { const a = document.activeElement; if (!a || a === document.body) focusThread(th); }); break;
    case "apply": applyProposal(th); break;
    case "discard": { const m = th.messages.find(x => x.proposal && x.proposal.status === "pending"); if (m) m.proposal.status = "discarded"; S.pencil = null; renderSheet(); refresh(); focusThread(th); live("Draft discarded. The report has no trace of it."); } break;
    case "redo": pushView({ t: "compose", intent: "edit", anchor: th.anchor, thread: th.id, text: "Register FY2024 revenue from its filing tag and add it to this sentence." }); renderPanel(); focusCmp(); break;
    case "keepmemo": { const m = th.messages[+act.dataset.i]; const nt = { id: "t" + (++S.seq), kind: "note", anchor: null, status: "open", messages: [{ role: "user", mode: "note", text: "Kept from Athena: " + plain(m.text), fromSample: true, created_at: now() }], user: true }; S.threads.push(nt); const ns = demoNS(nt, "Not saved"); pushView({ t: "thread", id: nt.id }); S.tray = !isPhone(); refresh(); focusThread(nt); live(ns ? nt.saveErr : "Kept as a private memo."); } break;
    case "toedit": { const m = th.messages[+act.dataset.i], b = blockOf(docV(), m.convert.block); goSheet(b.s.id, { keepPanel: true }); const el = txtEl(b.b.id); el && el.scrollIntoView({ block: "center" });
      const tx = el ? anchorText(el) : ""; startIntent("edit", { revision_id: "rev-" + S.view, section_id: b.s.id, block_id: b.b.id, exact: tx.slice(0, 80).replace(/\s+\S*$/, ""), prefix: "", suffix: "" }); const c = $("#cmp"); if (c) { c.value = topView().text = m.convert.req; focusCmp(); } } break;
    case "lang": S.lang = act.dataset.v; render(); break;
    case "compare": S.compare = !S.compare; renderSheet(); live(S.compare ? `Showing Rev ${S.view - 1} words struck through` : "Comparison hidden"); break;
    case "theme": setTheme(act.dataset.v); render(); break;
    case "devanchor": { const el = $("#" + act.dataset.id); el && (el.scrollIntoView(), el.focus({ preventScroll: true })); } break;
    case "demo": runDemo(act.dataset.v); break;
  }
});
document.addEventListener("submit", e => {
  e.preventDefault(); const f = e.target;
  if (f.dataset.act === "send") return send(topView(), $("#cmp").value);
  if (f.id === "ljForm") return startRun();
  if (f.dataset.act === "aprsave") { const th = threadById(f.dataset.th), i = +f.dataset.i, j = +f.dataset.j, p = th.messages[i].pending[j];
    return aprDecide(th, i, j, "edit", { ...p.args, ...Object.fromEntries($$("textarea[data-f]", f).map(x => [x.dataset.f, x.value])) }); }
  if (f.dataset.act === "trayask") { const i = $("#trayIn"), q = i.value.trim(); if (!q) { i.focus({ preventScroll: true }); return; } return trayAsk(q); }
});
document.addEventListener("input", e => {
  if (e.target.id === "cmp") { const v = topView(); if (v && v.t === "compose") v.text = e.target.value; }
  if (e.target.id === "ljCode" && LJ.form) { LJ.form.code = e.target.value; if (LJ.form.bad) { LJ.form.bad = false; e.target.removeAttribute("aria-invalid"); } }
  if (e.target.id === "libQ") { S.libQ = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#libQ"); q.focus(); q.setSelectionRange(pos, pos); }
  if (e.target.dataset.lab) { S.price = e.target.value; const blk = blockOf(docV(), e.target.closest("[data-block]").dataset.block).b; $("#labOut-" + CSS.escape(blk.id)).innerHTML = labOutHTML(blk); $("#labAsk").textContent = labAsk(ASM[e.target.dataset.lab]); e.target.setAttribute("aria-invalid", String(!priceIn().ok && !priceIn().empty)); }
});
// a prefilled sample stays one piece until the reader changes it: a click into it selects it all, and words typed or pasted
// over it replace it, never join it
const cmpSample = c => { const v = c && c.id === "cmp" && topView(); return !!(v && v.t === "compose" && v.sample && c.value === v.sample); };
document.addEventListener("click", e => { if (cmpSample(e.target)) e.target.select(); });
// a question at the 4,000-character limit says so in words, shown and announced (maxlength alone cuts a longer paste silently)
document.addEventListener("input", e => { if (e.target.id === "trayIn") S.trayDraft = e.target.value; });
document.addEventListener("input", e => { const t = e.target; if (!(t.id === "trayIn" || t.id === "cmp") || !(t.maxLength > 0)) return;
  const at = t.value.length >= t.maxLength, n = $("#" + t.id + "Max");
  if (at && !n) { const p = document.createElement("p"); p.className = "maxn"; p.id = t.id + "Max"; p.textContent = `This question has reached the limit of ${t.maxLength.toLocaleString("en-US")} characters. Text past the limit is not added.`;
    (t.parentElement.matches(".trayform") ? t.parentElement : t).after(p); t.setAttribute("aria-describedby", p.id); live(p.textContent); }
  else if (!at && n) { n.remove(); t.removeAttribute("aria-describedby"); } });
document.addEventListener("beforeinput", e => { const c = e.target; if (cmpSample(c) && /^insert/.test(e.inputType) && !(c.selectionStart === 0 && c.selectionEnd === c.value.length)) c.select(); });
const sumHover = e => { const p = e.target.closest && e.target.closest("#sumHit path"); if (p) focusSector(+p.dataset.si); };
document.addEventListener("pointerover", sumHover);
document.addEventListener("focusin", e => { sumHover(e); const p = e.target.closest && e.target.closest(".tabk"); });
document.addEventListener("pointerout", e => { if (e.target.closest && e.target.closest("#sumHit") && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#sumHit")) && !(document.activeElement && document.activeElement.closest && document.activeElement.closest("#sumHit"))) focusSector(null); });
const typing = el => el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" && el.type !== "checkbox" || el.isContentEditable);
document.addEventListener("keydown", e => {
  const a = document.activeElement, mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    if (!$("#demo").hidden) return closeDemo(true);
    if (!$("#toolbar").hidden) { hideToolbar(); getSelection().removeAllRanges(); return; }
    // editing a proposed write: Esc leaves the edit (nothing is sent) and goes back to its Edit button
    const ae = a && a.closest && a.closest("form.apredit");
    if (ae) { const th = threadById(ae.dataset.th), i = +ae.dataset.i, j = +ae.dataset.j; th.messages[i].pending[j].editing = false; refresh(); aprFocus(`[data-apr="${th.id}-${i}-${j}"] [data-d="edit"]`); return; }
    if (S.newOpen || S.index || S.slip) { S.newOpen = S.index = false; S.slip = null; renderLayer(true); return; }
    if (LMX) { const k = LMX; LMX = null; layLane(); const b = $$("#lane > .lmark").find(x => x.dataset.ths === k); b && b.focus({ preventScroll: true, focusVisible: true }); return; }
    if (S.st) { e.preventDefault(); return endST(!S.st.hold); }
    if (S.tray && S.trayProbe && S.panel.some(v => v.t === "probe")) { S.panel = S.panel.filter(v => v.t !== "probe"); S.trayProbe = false; renderPanel(); const i = $("#trayIn"); i && i.focus({ preventScroll: true }); return; }
    if (S.tray && (!isPhone() || !topView())) return foldTray();
    const top = topView();
    // back to the Probe button that opened the composer (Memo, Ask or Suggest edit), else the depth control
    if (top && top.t === "compose" && top.host) { S.panel.pop(); renderPanel(); const tv = $$(`[data-act="intent"][data-intent="${top.intent}"]`).find(b => b.offsetParent) || $("#travel"); tv && tv.focus({ preventScroll: true }); return; }
    if (S.panel.length) { const v = [...S.panel].reverse().find(x => x.t === "probe"), tray = isPhone() && S.tray && inTray(top); S.panel = []; S.unfold = null; if (isPhone()) S.tray = false; renderPanel();
      // the phone's chat tray: back to its bar, as Esc does on the desktop
      if (tray) { const b = $("#trayBar"); if (b && b.getClientRects().length) { b.focus({ preventScroll: true }); return; } }
      // back to what opened it when that was the figure map's tick or a lane marker (else the figure or passage it read)
      const m = top && top.t === "thread" && MRET === top.id && $$("#lane > .lmark").find(x => x.dataset.th === MRET || (x.dataset.ths || "").split(",").includes(MRET)), rk = !m && v && v.rk != null && $(`.rk[data-ri="${v.rk}"]`); MRET = null;
      if (rk) $$(".rk").forEach(x => x.tabIndex = x === rk ? 0 : -1);
      if (m || rk) { (m || rk).focus({ preventScroll: true, focusVisible: true }); return; }
      focusBack(v, top); return; }
    if (S.unfold) { S.unfold = null; renderPanel(); }
    return;
  }
  // ⌘J: Conversation opens with focus on the list's selected row; closing it returns focus to the Report / Conversation switch
  if (mod && e.key.toLowerCase() === "j" && S.route === "desk") { e.preventDefault(); if (!S.conv) RY[S.sheet] = scrollY; S.conv = !S.conv; renderSheet(); renderTabs(); renderPanel(); scrollTo(0, S.conv ? 0 : RY[S.sheet] || 0);
    const t = S.conv ? $(".conv .tcard[aria-current='true']") || $(".conv .tcard") || $(".conv .chip[tabindex='0']") : $(".seg button[aria-pressed='true']");
    if (t) { t.focus({ preventScroll: true }); const r = t.getBoundingClientRect(), B = band(); if (S.conv && (r.top < B.top || r.bottom > B.bot)) t.scrollIntoView({ block: "center" }); } return; }
  // an open dialog (aria-modal) keeps Tab and Shift+Tab inside it, wrapping at its ends (WAI-ARIA APG dialog pattern)
  if (e.key === "Tab" && !mod && !e.altKey) { const box = $('#layer [aria-modal="true"]');
    const fs = box ? $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, a[href], [tabindex="0"]', box).filter(x => x.getClientRects().length) : [];
    const i = fs.indexOf(a), to = !fs.length ? null : e.shiftKey ? (i <= 0 ? fs[fs.length - 1] : null) : (i < 0 || i === fs.length - 1 ? fs[0] : null);
    if (to) { e.preventDefault(); to.focus(); return; } if (box) return; }
  // Tab from the figure whose Probe is open goes straight to the Probe's first control (WAI-ARIA dialog pattern: focus moves into
  // it; its controls then follow in order); Shift+Tab from that control comes back to the figure
  if (e.key === "Tab" && !mod && !e.altKey && activeProbe()) { const bp = $("#lane .bal.probe:not(.fold)") || (isPhone() && $("#wpanel:not(.closed)")), fo = $("#content .fig.on"),
      t = bp && $$("button:not([disabled]), [tabindex='0'], a[href], textarea", bp).find(x => x.tabIndex >= 0 && x.getClientRects().length);
    if (t && !e.shiftKey && a === fo) { e.preventDefault(); t.focus({ preventScroll: true }); return; }
    if (t && e.shiftKey && fo && a === t) { e.preventDefault(); fo.focus({ preventScroll: true }); return; } }
  if (mod && e.key === "Enter") {
    if (a && a.id === "cmp") { e.preventDefault(); return send(topView(), a.value); }
    if (!$("#toolbar").hidden && S.sel && !S.sel.anchor.cross) { e.preventDefault(); return startIntent(e.shiftKey ? "edit" : "explain", S.sel.anchor); }
  }
  if (a && a.id === "trayIn" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); a.form.requestSubmit(); return; }
  if (typing(a)) return;
  // show-through: hold Space over (or with focus in) a table or paragraph; arrows move the active row or figure
  if (S.st && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); return stMove(e.key === "ArrowDown" ? 1 : -1); }
  // PageUp / PageDown scroll the panel (the page stays still while show-through is on)
  if (S.st && /^Page(Up|Down)$/.test(e.key)) { e.preventDefault(); const u = $(".under:not(.ghost)"); if (u && u._page) u._page(e.key === "PageDown" ? 1 : -1); return; }
  if (e.key === " " && !mod && S.route === "desk" && !S.conv) {
    if (S.st && S.st.hold) { e.preventDefault(); return; }
    // Space on a focused control (a button, a link) presses it, as the browser does. On a figure in a table or paragraph a tap
    // presses it (its Probe) and a hold starts show-through on that figure's row; tap and hold apply over blocks elsewhere
    const fig = a && a.classList && a.classList.contains("fig") && a.closest("#content") && a.closest(ST_BLK) ? a : null;
    if (!fig && a && a !== document.body && a.matches("button, a[href], input, select, [role=slider], [role=button], summary")) return;
    const blk = fig ? fig.closest(ST_BLK) : (a && a.closest && a.closest("#content") && a.closest(ST_BLK)) || (hoverBlk && hoverBlk.closest("#content") ? hoverBlk : null);
    if (blk && !S.st) { e.preventDefault(); if (!e.repeat && !spaceT) spaceT = { fig, shift: e.shiftKey, t: setTimeout(() => { spaceT.t = 0; const rows = stRows(blk); startST(blk.dataset.block, true, fig ? Math.max(0, rows.findIndex(r => r === fig || r.contains(fig))) : 0); }, 200) }; return; }
  }
  if (!$("#toolbar").hidden && S.sel && !S.sel.anchor.cross && e.key.toLowerCase() === "m" && !mod) { e.preventDefault(); return startIntent("note", S.sel.anchor); }
  if (S.route === "desk" && (e.key === "[" || e.key === "]") && !mod) { const ids = sheetIds(), i = ids.indexOf(S.sheet), n = ids[i + (e.key === "]" ? 1 : -1)]; if (n) goSheet(n); return; }
  // figures in the sheet: one tab stop, arrows move
  if (a && a.classList.contains("fig") && a.closest("#content") && /^Arrow(Up|Down|Left|Right)$|^Home$|^End$/.test(e.key)) { e.preventDefault(); const fs = $$("#content .fig"), i = fs.indexOf(a), n = e.key === "Home" ? 0 : e.key === "End" ? fs.length - 1 : clamp(i + (/Down|Right/.test(e.key) ? 1 : -1), 0, fs.length - 1); rovingFigs(n).focus(); return; }
  // index tabs and the Report / Conversation switch: one tab stop each, arrows move
  if (a && (a.classList.contains("tabk") || a.classList.contains("gr") || a.parentElement && a.parentElement.matches(".seg, .conv .chiprow")) && /^Arrow|^Home$|^End$/.test(e.key)) { e.preventDefault(); const g = a.classList.contains("tabk") ? $$("#idx .tabk") : a.classList.contains("gr") ? guideRows() : $$("button", a.parentElement), i = g.indexOf(a), n = e.key === "Home" ? 0 : e.key === "End" ? g.length - 1 : (i + (/Down|Right/.test(e.key) ? 1 : -1) + g.length) % g.length; g.forEach((b, k) => b.tabIndex = k === n ? 0 : -1); g[n].focus(); if (g[n].dataset.gk) GK = g[n].dataset.gk; return; }
  // figure map: one tab stop, arrows move
  if (a && a.classList.contains("rk") && /^Arrow(Up|Down)$|^Home$|^End$/.test(e.key)) { e.preventDefault(); const ks = $$(".rk"), i = ks.indexOf(a), n = e.key === "Home" ? 0 : e.key === "End" ? ks.length - 1 : clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, ks.length - 1); ks.forEach(k => k.tabIndex = -1); ks[n].tabIndex = 0; ks[n].focus(); const el = rovingFigs(n); el && el.scrollIntoView({ block: "nearest" }); return; }
  // rosette sectors
  if (a && a.closest && a.closest("#sumHit")) { if (/^Arrow/.test(e.key)) { e.preventDefault(); const n = docV().sections.length; focusSector((+a.dataset.si + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + n) % n, true); return; } if (e.key === "Enter" || e.key === " ") { e.preventDefault(); return goSheet(roseModel(docV())[+a.dataset.si].s.id); } }
  // probe: 1-4 and arrows on the depth slider; Backspace steps out
  const v = activeProbe();
  if (v && a && a.closest && a.closest("#wpanel, .bal.probe")) {
    if (/^[1-4]$/.test(e.key)) { e.preventDefault(); return setDet(+e.key - 1); }
    if (a.id === "travel" && /^Arrow|^Home$|^End$/.test(e.key)) { e.preventDefault(); return setDet(e.key === "Home" ? 0 : e.key === "End" ? 3 : v.det + (e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1)); }
    if (e.key === "Backspace" && v.stack.length > 1) { e.preventDefault(); v.stack.pop(); renderPanel(); $("#travel").focus({ preventScroll: true }); live("Stepped out"); return; }
  }
  if (v && /^[1-4]$/.test(e.key) && a && a.classList && (a.classList.contains("fig") || a.classList.contains("rk"))) { e.preventDefault(); setDet(+e.key - 1); return; }
});

/* ================= theme ================= */
function setTheme(t) { S.theme = t; if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => paintRoses());

/* ================= demo ================= */
const DEMO = [
  ["App", [["home", "Home"], ["new-filings", "Home · new filings this week"], ["new", "New report"], ["already-written", "New report · already written"], ["writing", "Writing"], ["writing-first-request", "Writing · first request"], ["library-catalog", "Library catalog"], ["stopped", "Stopped"], ["ready", "Ready → Summary"], ["library", "Library"], ["developer", "Developer"], ["settings", "Settings"], ["markets", "Markets (later)"]]],
  ["Desk", [["summary", "Summary"], ["summary-focus", "Summary sector focus"], ["chapter", "Chapter with rail"], ["probe-read", "Probe balloon · Read"], ["probe-exact", "Probe · Exact"], ["probe-work", "Probe · Work (with step-in)"], ["probe-filing", "Probe · Filing"], ["balloons", "Conversation balloons"], ["folded", "Folded labels (Probe open)"], ["show-table", "Show-through · 06 table"], ["show-prose", "Show-through · paragraph"], ["slip", "Reading slip"], ["lab", "Valuation lab asking for price"], ["glossary", "Glossary"], ["references", "References"]]],
  ["Work on the report", [["memo", "Memo"], ["ask", "Ask answer"], ["compose-probe", "Ask inside the Probe balloon"], ["tray", "Chat tray open"], ["ask-refusal", "Ask refusal in the tray (share price)"], ["suggest", "Suggest draft"], ["apply", "Apply → Rev 2"], ["rev2-private", "Your private Rev 2"], ["refused", "Edit refused"], ["conversation", "Conversation"]]],
  ["Phone (view at 390 px)", [["summary", "Summary"], ["chapter", "Chapter"], ["probe-read", "Probe sheet"], ["tray", "Chat tray sheet"], ["show-prose", "Show-through toggle"], ["index", "Index sheet"]]],
];
function buildDemo() {
  $("#demo").innerHTML = `<div class="mh">Jump to a state. Every figure comes from the data block; timings are demo timing.</div>` + DEMO.map(([g, items]) => `<div class="g">${g}</div>` + items.map(([id, l]) => `<button role="menuitem" data-act="demo" data-v="${id}">${l}</button>`).join("")).join("");
}
function closeDemo(focus) { const m = $("#demo"); if (m.hidden) return; m.hidden = true; $("#demoBtn").setAttribute("aria-expanded", "false"); focus && $("#demoBtn").focus(); }
function toggleDemo(e) { e.preventDefault(); e.stopPropagation(); const m = $("#demo"); m.hidden = !m.hidden; $("#demoBtn").setAttribute("aria-expanded", String(!m.hidden)); if (!m.hidden) $("button", m).focus(); }
$("#demoBtn").addEventListener("click", toggleDemo);
document.addEventListener("click", e => { const d = e.target.closest('[data-act="demoopen"]'); if (d) toggleDemo(e); }, true);
function seed() {
  if (APP) return; // app mode: no sample notes; the reader's memos come from the app server
  const doc = S.docs[1], add = (kind, bid, exact, msgs) => {
    const b = blockOf(doc, bid); if (!b || !plain(b.b.text).includes(exact)) return null;
    const t = plain(b.b.text), i = t.indexOf(exact);
    const th = { id: "t" + (++S.seq), kind, anchor: { revision_id: "rev-1", section_id: b.s.id, block_id: bid, exact, prefix: t.slice(Math.max(0, i - 64), i), suffix: t.slice(i + exact.length, i + exact.length + 64) }, status: "open", messages: msgs };
    S.threads.push(th); return th;
  };
  // anchor each sample note on a phrase the current prose really contains (the first match, else its opening words)
  const phrase = (blk, re) => { if (!blk) return null; const t = plain(blk.b.text), m = re.exec(t); return m ? m[0] : t.split(" ").slice(0, 6).join(" "); };
  const pick = (kind, blk, re, msgs) => blk && add(kind, blk.b.id, phrase(blk, re), msgs);
  const ok = EDIT_OK(), inv = INVEST();
  const capex = proseWith("capex-fy2025", "net-sec-purchases-fy2025") || proseWith("capex-fy2025");
  if (capex) pick("note", capex, /The company spent .{0,40}? on property and equipment|Purchases of property and equipment[^.,]{0,24}/, [{ role: "user", mode: "note", text: "Capex this low: check whether hosting is expensed rather than capitalized.", created_at: "13:41" }]);
  if (inv) pick("ai", inv, /net purchases of marketable securities|mostly because cash moved into marketable securities/, [{ role: "user", mode: "explain", text: "Why is investing cash flow so large when capital spending is tiny?", created_at: "13:44" }, { role: "assistant", mode: "explain", text: ANSWERS.invest(), latency_s: 5.2, reads: 1 }]);
  if (ok) pick("note", ok, /The largest noncash add-back was|stock-based compensation was/, [{ role: "user", mode: "note", text: SAMPLE_REQ.note, created_at: "13:52" }]);
}
function resetState() { const theme = S && S.theme; S = freshState(); S.theme = theme; seed(); setJob(T.review, "ready"); $("#scrim").hidden = true; hideToolbar(); getSelection().removeAllRanges(); }
// demo targets: found from the data, so the same states work on the full report
const firstProse = sid => { const s = secById(docV(), sid); return s && s.blocks.find(b => b.kind === "prose"); };
function figOnSheet(pred) { return $$("#content .fig").find(el => pred(F[el.dataset.fact], el)); }
async function runDemo(id) {
  closeDemo(); FAST = true;
  try {
    resetState(); scrollTo(0, 0);
    const cf = (secById(DOC, "cash-flow") || {}).blocks?.length ? "cash-flow" : (DOC.sections.find(s => s.blocks.length) || DOC.sections[0]).id;
    const desk = sid => { S.route = "desk"; S.sheet = sid; render(); scrollTo(0, 0); };
    switch (id) {
      case "home": S.route = "home"; render(); break;
      case "new-filings": S.route = "home"; render(); $("#newFilings").scrollIntoView({ block: "start" }); break;
      case "already-written": S.route = "home"; S.newForm = { co: FIL.ticker, form: FIL.form, fy: "FY" + FY, lang: "en" }; S.newOpen = true; render(); break;
      case "library-catalog": S.route = "library"; render(); break;
      case "new": S.route = "home"; S.newForm = { co: "", form: "10-K", fy: "FY" + FY, lang: "en" }; S.newOpen = true; render(); break;
      case "writing": case "writing-first-request": S.threads = []; setJob(455, "running"); S.route = "writing"; render(); break;
      case "stopped": S.threads = []; setJob(455, "stopped"); S.route = "writing"; render(); break;
      case "ready": setJob(T.review, "ready"); S.route = "writing"; render(); break;
      case "library": S.route = "library"; render(); break;
      case "developer": case "settings": case "markets": S.route = id; render(); break;
      case "summary": desk("summary"); break;
      case "summary-focus": desk("summary"); { const i = roseModel(docV()).findIndex(m => m.s.id === cf); focusSector(i, true); $("#sumRoseBox").scrollIntoView({ block: "center" }); } break;
      case "chapter": desk(cf); break;
      case "index": desk(cf); S.index = true; renderLayer(); break;
      case "probe-read": case "probe-exact": case "probe-filing": case "slip": {
        desk(cf);
        const el = id === "probe-filing" || id === "slip" ? figOnSheet((f, e) => f.kind === "calculated" && e.closest("td")) || figOnSheet(f => f.kind === "calculated") : figOnSheet((f, e) => f.kind === "calculated" && e.closest(".prose")) || figOnSheet(() => true);
        el.scrollIntoView({ block: "center" }); openProbe(el.dataset.fact, el, { "probe-read": 0, "probe-exact": 1, "probe-filing": 3, slip: 0 }[id]);
        if (id === "slip") { S.slip = el.dataset.fact; renderLayer(); }
        break; }
      case "probe-work": {
        let target = null;
        for (const sid of sheetIds().slice(0, -2)) { S.route = "desk"; S.sheet = sid; render(); const el = figOnSheet(f => f.kind === "calculated" && f.inputs.some(i => F[i] && F[i].kind === "calculated")); if (el) { target = el; break; } }
        if (!target) { desk(cf); target = figOnSheet(f => f.kind === "calculated"); }
        scrollTo(0, 0); target.scrollIntoView({ block: "center" }); openProbe(target.dataset.fact, target, 2);
        const f = F[target.dataset.fact], inner = f.inputs.find(i => F[i] && F[i].kind === "calculated") || f.inputs[0];
        activeProbe().stack.push(inner); renderPanel(); break; }
      case "lab": { const s = DOC.sections.find(x => x.blocks.some(b => b.kind === "lab")); desk(s ? s.id : cf); const l = $(".blk.lab"); l && l.scrollIntoView({ block: "center" }); break; }
      case "glossary": case "references": desk(id); break;
      case "conversation": desk(cf); S.conv = true; renderSheet(); renderTabs(); break;
      case "memo": { desk(cf); const b = firstProse(cf); const t = anchorText(txtEl(b.id)); const exact = t.split(/[.:]/)[0].split(" ").slice(0, 6).join(" ");
        selectText(b.id, exact); startIntent("note", S.sel.anchor); await send(topView(), "Ask IR how much of this is timing of customer payments."); getSelection().removeAllRanges(); break; }
      case "ask": { desk(cf); const th = S.threads.find(t => t.kind === "ai" && t.anchor && t.anchor.section_id === cf);
        if (th) gotoThread(th); else { const b = firstProse(cf); selectText(b.id, anchorText(txtEl(b.id)).split(" ").slice(0, 5).join(" ")); startIntent("explain", S.sel.anchor); await send(topView(), $("#cmp").value); }
        break; }
      case "ask-refusal": desk(cf); await trayAsk(DOCK_QS[2]); break;
      case "tray": desk(cf); await trayAsk(dockQs().at(-2)); break;
      case "balloons": case "folded": { desk(cf); const ask = S.threads.find(x => x.kind === "ai" && x.anchor && x.anchor.section_id === cf), b = id === "balloons" && ask ? blockOf(docV(), ask.anchor.block_id).b : firstProse(cf), t = anchorText(txtEl(b.id));
        const sent = t.split(/(?<=\.)\s+/), pick = id === "balloons" && sent.length > 1 ? sent[sent.length - 1] : sent[0];
        selectText(b.id, pick.split(/[.:]/)[0].split(" ").slice(0, 6).join(" ")); startIntent("note", S.sel.anchor); await send(topView(), id === "balloons" ? "Compare with the securities note: how much is Treasury bills?" : "Ask IR how much of this is timing of customer payments."); getSelection().removeAllRanges(); hideToolbar();
        if (id === "balloons") { S.panel = []; scrollTo(0, 0); if (ask) { const r = findAnchor(ask.anchor); r && scrollTo(0, Math.max(0, r.getBoundingClientRect().top + scrollY - innerHeight * .3)); gotoThread(ask); } else renderPanel(); }
        else { S.panel = []; const el = $(`#content [data-block="${CSS.escape(b.id)}"] .fig`) || figOnSheet(() => true); scrollTo(0, 0); openProbe(el.dataset.fact, el, 1); }
        break; }
      case "compose-probe": { desk(cf); const el = figOnSheet((f, e) => f.kind === "calculated" && e.closest(".prose")) || figOnSheet(() => true); el.scrollIntoView({ block: "center" }); openProbe(el.dataset.fact, el, 0); $('[data-act="intent"][data-intent="explain"]').click(); break; }
      case "show-table": case "show-prose": { desk(cf); const sec = secById(docV(), cf), b = id === "show-table" ? sec.blocks.find(x => x.kind === "table") : sec.blocks.find(x => x.kind === "prose" && blockFacts(x).some(f => F[f] && F[f].kind === "calculated")) || firstProse(cf);
        const el = blockEl(b.id), hd = $("#sheet .shead"), off = (hd && getComputedStyle(hd).display !== "none" ? hd.offsetHeight : $("#strip") ? $("#strip").getBoundingClientRect().bottom : 0) + 28;
        scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - off)); startST(b.id, false);
        const rows = stRows(el), k = rows.findIndex(r => (r.matches(".fig") ? r : $(".fig.c", r)) && (r.matches(".fig") ? r.classList.contains("c") : true)); S.st.i = Math.max(0, k); renderST(); renderPanel(); break; }
      case "suggest": case "apply": case "rev2-private": { const ok = EDIT_OK(); desk(ok ? ok.s.id : cf); const b = ok ? ok.b : firstProse(cf);
        const t = anchorText(txtEl(b.id)), m = /stock-based compensation was|noncash add-back/.exec(t), exact = m ? m[0] : t.split(" ").slice(0, 6).join(" ");
        selectText(b.id, exact); startIntent("edit", S.sel.anchor); await send(topView(), SAMPLE_REQ.edit); getSelection().removeAllRanges();
        if (id !== "suggest") { const th = threadById(topView().id); await applyProposal(th); }
        if (id === "rev2-private") { S.panel = []; renderPanel(); scrollTo(0, 0); break; }
        txtEl(b.id) && txtEl(b.id).scrollIntoView({ block: "center" }); renderGutter(); break; }
      case "refused": { const no = EDIT_REFUSE(), s = no ? no.s : secById(DOC, cf);
        desk(s.id); const b = no ? no.b : firstProse(s.id);
        const t = anchorText(txtEl(b.id)); selectText(b.id, t.split(" ").slice(0, 4).join(" ").replace(/[.,]$/, "")); startIntent("edit", S.sel.anchor);
        await send(topView(), "Add last year's revenue to this sentence."); getSelection().removeAllRanges();
        const th = threadById(topView().id), r = th.messages.find(x => x.refusal); if (r) { r.refusal.open = true; renderPanel(); } break; }
    }
  } finally { FAST = false; }
  hideToolbarIfNoSel(); paintRoses();
}
function hideToolbarIfNoSel() { const s = getSelection(); if (!s.rangeCount || s.isCollapsed) hideToolbar(); }

/* ================= boot ================= */
S = freshState(); seed();
buildDemo();
// deep links: "#summary", "#summary-dark", or the long form "#s=summary&theme=dark&speed=100"
function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (raw.includes("=")) { const h = new URLSearchParams(raw); return { s: h.get("s"), theme: h.get("theme"), speed: h.get("speed"), at: h.get("at") }; }
  const m = /^(.*?)(?:-(dark|light))?$/.exec(raw);
  return { s: m[1] || null, theme: m[2] || null, speed: null };
}
function applyHash() {
  const h = parseHash();
  if (h.theme) setTheme(h.theme);
  if (h.speed) JOB.speed = +h.speed || 30;
  if (h.s && DEMO.some(([, items]) => items.some(([id]) => id === h.s))) { runDemo(h.s); return true; }
  if (h.at) { const [r, sh, cv] = h.at.split("/"); if (r === "desk") { loadMemos(); S.route = "library"; goSheet(sheetIds().includes(sh) ? sh : "summary"); if (cv) { S.conv = true; renderSheet(); renderTabs(); } return true; } if (PLACE[r]) { loadMemos(); setRoute(r === "developer" && sh === "essay" ? "essay" : r); if (r === "writing" && APP) { S.liveJob = /^[0-9a-f]{32}$/.test(sh || "") ? sh : null; if (S.liveJob && !runById(sh)) { LJ.runs.push({ id: sh, filing_id: "", name: "Report run", told: false, seen: false }); saveRuns(); } } render(); if (S.liveJob) pollJobs(); return true; } }
  if (h.theme && S.route) render();
  return false;
}
(function boot() {
  setJob(T.review, "ready");
  BYHASH = true; try { if (!applyHash()) { loadMemos(); render(); } } finally { BYHASH = false; }
  if (APP && LJ.runs.length) pollJobs(); // runs started earlier in this browser: a run that ended while the judge was away is told now
  // app mode: the editions and this edition's status, from the app server; until they arrive the tag says "status loading"
  if (APP) api("GET", CFG.reports_url).then(list => { LIB = list; ED = list.find(e => e.id === CFG.edition_id) || null; if (!ED) EDERR = "this edition is not in the list"; },
    e => { LIB = { err: e.message }; EDERR = e.message; }).then(() => { stripLabel(); padTop(); live(`Shared edition R${(DOC.edition && DOC.edition.number) || 1}: ${edWords()}.`); S.route === "desk" ? refresh() : render(); const pe = $("#pEd"); if (pe) pe.innerHTML = pEdHTML(); });
  // balloons sit at measured heights: measure again once the web fonts have settled
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.route === "desk") { renderPanel(); renderST(); } });
})();
// Back, Forward and a typed address go to the place the address names; the redraw replaces that entry, never adds one. popstate
// and hashchange can both fire for one move: the second finds the address already applied
function onHash() { if (location.hash === HASH) return; BYHASH = true; try { applyHash(); } finally { BYHASH = false; HASH = location.hash; }
  const a = document.activeElement; if (a && a !== document.body && a.isConnected) return;
  if (S.route === "desk") sheetMoved(null); else { $("#main").focus({ preventScroll: true }); live(S.route === "writing" ? "Writing" : PLACE[S.route] || "Home"); } }
addEventListener("hashchange", onHash); addEventListener("popstate", onHash);
