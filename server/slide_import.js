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

// Caps a single decompressed zip entry — slide/presentation XML/protobuf
// members are at most a few MB in every real file; a crafted entry claiming
// a tiny compressed size but a huge decompressed size could otherwise
// exhaust server memory from one uploaded file.
const MAX_INFLATED_ENTRY_BYTES = 200 * 1024 * 1024;

// Bounds recursion depth when walking untrusted, deeply-nestable formats
// (ProPresenter's protobuf Cue trees). A legitimate slide is nested at most a
// few levels deep; this exists purely to stop a maliciously crafted file
// from stack-overflowing the process.
const MAX_WALK_DEPTH = 200;

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
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_ENTRY_BYTES }));
    } catch { /* skip unreadable/oversized member */ }
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

// Reads a run's actual authored text color straight out of the RTF, before
// rtfToText above deletes the \colortbl group and strips \cfN control words
// as part of producing plain text. Parses \colortbl's semicolon-separated
// \redN\greenN\blueN entries into an index->hex table, then resolves the
// first \cfN reference in the run against it. Returns null if there's no
// color table or no \cf reference at all (callers should fall back to
// whatever non-RTF color source they already have).
function firstRtfColor(rtf) {
  const tbl = /\{\\colortbl([^{}]*)\}/.exec(String(rtf || ''));
  if (!tbl) return null;
  const entries = tbl[1].split(';').map(entry => {
    const r = /\\red(\d+)/.exec(entry), g = /\\green(\d+)/.exec(entry), b = /\\blue(\d+)/.exec(entry);
    if (!r || !g || !b) return null;
    return '#' + [r[1], g[1], b[1]].map(v => Math.max(0, Math.min(255, +v)).toString(16).padStart(2, '0')).join('');
  });
  const cf = /\\cf(\d+)/.exec(rtf);
  if (!cf) return null;
  return entries[+cf[1]] || null;
}

// ── Section labels (ProPresenter-style annotation) ─────────────────────────
// Recognizes the same Verse/Chorus/Pre-Chorus/Bridge/Tag/etc. section
// markers ProPresenter itself annotates songs with — the convention most
// worship teams already type into their own lyric sheets, either as a bare
// line of its own ("Chorus" on one line, its lyrics on the next, a blank
// line between) or as the opening line of a block that also carries its
// lyrics ("Verse 1\nAmazing grace...", no blank line between). Matched
// loosely enough to catch "[Chorus]", "Chorus:", "CHORUS", "Verse 2" etc.
// without also matching an ordinary lyric line that happens to contain one
// of these words — it must be the WHOLE line, nothing else.
const SECTION_LABEL_RE = /^\[?\s*(verse\s*\d*|chorus|pre-?chorus|bridge|tag|outro|ending|intro|interlude|refrain|solo|vamp|breakdown)\s*\]?\s*:?\s*$/i;

