// KAIRO — A service preached in Spanish: citations spoken in Spanish are
// understood, and a verse read aloud is matched against the Spanish Bible.
//   KAIRO_EVAL_MODE=1 node server/language_service.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }
const dir = path.join(os.tmpdir(), `kairo-language-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ sttLanguage: 'es' }));
process.env.KAIRO_APP_DATA_DIR = dir;
const server = require('./server');
const { referenceContext } = require('./reference_parser');
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`✔ ${name}`); } catch (e) { fail++; console.log(`✖ ${name}\n  ${e.message}`); } }
const wait = ms => new Promise(r => setTimeout(r, ms));
let sent = [];
server.onBroadcast(m => { if (m.type === 'detection') sent.push({ ref: m.verses[0].reference, target: m.target, method: m.method }); });
async function say(text) {
  const w = text.split(' ');
  for (let i = 3; i < w.length; i += 3) { await server.handleTranscriptSegment(w.slice(0, i).join(' '), false, 0.9, false); await wait(15); }
  await server.handleTranscriptSegment(text, true, 0.9, true); await wait(200);
}
// A verse range deliberately survives a new listening session (it is on screen),
// so each case clears it explicitly.
const fresh = () => { server.resetDetectionSession(); server.clearRangeQueue(); referenceContext.reset(); sent = []; };
const shown = () => sent.filter(s => s.target === 'viewer').map(s => s.ref);

(async () => {
  server.spawnDetectionWorker(); await server.workerReadyPromise; await wait(1500);

  await test('a citation spoken in Spanish goes to the screen', async () => {
    fresh();
    await say('Abramos nuestras biblias en Juan capítulo tres versículo dieciséis.');
    assert.ok(shown().includes('John 3:16'), `got ${JSON.stringify(sent)}`);
  });

  await test('"siguiente versículo" moves to the next verse', async () => {
    await wait(4500);   // past the post-send dead zone
    await say('Y ahora el siguiente versículo.');
    assert.ok(shown().includes('John 3:17'), `got ${JSON.stringify(sent)}`);
  });

  await test('a numbered book with a Spanish ordinal and range', async () => {
    fresh();
    await say('Vamos a primera de Corintios trece, del cuatro al siete.');
    assert.ok(shown().includes('1 Corinthians 13:4'), `got ${JSON.stringify(sent)}`);
  });

  // Read the way it is preached today (Reina-Valera 1960 wording), not the
  // bundled 1909 text word for word.
  const readings = {
    'John 3:16': 'Porque de tal manera amó Dios al mundo, que ha dado a su Hijo unigénito, para que todo aquel que en él cree, no se pierda, mas tenga vida eterna.',
    'Isaiah 41:10': 'No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo; siempre te ayudaré, siempre te sustentaré con la diestra de mi justicia.',
  };
  for (const [ref, text] of Object.entries(readings)) {
    await test(`a Spanish reading of ${ref} with no citation reaches the screen`, async () => {
      fresh();
      await say(text);
      await wait(1500);   // verbatim + corroboration re-evaluation finish after the final
      assert.ok(shown().includes(ref), `got ${JSON.stringify(sent)}`);
    });
  }

  await test('ordinary Spanish preaching sends nothing', async () => {
    fresh();
    await say('Hermanos, buenos días, qué alegría verlos a todos esta mañana, antes de empezar quiero dar la bienvenida a las familias que nos visitan por primera vez.');
    await say('Y la iglesia tiene que entender que la gracia no es una licencia para vivir como queramos, sino el poder para vivir en santidad cada día.');
    assert.deepEqual(shown(), [], `got ${JSON.stringify(sent)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
