// KAIRO — Slide import
//
// Extracts presentable text out of the file formats churches actually hand the
// media desk. DOCX and PPTX are ZIP containers of XML, so they're read here
// with Node's own zlib rather than pulling in a document library — the only
// thing we need is the text runs, not layout fidelity.
//
// Returns: { blocks: [{ label, lines: [string] }], format, note? }
'use strict';

const zlib = require('zlib');

// ── Minimal ZIP reader ────────────────────────────────────────────────────
// Walks the central directory and inflates the entries we ask for. Enough for
// OOXML, which only ever uses store (0) or deflate (8).
//
// ProPresenter's own zip writer (bundles/playlists) always emits Zip64 extra
// fields on every entry, even tiny ones — compSize/uncompSize/localHeaderOffset
// read as the sentinel 0xFFFFFFFF and the real 64-bit values live in a Zip64
// extra record instead. Standard OOXML zips (docx/pptx) never trigger this
// path since they're never large/exotic enough to need it.
const ZIP64_SENTINEL = 0xFFFFFFFF;

function readZip64Extra(extraBuf, needUncomp, needComp, needLho) {
  let off = 0;
  while (off + 4 <= extraBuf.length) {
    const id  = extraBuf.readUInt16LE(off);
    const len = extraBuf.readUInt16LE(off + 2);
    if (id === 0x0001) {
      let q = off + 4;
      const end = off + 4 + len;
      const out = {};
      if (needUncomp && q + 8 <= end) { out.uncompSize = Number(extraBuf.readBigUInt64LE(q)); q += 8; }
      if (needComp   && q + 8 <= end) { out.compSize   = Number(extraBuf.readBigUInt64LE(q)); q += 8; }
      if (needLho    && q + 8 <= end) { out.lho        = Number(extraBuf.readBigUInt64LE(q)); q += 8; }
      return out;
    }
    off += 4 + len;
  }
  return null;
}

function unzip(buf, wantRe) {
  const out = new Map();
  // End of central directory: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method   = buf.readUInt16LE(p + 10);
    let compSize   = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    let lho        = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (compSize === ZIP64_SENTINEL || lho === ZIP64_SENTINEL) {
      const extraBuf = buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const z64 = readZip64Extra(extraBuf, false, compSize === ZIP64_SENTINEL, lho === ZIP64_SENTINEL);
      if (z64) {
        if (z64.compSize != null) compSize = z64.compSize;
        if (z64.lho != null) lho = z64.lho;
      }
    }

    p += 46 + nameLen + extraLen + cmtLen;

    if (!wantRe.test(name)) continue;

    // Local header: recompute the data offset, its name/extra lengths differ.
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lNameLen  = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    try {
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch { /* skip unreadable member */ }
  }
  return out;
}

const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

// ── RTF → plain text ──────────────────────────────────────────────────────
// Shared by ProPresenter 6 (RTFData attributes) and ProPresenter 7 (RTF blobs
// embedded in protobuf text elements) — both wrap slide text in RTF the same
// way. Formatting is discarded; only the readable text survives, since it's
// about to be re-rendered by Kairo's own theme anyway.
function rtfToText(rtf) {
  return String(rtf || '')
    // Per-element font/color tables leak their names/swatches as plain text
    // once braces are stripped below (e.g. a custom-font text box otherwise
    // ends with "Futura-Medium;" glued onto its content) — drop the whole
    // group before that happens. Flat (non-nested) in every sample seen.
    .replace(/\{\\fonttbl[^{}]*\}/g, '')
    .replace(/\{\\colortbl[^{}]*\}/g, '')
    .replace(/\{\\\*[^}]*\}/g, '')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    // RTF's compact line-break form: a bare backslash immediately followed by
    // a literal newline (as opposed to the \line keyword above).
    .replace(/\\\r?\n/g, '\n')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .trim();
}

// ── Plain text ────────────────────────────────────────────────────────────
// A blank line starts a new slide — the convention every worship team already
// uses when they email lyrics.
function fromText(text) {
  const blocks = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(chunk => chunk.split('\n').map(l => l.trim()).filter(Boolean))
    .filter(lines => lines.length);
  return blocks.map((lines, i) => ({ label: `Slide ${i + 1}`, lines }));
}

