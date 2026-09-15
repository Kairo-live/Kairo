// KAIRO — ProPresenter Theme (.protheme) import
//
// .protheme is a zip bundle: one protobuf-encoded "Theme" document plus an
// Assets/ folder of referenced images. Same undocumented-format situation as
// .pro7/.probundle/.proplaylist (see slide_import.js's header comment) — no
// published .proto schema from Renewed Vision, reverse-engineered here from
// a real exported theme file by walking the wire format generically and
// cross-checking against the community-maintained (also reverse-engineered,
// also unofficial) https://github.com/greyshirtguy/ProPresenter7-Proto.
//
// What held true against the real sample inspected:
//   Theme file root:
//     [1]  ApplicationInfo (ignored — version metadata only)
//     [3]  repeated ThemeSlideEntry: { [1]: Slide, [2]: name (string, optional) }
//   Slide:
//     [1]  repeated Element
//     [6]  Size { [1]: width (fixed64 double), [2]: height (fixed64 double) }
//   Element (one level inside the repeated [1] wrapper):
//     [1]  UUID wrapper
//     [2]  role name (string, optional) — only present on ProPresenter's own
//          "smart" scripture-placeholder elements: confirmed values "verse",
//          "reference", "number" (a decorative section-number placeholder).
//          Absent on freeform text boxes an author typed manually.
//     [3]  Bounds { [1]: Point{x,y}, [2]: Point{w,h} } — all fixed64 doubles
//     [4]  rotation degrees (fixed64 double) — present only when non-zero
//     [9]  EITHER a Color { [1..4]: fixed32 R/G/B/A } for a shape/text fill,
//          OR (for an image) a media wrapper carrying a file:// URL plus a
//          relative "Assets/…" path — the shape actually present is what
//          tells them apart, there's no separate type tag we've found.
//          CONFIRMED against a real sample: on a text element this is a
//          byte-identical boilerplate/default value across every element in
//          every slide, NOT the actual authored text color — see [13][5].
//     [13] Text descriptor (only present on text elements):
//            [3] font: { [1]: { [1]: postscript name, [2]: size in points,
//                                [9]: display name } }
//            [5] RTF-wrapped rich text (see rtfToText in slide_import.js) —
//                this, not [9], is where the real per-run text color lives
//                (a standard \colortbl + \cfN reference; see firstRtfColor
//                in slide_import.js, read from the raw RTF before rtfToText
//                strips it for plain-text extraction).
//            [12] a single wire-2 sub-field one level deeper than a flat
//                 Color — despite looking Color-shaped, it does not decode
//                 as {1..4: fixed32} in practice and is not read by anything.
//
// proto3 omits any field left at its zero value entirely — a Color with
// r=g=b=0 and a=1 serializes as just `{4: 1.0}`. rgbaFromColor below treats
// every absent channel as 0, which is exactly right for color channels but
// means a genuinely-transparent (alpha=0) color is indistinguishable from
// "alpha not set" — defaults to opaque (1) in that case since a theme
// silently rendering fully invisible is a worse failure than a wrong-but-
// visible one.
//
// A handful of sub-structures (border, shadow, outline-width defaults) were
// byte-for-byte identical across every element in the sample file regardless
// of that element's actual appearance — almost certainly just the
// schema's zero-value defaults for features this particular theme never
// turned on, not real per-element style. They're deliberately not decoded;
// noted as a limitation rather than guessed at.
'use strict';

const {
  unzip, pbFields, pbFirst, rtfToText, firstRtfColor, MAX_WALK_DEPTH,
} = require('./slide_import.js');

function num(fields, n, fallback = 0) {
  const f = fields && pbFirst(fields, n);
  if (!f) return fallback;
  if (f.wire === 1) return f.raw.readDoubleLE(0);
  if (f.wire === 5) return f.raw.readFloatLE(0);
  if (f.wire === 0) return f.value;
  return fallback;
}
function str(fields, n) {
  const f = fields && pbFirst(fields, n);
  return f && f.wire === 2 ? f.raw.toString('utf8') : null;
}
function sub(fields, n) {
  const f = fields && pbFirst(fields, n);
  if (!f || f.wire !== 2) return null;
  return pbFields(f.raw);
}