function normalizeSectionLabel(line) {
  return line.replace(/[[\]:]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Most imports arrive as one block per slide already (PPTX slides, .pro6
// cues) — here the label, if present, is only ever the block's OWN first
// line (no separate label-only block to merge in). Returns
// { label, lines } with the marker line stripped when found, or null when
// the block doesn't open with one.
function extractLeadingSectionLabel(lines) {
  if (lines.length > 1 && SECTION_LABEL_RE.test(lines[0])) {
    return { label: normalizeSectionLabel(lines[0]), lines: lines.slice(1) };
  }
  return null;
}

// Freeform text (and anything routed through fromText, like .docx) can
// ALSO carry the label as its own separate blank-line-delimited block, one
// "Chorus" line with nothing else, followed by its lyrics as the NEXT
// block — a real, common shape for hand-typed lyric sheets. A bare label
// block never becomes its own (near-empty) slide; it's folded into
// whichever block follows it.
function applySectionLabels(blocks) {
  const out = [];
  let pendingLabel = null;
  for (const lines of blocks) {
    if (lines.length === 1 && SECTION_LABEL_RE.test(lines[0])) {
      pendingLabel = normalizeSectionLabel(lines[0]);
      continue;
    }
    const leading = extractLeadingSectionLabel(lines);
    const label = leading?.label || pendingLabel || `Slide ${out.length + 1}`;
    pendingLabel = null;
    out.push({ label, lines: leading?.lines || lines });
  }
  return out;
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
  return applySectionLabels(blocks);
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
    if (lines.length) {
      const leading = extractLeadingSectionLabel(lines);
      blocks.push(leading ? { label: leading.label, lines: leading.lines } : { label: `Slide ${i + 1}`, lines });
    }
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
    if (lines.length) {
      const leading = extractLeadingSectionLabel(lines);
      blocks.push(leading ? { label: leading.label, lines: leading.lines } : { label: `Slide ${i + 1}`, lines });
    }
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
//
// Every field type is recorded (not just wire-2/length-delimited) — theme_import.js
// needs varint/fixed64/fixed32 values (positions, sizes, colors) that the
// original .pro7 slide/text-only use of this reader never did. Safe for
// every existing caller here: they all explicitly check `f.wire !== 2`
// before touching `.raw`, so the extra varint/fixed32/fixed64 entries this
// now includes are simply skipped by code that never asked for them.
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
      fields.push({ num, wire, value: v[0] });
      pos = v[1];
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return null;
      fields.push({ num, wire, raw: buf.slice(pos, pos + 8) });
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
      fields.push({ num, wire, raw: buf.slice(pos, pos + 4) });
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
// Decodes `raw` as a message and returns its field-1 string if it's UUID-shaped.
function pbUuidString(raw) {
  const fields = pbFields(raw);
  const strField = fields && pbFirst(fields, 1);
  if (!strField || strField.wire !== 2) return null;
  const s = strField.raw.toString('utf8');
  return UUID_RE.test(s) ? s : null;
}

// fields[num] is a `{ [1]: uuidString }` wrapper — one level up from pbUuidString.
function pbNestedUuid(fields, num) {
  const wrapper = pbFirst(fields, num);
  if (!wrapper || wrapper.wire !== 2) return null;
  return pbUuidString(wrapper.raw);
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
    const uuid = pbUuidString(f.raw);
    if (uuid) uuids.push(uuid);
  }
  return uuids.length ? uuids : null;
}

// Recursively collects every RTF-wrapped string found anywhere under `buf`,
// decoded to plain text lines, in encounter order. A slide is typically
// built from 2-3 separate small text boxes (e.g. reference + verse number +
// body) — this flattens all of them into one block's lines, same as the
// pro6/pptx importers already do without trying to reconstruct layout.
function pbCollectRtfLines(buf, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  const fields = pbFields(buf);
  if (!fields) return;
  for (const f of fields) {
    if (f.wire !== 2) continue;
    if (f.raw.length >= 5 && f.raw.slice(0, 5).toString('latin1') === '{\\rtf') {
      const text = rtfToText(f.raw.toString('utf8'));
      if (text) out.push(...text.split('\n').map(l => l.trim()).filter(Boolean));
      continue; // an RTF blob is never also a nested submessage worth descending into
    }
    pbCollectRtfLines(f.raw, out, depth + 1);
  }
}

// Best-effort media detection — unlike RTF (a documented, stable "{\rtf"
// signature), there is no known field number or wrapper shape for how a Cue
// references its background image; this is genuinely unverified against a
// real sample file. Uses the same content-signature technique as RTF
// detection: a wire-type-2 field that decodes as a short, printable UTF-8
// string ending in a known image extension is assumed to be a file path
// (bundles store media "under its original absolute path" per fromProBundle
// below, so a plain path string is the plausible shape). Degrades silently —
// if this guess is wrong, no path is found and behavior is unchanged from
// before (no images), never worse.
const IMAGE_PATH_RE = /\.(?:jpe?g|png|gif|bmp|tiff?)$/i;
function looksLikeImagePath(raw) {
  if (raw.length < 5 || raw.length > 1024) return false; // real paths aren't RTF-blob-sized
  let s;
  try { s = raw.toString('utf8'); } catch { return false; }
  if (!IMAGE_PATH_RE.test(s)) return false;
  return !/[\x00-\x08\x0e-\x1f]/.test(s); // reject binary — real paths are plain text
}
function pbCollectMediaPaths(buf, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  const fields = pbFields(buf);
  if (!fields) return;
  for (const f of fields) {
    if (f.wire !== 2) continue;
    if (looksLikeImagePath(f.raw)) { out.push(f.raw.toString('utf8')); continue; }
    pbCollectMediaPaths(f.raw, out, depth + 1);
  }
}

// `resolveMedia`, when provided (only by fromProBundle — a standalone .pro/
// .pro6/.pro7 file has no accompanying zip of media to resolve against),
// maps a path found inside a Cue to a data: URL, or null if no matching zip
// entry was found.
function fromPro7(buf, resolveMedia) {
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
    let image = null;
    if (resolveMedia) {
      const paths = [];
      pbCollectMediaPaths(f.raw, paths);
      for (const p of paths) { image = resolveMedia(p); if (image) break; }
    }
    const entry = { label, lines, image };
    if (uuid) cuesByUuid.set(uuid, entry);
    rawOrder.push(entry);
  }

  const ordered = (cueOrder && cueOrder.length)
    ? cueOrder.map(u => cuesByUuid.get(u)).filter(Boolean)
    : rawOrder;

  const blocks = [];
  for (const cue of ordered) {
    // A pure-image cue (no text) used to be dropped entirely ("media-only
    // cues have nothing presentable") — now it surfaces as an image block.
    // A cue with BOTH text and an image keeps today's text-only behavior;
    // rendering the image as a background behind that same slide's text is
    // a follow-up once a real sample file confirms this reference shape is
    // actually correct, rather than compounding an unverified guess.
    if (!cue.lines.length && !cue.image) continue;
    if (!cue.lines.length && cue.image) {
      blocks.push({ label: cue.label || `Slide ${blocks.length + 1}`, lines: [], image: cue.image });
    } else {
      blocks.push({ label: cue.label || `Slide ${blocks.length + 1}`, lines: cue.lines });
    }
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

function parsePresentationBuffer(buf, resolveMedia) {
  // pro6 is plain XML with no reverse-engineered media reference at all
  // (only pro7's protobuf Cue tree has the content-signature media
  // detection above) — resolveMedia is a no-op for that path.
  return looksLikePro6Xml(buf) ? fromPro6(buf) : fromPro7(buf, resolveMedia);
}

const IMAGE_ENTRY_RE = /\.(?:jpe?g|png|gif|bmp|tiff?)$/i;
const IMAGE_MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };

// Builds a resolveMedia(path) => data:URL|null closure from every non-.pro
// zip entry that looks like an image, keyed by basename — a Cue's in-file
// path reference and the zip's own entry name won't necessarily share a full
// absolute-path prefix, but should share a basename (per fromProBundle's own
// comment: media is stored "under its original absolute path", i.e. the
// path recorded in the Cue is presumed to be that same original path).
function makeMediaResolver(files) {
  const byBasename = new Map();
  for (const [name, content] of files) {
    if (!IMAGE_ENTRY_RE.test(name)) continue;
    byBasename.set(name.split('/').pop().toLowerCase(), content);
  }
  if (!byBasename.size) return null;
  return (path) => {
    const base = String(path).split(/[\\/]/).pop().toLowerCase();
    const bytes = byBasename.get(base);
    if (!bytes) return null;
    const ext = (base.match(/\.(\w+)$/) || [, 'jpg'])[1].toLowerCase();
    const mime = IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  };
}

// ── ProPresenter bundle (.probundle) ──────────────────────────────────────
// A bundle is just a zip of one presentation plus the media it references,
// media stored under its original absolute path.
function fromProBundle(buf) {
  const files = unzip(buf, /\.pro6?$|\.(?:jpe?g|png|gif|bmp|tiff?)$/i);
  const entries = [...files.entries()].filter(([name]) => /\.pro6?$/i.test(name));
  if (!entries.length) throw new Error('no presentation found in this ProPresenter bundle');
  // If more than one somehow made it in, the root-most (shortest path) one
  // is the actual bundled presentation rather than an incidental extra.
  entries.sort((a, b) => a[0].length - b[0].length);
  return parsePresentationBuffer(entries[0][1], makeMediaResolver(files));
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

function walkPlaylistManifest(fields, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
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
    walkPlaylistManifest(sub, out, depth + 1); // folders, the playlist's own header, etc.
  }
}

function fromProPlaylist(buf) {
  const files = unzip(buf, /(^|\/)data$|\.pro6?$|\.(?:jpe?g|png|gif|bmp|tiff?)$/i);
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
  const resolveMedia = makeMediaResolver(files);

  const presentations = [];
  for (const item of items) {
    const base = (item.relPath ? item.relPath.split('/').pop() : `${item.name}.pro`).toLowerCase();
    const proBuf = byBasename.get(base) || byBasename.get(`${item.name}.pro`.toLowerCase());
    if (!proBuf) continue; // referenced presentation wasn't included in this export
    try {
      const blocks = parsePresentationBuffer(proBuf, resolveMedia);
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

module.exports = {
  importSlides, fromText,
  // Shared with theme_import.js (.protheme is the same zip-of-protobuf
  // family as .pro7/.probundle/.proplaylist) so the wire-format reader has
  // one implementation, not two drifting copies.
  unzip, pbFields, pbVarint, pbFirst, rtfToText, firstRtfColor, MAX_WALK_DEPTH,
};