// ── DOCX ──────────────────────────────────────────────────────────────────
// Each <w:p> is a paragraph; empty paragraphs act as the slide separator.
function fromDocx(buf) {
  const files = unzip(buf, /^word\/document\.xml$/);
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('no document.xml — is this really a .docx?');
  const doc = xml.toString('utf8');

  const paras = [...doc.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(m => {
    const runs = [...m[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(t => decode(t[1]));
    return runs.join('').trim();
  });

  return fromText(paras.join('\n'));
}

// ── PPTX ──────────────────────────────────────────────────────────────────
// One slide per slideN.xml, ordered numerically. <a:p> is a paragraph within a
// text body, which maps cleanly onto a line.
function fromPptx(buf) {
  const files = unzip(buf, /^ppt\/slides\/slide\d+\.xml$/);
  if (!files.size) throw new Error('no slides found — is this really a .pptx?');

  const names = [...files.keys()].sort((a, b) => {
    const n = s => parseInt((s.match(/slide(\d+)\.xml$/) || [])[1] || '0', 10);
    return n(a) - n(b);
  });

  const blocks = [];
  names.forEach((name, i) => {
    const xml = files.get(name).toString('utf8');
    const lines = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map(p => [...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map(t => decode(t[1])).join('').trim())
      .filter(Boolean);
    if (lines.length) blocks.push({ label: `Slide ${i + 1}`, lines });
  });
  return blocks;
}

// ── ProPresenter 6 ────────────────────────────────────────────────────────
// .pro6 is XML whose slide text is base64-wrapped RTF. We pull the RTF out and
// strip control words; formatting is discarded, which is fine because the text
// is about to be re-rendered by Kairo's own theme anyway.
function fromPro6(buf) {
  const xml = buf.toString('utf8');
  const chunks = [...xml.matchAll(/RTFData="([^"]+)"/g)].map(m => m[1]);
  if (!chunks.length) throw new Error('no slide text found in this ProPresenter file');

  const blocks = [];
  chunks.forEach((b64, i) => {
    let rtf = '';
    try { rtf = Buffer.from(b64, 'base64').toString('utf8'); } catch { return; }
    const lines = rtfToText(rtf).split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length) blocks.push({ label: `Slide ${i + 1}`, lines });
  });
  if (!blocks.length) throw new Error('slide text could not be decoded');
  return blocks;
}

// ── ProPresenter 7 ────────────────────────────────────────────────────────
// .pro (and occasionally .pro7) is a protobuf message — undocumented by
// Renewed Vision, no .proto schema published. Reverse-engineered from real
// exported files by walking the wire format generically (see readMessage
// below) rather than hardcoding field numbers wherever avoidable, since
// those are the part most likely to drift across app versions.
//
// What held true across every sample file inspected: slide text is stored
// as RTF (identical wrapping to .pro6's RTFData) inside some text element
// buried arbitrarily deep in a Cue's subtree — so instead of modeling the
// full Element/geometry/font schema (which we don't need), we recursively
// scan each Cue's bytes for any length-delimited field whose content starts
// with the literal "{\rtf" signature and decode just that.
//
// Top-level layout that DID stay stable and IS load-bearing here:
//   [3]  presentation name (string)
//   [12] the active arrangement — repeated field 2 (each a nested UUID) is
//        the *playback* order of cues; field 1 is the arrangement's own
//        identity and must be excluded or it reads as a phantom extra cue
//   [13] Cue messages, repeated at the top level — one per slide, but NOT
//        necessarily stored in playback order (arrangement is authoritative
//        when present; falls back to this raw order otherwise)
//        each Cue: [1] = { [1]: uuid string }, [8] = optional custom label

// Minimal protobuf wire-format reader. Returns null (never throws) on
// anything that doesn't parse as a valid message — used both to walk real
// submessages and, deliberately, to fail closed on opaque leaves (media
// bytes, thumbnails) that happen to also be length-delimited fields.
function pbFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = pbVarint(buf, pos);
    if (!tag) return null;
    pos = tag[1];
    const num  = tag[0] >>> 3;
    const wire = tag[0] & 7;
    if (num === 0) return null;
    if (wire === 0) {
      const v = pbVarint(buf, pos);
      if (!v) return null;
      pos = v[1];
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return null;
      pos += 8;
    } else if (wire === 2) {
      const len = pbVarint(buf, pos);
      if (!len) return null;
      const [n, afterLen] = len;
      if (n < 0 || afterLen + n > buf.length) return null;
      fields.push({ num, wire, raw: buf.slice(afterLen, afterLen + n) });
      pos = afterLen + n;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return null;
      pos += 4;
    } else {
      return null; // group wire types (3/4) — not used by this format
    }
  }
  return fields;
}

function pbVarint(buf, pos) {
  let result = 0, shift = 0, p = pos;
  while (true) {
    if (p >= buf.length) return null;
    const b = buf[p++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) return null; // pathological input, not a real tag/length
  }
  return [result, p];
}

function pbFirst(fields, num) { return fields.find(f => f.num === num); }

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// Fetches fields[num] as a nested message, then that message's fields[1] as a
// UUID-shaped string. Matches the `{ [N]: { [1]: uuidString } }` identity
// wrapper ProPresenter uses everywhere (cue refs, arrangement refs, cue's own id).
function pbNestedUuid(fields, num) {
  const wrapper = pbFirst(fields, num);
  if (!wrapper || wrapper.wire !== 2) return null;
  const inner = pbFields(wrapper.raw);
  const strField = inner && pbFirst(inner, 1);
  if (!strField || strField.wire !== 2) return null;
  const s = strField.raw.toString('utf8');
  return UUID_RE.test(s) ? s : null;
}

// Order cues should play in, per the presentation's active arrangement.
// Returns null if the arrangement isn't in the expected shape so the caller
// can fall back to raw Cue appearance order.
function pro7ArrangementOrder(rootFields) {
  const arrangement = pbFirst(rootFields, 12);
  if (!arrangement || arrangement.wire !== 2) return null;
  const sub = pbFields(arrangement.raw);
  if (!sub) return null;
  const uuids = [];
  for (const f of sub) {
    if (f.wire !== 2 || f.num !== 2) continue; // field 1 is the arrangement's own id, not a cue ref
    const inner = pbFields(f.raw);
    const uuid = inner && pbNestedUuid(inner, 1);
    if (uuid) uuids.push(uuid);
  }
  return uuids.length ? uuids : null;
}

// Recursively collects every RTF-wrapped string found anywhere under `buf`,
// decoded to plain text lines, in encounter order. A slide is typically
// built from 2-3 separate small text boxes (e.g. reference + verse number +
// body) — this flattens all of them into one block's lines, same as the
// pro6/pptx importers already do without trying to reconstruct layout.
function pbCollectRtfLines(buf, out) {
  const fields = pbFields(buf);
  if (!fields) return;
  for (const f of fields) {
    if (f.wire !== 2) continue;
    if (f.raw.length >= 5 && f.raw.slice(0, 5).toString('latin1') === '{\\rtf') {
      const text = rtfToText(f.raw.toString('utf8'));
      if (text) out.push(...text.split('\n').map(l => l.trim()).filter(Boolean));
      continue; // an RTF blob is never also a nested submessage worth descending into
    }
    pbCollectRtfLines(f.raw, out);
  }
}

function fromPro7(buf) {
  const rootFields = pbFields(buf);
  if (!rootFields) throw new Error('could not parse this ProPresenter 7 file');

  const cueOrder = pro7ArrangementOrder(rootFields);
  const cuesByUuid = new Map();
  const rawOrder = [];

  for (const f of rootFields) {
    if (f.num !== 13 || f.wire !== 2) continue;
    const cueFields = pbFields(f.raw);
    if (!cueFields) continue;
    const uuid = pbNestedUuid(cueFields, 1);
    const labelField = pbFirst(cueFields, 8);
    const label = labelField && labelField.wire === 2 ? labelField.raw.toString('utf8').trim() : '';
    const lines = [];
    pbCollectRtfLines(f.raw, lines);
    const entry = { label, lines };
    if (uuid) cuesByUuid.set(uuid, entry);
    rawOrder.push(entry);
  }

  const ordered = (cueOrder && cueOrder.length)
    ? cueOrder.map(u => cuesByUuid.get(u)).filter(Boolean)
    : rawOrder;

  const blocks = [];
  for (const cue of ordered) {
    if (!cue.lines.length) continue; // media-only/blank cues have nothing presentable
    blocks.push({ label: cue.label || `Slide ${blocks.length + 1}`, lines: cue.lines });
  }
  if (!blocks.length) throw new Error('no slide text found in this ProPresenter 7 file');
  return blocks;
}

// Both .pro6 (XML) and .pro7 (protobuf) currently ship under the same .pro
// extension, so the two are told apart by content, not by name.
function looksLikePro6Xml(buf) {
  const head = buf.slice(0, 200).toString('latin1');
  return /^\s*<\?xml/.test(head) || head.includes('RVPresentationDocument');
}

function parsePresentationBuffer(buf) {
  return looksLikePro6Xml(buf) ? fromPro6(buf) : fromPro7(buf);
}

// ── ProPresenter bundle (.probundle) ──────────────────────────────────────
// A bundle is just a zip of one presentation plus the media it references,
// media stored under its original absolute path. We only need the
// presentation; the linked media isn't something Kairo re-renders.
function fromProBundle(buf) {
  const files = unzip(buf, /\.pro6?$/i);
  const entries = [...files.entries()].filter(([name]) => /\.pro6?$/i.test(name));
  if (!entries.length) throw new Error('no presentation found in this ProPresenter bundle');
  // If more than one somehow made it in, the root-most (shortest path) one
  // is the actual bundled presentation rather than an incidental extra.
  entries.sort((a, b) => a[0].length - b[0].length);
  return parsePresentationBuffer(entries[0][1]);
}

// ── ProPresenter playlist (.proplaylist) ──────────────────────────────────
// A zip containing every presentation the playlist references (flattened to
// the archive root, regardless of the Libraries/... path recorded inside the
// manifest) plus a `data` file — a protobuf manifest of the playlist's own
// folder/name structure. Reverse-engineered the same way as fromPro7: walk
// generically for the `{ [1]: uuid, [2]: name, [4]: fileRef }` shape rather
// than hardcoding the exact folder nesting depth, since a playlist can be a
// single flat list or (in principle) contain nested playlist folders.
function pro7FileRefRelPath(buf) {
  const fields = pbFields(buf);
  if (!fields) return null;
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const inner = pbFields(f.raw);
    if (!inner) continue;
    const relField = pbFirst(inner, 4);
    if (!relField || relField.wire !== 2) continue;
    const relInner = pbFields(relField.raw);
    const pathField = relInner && pbFirst(relInner, 2);
    if (pathField && pathField.wire === 2) return pathField.raw.toString('utf8');
  }
  return null;
}