// { [1..4]: fixed32 R/G/B/A } → { hex: "#rrggbb", opacity: 0-100 }. Any
// channel proto3 omitted (its zero value) reads as 0, except alpha which
// defaults to fully opaque — see the file-header note on why.
function rgbaFromColorFields(fields) {
  if (!fields) return null;
  const r = num(fields, 1, 0), g = num(fields, 2, 0), b = num(fields, 3, 0);
  const aField = pbFirst(fields, 4);
  const a = aField ? num(fields, 4, 1) : 1;
  const clamp255 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  const hex = '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
  return { hex, opacity: Math.round(Math.max(0, Math.min(1, a)) * 100) };
}

// Confirmed via a real sample: element field [9]'s Color is byte-identical
// (#2196f2) across EVERY element in EVERY slide, text or shape, regardless
// of that element's actual appearance — a schema/boilerplate default, not a
// real authored color (see the file header). Text elements already prefer
// the RTF's own color over this; shape/background elements have no such
// alternative source, so any element whose ONLY color signal is exactly
// this value is treated as not having a real fill at all, rather than
// rendered as a solid blue rectangle that was never part of the design.
const BOILERPLATE_FILL_HEX = '#2196f2';

// A fill is stored one level deeper than the element itself: field 9 is a
// wrapper whose OWN field holds the real Color message — but which field
// number wraps it varies (seen at both 1 and 3 in the same real theme,
// presumably different oneof branches of the same "Fill" shape) — so this
// scans every wire-2 child for one that decodes as a Color (only ever
// fields 1-4, all fixed32) rather than assuming a fixed field number.
function firstColorLike(fields) {
  if (!fields) return null;
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const inner = pbFields(f.raw);
    if (inner && inner.length && inner.every(x => x.wire === 5 && x.num >= 1 && x.num <= 4)) {
      return rgbaFromColorFields(inner);
    }
  }
  return null;
}

// Bounds → { x, y, w, h }, rescaled from the source theme-slide's own canvas
// into KAIRO's fixed 1920x1080 design space (see design_space.js /
// KAIRO_DESIGN_W/H) — layer.pos is ALWAYS interpreted as a fraction of that
// fixed space regardless of a theme's own canvasSize (canvasSize is purely
// a preview-shape hint, see themeCanvasSize in app.js). Passing raw
// source-canvas pixels straight through was correct by coincidence for a
// 1920x1080 slide and silently wrong for anything else (e.g. a 1440x900
// "confidence monitor" theme slide rendered squeezed into a corner).
function boundsFromFields(fields, scaleX, scaleY) {
  const origin = sub(fields, 1);
  const size   = sub(fields, 2);
  // The source Bounds is the element's PRE-rotation box, in its own natural
  // (unrotated) orientation — returned as-is, unmodified by rotation. Every
  // renderer (Theme Studio's canvas, display.html's live output) already
  // applies `transform: rotate(layer.rotation deg)` directly to this exact
  // box, and CSS rotation inherently makes a box occupy the correct swapped
  // on-screen footprint around its own center — there is nothing left for
  // this function to pre-compute. An earlier version of this function tried
  // to ALSO swap w/h and recenter here for a 90°/270° rotation, reasoning
  // that the source Bounds "hangs off-canvas" unrotated — true, but that's
  // exactly what the CSS transform already corrects for at render time;
  // adding a second correction here double-transformed the box (confirmed
  // via a real reported repro: the rotated element ended up mispositioned
  // and cropped, worse than doing nothing) — reverted.
  return {
    x: Math.round(num(origin, 1, 0) * scaleX),
    y: Math.round(num(origin, 2, 0) * scaleY),
    w: Math.round(num(size, 1, 0) * scaleX),
    h: Math.round(num(size, 2, 0) * scaleY),
  };
}

// RTF's paragraph-alignment control word — \qc/\qr/\qj appear once near the
// top of the run (see rtfToText's caller); default (no control word at all)
// is left per the RTF spec, so that's the fallback here too rather than
// guessing 'center' for a theme that simply never states an alignment.
function alignFromRtf(rtf) {
  if (/\\qr\b/.test(rtf)) return 'right';
  if (/\\qc\b/.test(rtf)) return 'center';
  if (/\\qj\b/.test(rtf)) return 'justify';
  return 'left';
}

