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

async function evaluate(said) {
  const sem = (await call('semanticSearch', { text: said, limit: 10 })).results || [];
  const rr = sem.length ? ((await call('rerank', { text: said, candidates: sem })).results || []) : [];
  return { sem, rr };
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
    const s = { n: list.length, semTop1: 0, semTop3: 0, semTop10: 0, rrTop1: 0, rrTop3: 0, offeredRight: 0, offeredWrong: 0 };
    for (const c of list) {
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
  const neg = { n: cases.negatives.length, offered: 0, topCos: [], topRr: [] };
  for (const said of cases.negatives) {
    const r = await evaluate(said);
    neg.topCos.push(r.sem[0]?.similarity || 0); neg.topRr.push(r.rr[0]?.rerankScore || 0);
    if (offered(r).length) { neg.offered++; if (LIST) console.log(`  [negative offered] ${offered(r).join(', ')} | "${said}"`); }
  }
  const pct = (a, b) => `${(100 * a / b).toFixed(0)}%`;
  for (const [name, s] of Object.entries(report)) {
    console.log(`${name} paraphrases (${s.n}): found #1 ${pct(s.semTop1, s.n)} / top-3 ${pct(s.semTop3, s.n)} / top-10 ${pct(s.semTop10, s.n)}; after rerank #1 ${pct(s.rrTop1, s.n)} / top-3 ${pct(s.rrTop3, s.n)}; offered today: right ${pct(s.offeredRight, s.n)}, wrong ${pct(s.offeredWrong, s.n)}`);
  }
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))].toFixed(2);
  console.log(`negatives (${neg.n}): offered a verse ${pct(neg.offered, neg.n)}; top cosine median ${q(neg.topCos, 0.5)} / max ${q(neg.topCos, 1)}; top rerank median ${q(neg.topRr, 0.5)} / max ${q(neg.topRr, 1)}`);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(0);
}