function walkPlaylistManifest(fields, out) {
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const sub = pbFields(f.raw);
    if (!sub) continue;
    const nameField = pbFirst(sub, 2);
    const fileRefField = pbFirst(sub, 4);
    if (nameField && nameField.wire === 2 && fileRefField) {
      const relPath = pro7FileRefRelPath(fileRefField.raw);
      if (relPath) { out.push({ name: nameField.raw.toString('utf8'), relPath }); continue; }
    }
    walkPlaylistManifest(sub, out); // folders, the playlist's own header, etc.
  }
}

function fromProPlaylist(buf) {
  const files = unzip(buf, /(^|\/)data$|\.pro6?$/i);
  const manifest = files.get('data');
  if (!manifest) throw new Error('no playlist data found in this ProPresenter playlist');
  const manifestFields = pbFields(manifest);
  if (!manifestFields) throw new Error('could not parse this ProPresenter playlist');

  const items = [];
  walkPlaylistManifest(manifestFields, items);
  if (!items.length) throw new Error('this ProPresenter playlist has no items');

  const byBasename = new Map();
  for (const [name, content] of files) {
    if (!/\.pro6?$/i.test(name)) continue;
    byBasename.set(name.split('/').pop().toLowerCase(), content);
  }

  const presentations = [];
  for (const item of items) {
    const base = (item.relPath ? item.relPath.split('/').pop() : `${item.name}.pro`).toLowerCase();
    const proBuf = byBasename.get(base) || byBasename.get(`${item.name}.pro`.toLowerCase());
    if (!proBuf) continue; // referenced presentation wasn't included in this export
    try {
      const blocks = parsePresentationBuffer(proBuf);
      if (blocks.length) presentations.push({ name: item.name, blocks });
    } catch { /* skip presentations we can't read rather than failing the whole playlist */ }
  }
  if (!presentations.length) throw new Error('could not read any presentations from this playlist');
  return presentations;
}