// Fallback only for text elements with no element-role name at field [2]
// (see decodeElement) — freeform text boxes an author typed manually rather
// than one of ProPresenter's own "verse"/"reference" scripture placeholders.
// A Bible/song reference line reads distinctly from body text: short, no
// sentence punctuation, usually a book name + chapter/verse or all-caps
// title. Good enough to steer which KAIRO binding a text element gets when
// there's no more reliable signal to go on.
const REFERENCE_RE = /^[A-Z0-9][A-Z0-9 .:\-'"()]{1,48}$/;
function looksLikeReference(text) {
  const t = text.trim();
  if (!t || t.length > 50) return false;
  if (/[a-z]/.test(t)) return false; // body text is virtually never all-caps in these themes
  return REFERENCE_RE.test(t);
}

// One <Element> (already unwrapped from its outer { [1]: this, [4]: …, [9]: … }
// carrier) → a KAIRO layer, or null if it's not something worth importing
// (an empty placeholder shape with no fill, no text, no media — see the
// textDesc-but-empty check below).
//
// `staticText` — false (default) for .protheme import: role === 'verse'/
// 'reference' at field [2] correctly means "leave this bound to whatever
// scripture is live" for a THEME meant to be reused. true for a live
// PRESENTATION import (slide_import.js's own fromPro7 scene extraction,
// added later): confirmed against a real presentation that ProPresenter
// reuses those exact same internal placeholder names ("verse"/"reference")
// as its generic primary/secondary-text-box roles on ORDINARY slides that
// have nothing to do with scripture (a plain announcement slide's body
// text box decoded with role 'verse') — binding it live would replace the
// preacher's actual authored words with whatever verse Kairo happens to
// detect, exactly backwards from "preserve this file's real content."
// staticText forces every text element's real authored text through as
// static customText regardless of role, which is what an already-written,
// one-off presentation needs.
function decodeElement(elFields, mediaByBasename, scaleX, scaleY, warnings, staticText = false) {
  const rotation = num(elFields, 4, 0);
  const bounds = boundsFromFields(sub(elFields, 3) || [], scaleX, scaleY);

  const fillFields = sub(elFields, 9);
  const media = sub(fillFields, 3); // present only on image elements
  const textDesc = sub(elFields, 13);
  const fontSub = textDesc && sub(textDesc, 3);
  const rtfField = textDesc && pbFirst(textDesc, 5);
  const rtf = rtfField && rtfField.wire === 2 ? rtfField.raw.toString('utf8') : '';
  const text = rtf ? rtfToText(rtf) : '';

  // ── Image element ──
  if (media) {
    const fileRef = sub(media, 2);
    const rel = sub(fileRef, 4);
    const relPath = str(rel, 2);
    const base = relPath ? relPath.split('/').pop().toLowerCase() : null;
    const bytes = base ? mediaByBasename.get(base) : null;
    if (!bytes) {
      warnings.push(`Couldn't find the image asset "${relPath || '(unknown)'}" inside the .protheme bundle — that element was skipped.`);
      return null;
    }
    const ext = (base.match(/\.(\w+)$/) || [, 'jpg'])[1].toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' }[ext] || 'application/octet-stream';
    return {
      id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      type: 'image', name: 'Image', visible: true,
      src: `data:${mime};base64,${bytes.toString('base64')}`,
      fit: 'cover', opacity: 100, radius: 0,
      rotation: rotation || 0,
      pos: bounds,
    };
  }

  // NOTE: field 13 (textDesc) turned out to be present on every element
  // regardless of type — even the plain full-canvas background rect carries
  // the same default/empty text-descriptor boilerplate — so its presence
  // alone can't distinguish "a real text element with nothing typed in it"
  // from "a shape that was never a text element to begin with". An earlier
  // version of this function skipped any element with textDesc-but-no-text,
  // which silently ate the legitimate background fill on every sample slide
  // (it has one too). Left unresolved rather than guessed at again — see
  // decodeSlide's own warning when no full-canvas fill is found at all.

  // ── Full-canvas, text-free element with a plain color → background ──
  // (see file header: proto3's zero-omission means an all-zero color still
  // decodes correctly here, it just carries no explicit fields.)
  const rgba = firstColorLike(fillFields);

  // ── Text element ──
  if (text) {
    const font = sub(fontSub, 1);
    const fontSize = num(font, 2, 36) || 36;
    const family = str(font, 9) || str(font, 1) || 'Manrope';
    const paragraph = sub(fontSub, 6);
    const leadingPts = num(paragraph, 12, 0);
    // scaleY, not the geometric mean of both axes — line spacing is a
    // vertical measure, same reasoning as font size below.
    const lineHeight = leadingPts > 0 ? Math.round((leadingPts / fontSize) * 100) / 100 : 1.3;
    // ProPresenter's own "smart" placeholder elements (its built-in scripture
    // template) name the element itself at field [2] — "verse", "reference",
    // "number" confirmed against a real sample — an exact match for KAIRO's
    // own binding vocabulary where present, and a much more reliable signal
    // than guessing from text content alone. Freeform text boxes an author
    // typed manually carry no such name, so this falls back to the existing
    // content heuristic in that case. "number" (a decorative section-number
    // placeholder, e.g. "1.") maps to neither verse nor reference — treated
    // as static custom text rather than left to the heuristic, which was
    // confirmed to misclassify short numeric/punctuation text like "1." as a
    // scripture reference.
    const role = str(elFields, 2);
    const binding = staticText ? 'custom'
      : role === 'verse' ? 'verse'
      : role === 'reference' ? 'reference'
      : role === 'number' ? 'custom'
      : looksLikeReference(text) ? 'reference' : 'custom';
    return {
      id: 'text-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      type: 'text', name: binding === 'reference' ? 'Reference' : binding === 'verse' ? 'Verse' : 'Text', visible: true,
      binding, customText: binding === 'custom' ? text : '',
      // Font size scales with the vertical axis (matches how type size is
      // conventionally tied to a design's height, not its width) so a
      // theme-slide authored for a 900pt-tall canvas reads at the same
      // relative size once normalized into KAIRO's 1080-tall design space.
      font: { family, size: Math.round(fontSize * scaleY), weight: 500, italic: false, lineHeight, letterSpacing: 0, transform: 'none' },
      // The real authored text color lives in the RTF's own \colortbl/\cfN —
      // element field [9]'s Color turned out to be a byte-identical, boilerplate
      // value across every element in every slide of the real sample tested
      // (not the theme's actual color), so it's now only a fallback for RTF
      // with no color info at all, not the primary source.
      color: firstRtfColor(rtf) || (rgba && rgba.hex !== BOILERPLATE_FILL_HEX ? rgba.hex : null) || '#ffffff', opacity: (rgba && rgba.opacity) ?? 100,
      align: alignFromRtf(rtf),
      shadow: { enabled: false, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
      outline: { enabled: false, color: '#000000', width: 2 },
      pos: bounds,
    };
  }

  // No text, no media — a plain color rectangle. Full-canvas ones become the
  // slide's background; smaller ones are still imported as a positioned
  // shape (a design accent bar/panel), matching KAIRO's own Shape layer.
  // Confirmed boilerplate fill (see BOILERPLATE_FILL_HEX) — not a real shape.
  if (!rgba || rgba.hex === BOILERPLATE_FILL_HEX) return null;
  return { rgbaOnly: true, bounds, rgba, rotation };
}

function decodeSlide(slideFields, name, mediaByBasename, warnings, staticText = false) {
  const size = sub(slideFields, 6);
  const canvasW = Math.round(num(size, 1, 1920)) || 1920;
  const canvasH = Math.round(num(size, 2, 1080)) || 1080;
  // Every position/size (and font size, see decodeElement) is rescaled by
  // this into KAIRO's fixed 1920x1080 design space — 1:1 (scale of 1) for
  // the common case where the theme-slide already IS 1920x1080.
  const scaleX = 1920 / canvasW;
  const scaleY = 1080 / canvasH;

  const elementWrappers = (slideFields || []).filter(f => f.num === 1 && f.wire === 2);
  const decoded = [];
  for (const wrapper of elementWrappers) {
    const outer = pbFields(wrapper.raw);
    const elFields = sub(outer, 1);
    if (!elFields) continue;
    const layer = decodeElement(elFields, mediaByBasename, scaleX, scaleY, warnings, staticText);
    if (layer) decoded.push({ layer, bounds: layer.rgbaOnly ? layer.bounds : layer.pos });
  }

  // Whichever plain-color rect covers the most of the (already-rescaled,
  // so always effectively 1920x1080) canvas becomes the background; if none
  // does, fall back to a plain black canvas rather than leaving the theme
  // with no background layer at all (KAIRO themes always have one).
  //
  // Images and text are collected separately and reassembled images-then-
  // text (see below) rather than kept in raw element order — element order
  // in the sample file paints an image element AFTER its slide's text
  // (photo fully covering the text it was clearly meant to sit behind),
  // which reads as a real ordering bug in either the source or this
  // reverse-engineered reader, not an intentional "photo on top" design.
  let bgLayer = null;
  let bgArea = -1;
  const imageLayers = [];
  const otherLayers = [];
  for (const { layer, bounds } of decoded) {
    if (layer && layer.rgbaOnly) {
      const area = Math.max(0, bounds.w) * Math.max(0, bounds.h);
      const coversMost = bounds.w >= 1920 * 0.9 && bounds.h >= 1080 * 0.9;
      if (coversMost && area > bgArea) {
        if (bgLayer) otherLayers.push(bgLayer); // an earlier "full canvas" guess turned out not to be the biggest — demote it to a shape
        bgArea = area;
        bgLayer = {
          id: 'bg-' + Date.now(), type: 'background', name: 'Canvas', visible: true,
          fill: 'solid', color: layer.rgba.hex, opacity: layer.rgba.opacity,
        };
      } else {
        otherLayers.push({
          id: 'shape-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          type: 'background', name: 'Shape', visible: true,
          fill: 'solid', color: layer.rgba.hex, opacity: layer.rgba.opacity, radius: 0,
          rotation: layer.rotation || 0,
          pos: bounds,
        });
      }
    } else if (layer && layer.type === 'image') {
      imageLayers.push(layer);
    } else if (layer) {
      otherLayers.push(layer);
    }
  }
  const layers = [...imageLayers, ...otherLayers];
  if (!bgLayer) {
    bgLayer = { id: 'bg-' + Date.now(), type: 'background', name: 'Canvas', visible: true, fill: 'solid', color: '#000000', opacity: 100 };
    warnings.push(`"${name}" had no full-canvas fill in the original theme — imported with a plain black background.`);
  }

  return {
    id: 'protheme-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    name,
    layout: 'fullscreen', animation: 'fade',
    canvasSize: { w: canvasW, h: canvasH },
    layers: [bgLayer, ...layers],
  };
}

// Images live in the bundle under Assets/<name>, referenced from inside the
// Theme protobuf by a relative path recorded at import time on the machine
// that made the export — only the basename is trustworthy across machines,
// same reasoning as slide_import.js's makeMediaResolver.
const IMAGE_ENTRY_RE = /\.(?:jpe?g|png|gif|bmp|tiff?)$/i;
function mediaMap(files) {
  const map = new Map();
  for (const [name, content] of files) {
    if (!IMAGE_ENTRY_RE.test(name)) continue;
    map.set(name.split('/').pop().toLowerCase(), content);
  }
  return map;
}

function fromProTheme(buf) {
  const files = unzip(buf, /(^|\/)Theme$|\.(?:jpe?g|png|gif|bmp|tiff?)$/i);
  const themeEntry = [...files.keys()].find(n => /(^|\/)Theme$/.test(n));
  if (!themeEntry) throw new Error('no Theme document found in this .protheme bundle');

  const rootFields = pbFields(files.get(themeEntry));
  if (!rootFields) throw new Error('could not parse this ProPresenter theme (unrecognized format)');

  const slideEntries = rootFields.filter(f => f.num === 3 && f.wire === 2);
  if (!slideEntries.length) throw new Error('this ProPresenter theme has no slides');

  const byBasename = mediaMap(files);
  const warnings = [];
  const themes = [];
  slideEntries.forEach((entry, i) => {
    const fields = pbFields(entry.raw);
    const slideFields = sub(fields, 1);
    if (!slideFields) return;
    const name = str(fields, 2) || `Theme Slide ${i + 1}`;
    try {
      themes.push(decodeSlide(slideFields, name, byBasename, warnings));
    } catch (err) {
      warnings.push(`Skipped "${name}" — could not be read (${err.message}).`);
    }
  });

  if (!themes.length) throw new Error('none of this theme’s slides could be read');
  return { themes, warnings };
}

module.exports = {
  fromProTheme,
  // Shared with slide_import.js's own .pro7 presentation reader — a live
  // Cue's own slide content turns out to be the exact same Slide message
  // shape ([1] repeated Element, [6] Size) a .protheme's ThemeSlideEntry
  // uses, confirmed directly against a real presentation file. Real layer
  // fidelity (position/font/color/images) for an imported presentation
  // reuses this decoder rather than a second, parallel implementation.
  decodeSlide, mediaMap,
};
