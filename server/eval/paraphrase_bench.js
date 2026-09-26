// KAIRO — paraphrase benchmark for the meaning-based (semantic) layer.
// Runs the detection worker directly (no time compression, no throttling) over
// paraphrase_cases.json plus real paraphrased quotes from the eval sermons, and
// reports how often the right verse is found and how often ordinary sermon
// speech would be offered as a verse.
//   node server/eval/paraphrase_bench.js [--list]
'use strict';
const { Worker } = require('worker_threads');
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'paraphrase_cases.json'), 'utf8'));
const LIST = process.argv.includes('--list');

// Real paraphrased quotes: key entries matched only partly word-for-word,
// with the transcript around them as what was said.
function realCases() {
  const out = [];
  const dir = path.join(__dirname, 'fixtures');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const g of fx.groundTruth) {
      if (g.kind !== 'quote' || g.bootstrapped || g.verse == null || typeof g.similarity !== 'number' || g.similarity >= 0.6) continue;
      const said = fx.transcript.filter(c => c.startMs >= g.startMs - 3000 && c.startMs <= g.startMs + 10000).map(c => c.text).join(' ');
      if (said.split(/\s+/).length >= 6) out.push({ said, refs: [`${g.book} ${g.chapter}:${g.verse}`], src: f });
    }
  }
  return out;
}

const worker = new Worker(path.join(ROOT, 'server', 'detection_worker.js'), { workerData: { dataDir: path.join(ROOT, 'databases', 'bibles') } });
let id = 0; const pending = new Map(); const ready = new Set();
worker.on('message', m => {
  if (['ready', 'semanticReady', 'rerankerReady'].includes(m.type)) { ready.add(m.type); maybeStart(); }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (type, p) => new Promise(r => { const i = ++id; pending.set(i, r); worker.postMessage({ type, id: i, ...p }); });

let started = false;
function maybeStart() { if (!started && ready.has('ready') && ready.has('semanticReady') && ready.has('rerankerReady')) { started = true; run().catch(e => { console.error(e); process.exit(1); }); } }
setTimeout(() => { if (!started) { console.error('worker not ready (semantic/reranker installed?)', [...ready]); process.exit(1); } }, 240000);

const { paraphraseWindows, decideParaphrase } = require('../paraphrase');

// Before (whole text, one query) — kept for comparison.
async function evaluate(said) {
  const sem = (await call('semanticSearch', { text: said, limit: 10 })).results || [];
  const rr = sem.length ? ((await call('rerank', { text: said, candidates: sem })).results || []) : [];
  return { sem, rr };
}
// Now: the live paraphrase detector (windows + combined signals + decision).
async function detect(said) {
  const windows = paraphraseWindows(said);
  if (!windows.length) return { ranked: [], decision: null };
  const res = (await call('paraphraseSearch', { windows, limit: 8 })).results || [];
  const ranked = res.slice().sort((a, b) => ((b.rerankScore ?? -1) - (a.rerankScore ?? -1)) || (b.cos - a.cos));
  return { ranked, decision: decideParaphrase(res, { quoteSignal: false }) };
}

const rankOf = (list, refs) => { const i = list.findIndex(r => refs.includes(r.reference)); return i < 0 ? Infinity : i + 1; };
// What the live pipeline does with it today: a suggestion when the raw cosine
// clears 0.87, or the reranker's top clears 0.5.
const offered = ({ sem, rr }) => {
  const q = sem.filter(r => r.similarity >= 0.87).map(r => r.reference);
  if (rr[0] && rr[0].rerankScore >= 0.5) q.push(rr[0].reference);
  return q;
};

async function run() {
  const t0 = Date.now();
  const groups = { written: cases.positives, real: realCases() };
  const report = {};
  for (const [name, list] of Object.entries(groups)) {
    const s = { n: list.length, semTop1: 0, semTop3: 0, semTop10: 0, rrTop1: 0, rrTop3: 0, offeredRight: 0, offeredWrong: 0, newTop1: 0, newOffered: 0, newOfferedWrong: 0, newSent: 0, newSentWrong: 0 };
    for (const c of list) {
      const d = await detect(c.said);
      if (d.ranked[0] && c.refs.includes(d.ranked[0].reference)) s.newTop1++;
      if (d.decision) {
        const ok = c.refs.includes(d.decision.verse.reference);
        if (ok) s.newOffered++; else s.newOfferedWrong++;
        if (d.decision.target === 'viewer') { if (ok) s.newSent++; else s.newSentWrong++; }
      }
      const r = await evaluate(c.said);
      const semRank = rankOf(r.sem, c.refs), rrRank = rankOf(r.rr, c.refs);
      if (semRank <= 1) s.semTop1++; if (semRank <= 3) s.semTop3++; if (semRank <= 10) s.semTop10++;
      if (rrRank <= 1) s.rrTop1++; if (rrRank <= 3) s.rrTop3++;
      const off = offered(r);
      if (off.some(x => c.refs.includes(x))) s.offeredRight++; else if (off.length) s.offeredWrong++;
      if (LIST && rrRank > 1) console.log(`  [${name}] want ${c.refs[0]} | sem#${semRank} rr#${rrRank} | top: ${r.rr.slice(0, 3).map(x => `${x.reference} ${x.rerankScore.toFixed(2)}/${x.similarity.toFixed(2)}`).join(', ')} | "${c.said.slice(0, 90)}"`);
    }
    report[name] = s;
  }
  const neg = { n: cases.negatives.length, offered: 0, topCos: [], topRr: [], newOffered: 0, newSent: 0 };
  for (const said of cases.negatives) {
    const d = await detect(said);
    if (d.decision) { neg.newOffered++; if (d.decision.target === 'viewer') neg.newSent++; if (LIST) console.log(`  [negative, new detector] ${d.decision.target} ${d.decision.verse.reference} | "${said}"`); }
    const r = await evaluate(said);
    neg.topCos.push(r.sem[0]?.similarity || 0); neg.topRr.push(r.rr[0]?.rerankScore || 0);
    if (offered(r).length) { neg.offered++; if (LIST) console.log(`  [negative offered] ${offered(r).join(', ')} | "${said}"`); }
  }
  const pct = (a, b) => `${(100 * a / b).toFixed(0)}%`;
  for (const [name, s] of Object.entries(report)) {
    console.log(`${name} paraphrases (${s.n}):`);
    console.log(`  before: found #1 ${pct(s.rrTop1, s.n)} (top-3 ${pct(s.rrTop3, s.n)}); offered right ${pct(s.offeredRight, s.n)}, wrong ${pct(s.offeredWrong, s.n)}`);
    console.log(`  now:    found #1 ${pct(s.newTop1, s.n)}; offered right ${pct(s.newOffered, s.n)}, wrong ${pct(s.newOfferedWrong, s.n)}; on screen right ${pct(s.newSent, s.n)}, wrong ${pct(s.newSentWrong, s.n)}`);
  }
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))].toFixed(2);
  console.log(`negatives (${neg.n}): before offered a verse ${pct(neg.offered, neg.n)}; now offered ${pct(neg.newOffered, neg.n)}, on screen ${pct(neg.newSent, neg.n)}`);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(0);
}