function importSlides(filename, buf) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  switch (ext) {
    case 'txt':
    case 'md':
    case 'json':
      return { format: 'text', blocks: fromText(buf.toString('utf8')) };
    case 'docx':
      return { format: 'docx', blocks: fromDocx(buf) };
    case 'pptx':
      return { format: 'pptx', blocks: fromPptx(buf) };
    case 'pro6':
    case 'pro':
    case 'pro7':
      // .pro6 and .pro7 both currently ship under a plain .pro extension —
      // content, not the name, says which parser applies.
      return { format: looksLikePro6Xml(buf) ? 'pro6' : 'pro7', blocks: parsePresentationBuffer(buf) };
    case 'probundle':
      return { format: 'probundle', blocks: fromProBundle(buf) };
    case 'proplaylist':
      return { format: 'proplaylist', items: fromProPlaylist(buf) };
    case 'pdf':
      // PDF text extraction needs a real PDF parser; saying so beats returning
      // a mangled approximation of the slides.
      throw Object.assign(new Error('PDF import needs the pdfjs-dist package installed'), { code: 'PDF_UNSUPPORTED' });
    default:
      // Unknown extension: treat it as text rather than refusing outright.
      return { format: 'text', blocks: fromText(buf.toString('utf8')), note: `treated .${ext} as plain text` };
  }
}

module.exports = { importSlides, fromText };
