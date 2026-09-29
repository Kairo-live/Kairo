// Tests for src/layer_geometry.js's picture fills: how a background layer
// filled with a bundled (or the operator's own) picture is painted, and how a
// slide's own fill changes merge over its theme's. The file is a plain browser
// script, so it runs here against a stand-in `window`.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'layer_geometry.js'), 'utf8'), sandbox);
const { imageFillCss, withFillOverride } = sandbox.window;

test('a picture fill covers the box, over its loading colour', () => {
  const css = imageFillCss({ fill: 'image', src: 'backgrounds/midnight.jpg', color: '#1a2154' });
  assert.equal(css, 'url("backgrounds/midnight.jpg") center / cover no-repeat #1a2154');
});

test('darkening lays a shade over the picture, capped at 90%', () => {
  const css = imageFillCss({ src: 'backgrounds/ember.jpg', color: '#431a06', dim: 35 });
  assert.match(css, /^linear-gradient\(rgba\(0,0,0,0\.35\), rgba\(0,0,0,0\.35\)\), url\("backgrounds\/ember\.jpg"\)/);
  assert.match(imageFillCss({ src: 'x.jpg', dim: 400 }), /rgba\(0,0,0,0\.9\)/);
  assert.doesNotMatch(imageFillCss({ src: 'x.jpg', dim: 0 }), /linear-gradient/);
});

test('small renders take a bundled picture\'s thumbnail, and only a bundled one', () => {
  assert.match(imageFillCss({ src: 'backgrounds/ocean.jpg' }, { small: true }), /url\("backgrounds\/thumbs\/ocean\.jpg"\)/);
  assert.match(imageFillCss({ src: 'backgrounds/ocean.jpg' }), /url\("backgrounds\/ocean\.jpg"\)/);
  const own = 'data:image/jpeg;base64,AAAA';
  assert.match(imageFillCss({ src: own }, { small: true }), /url\("data:image\/jpeg;base64,AAAA"\)/);
});

test('a src cannot break out of its url()', () => {
  const css = imageFillCss({ src: 'a") red, url("b' });
  assert.equal(css.match(/"/g).length, 2);
  assert.match(css, /%22/);
  // A colour that isn't a hex colour falls back to black.
  assert.match(imageFillCss({ src: 'x.jpg', color: 'red; x' }), / #000$/);
});

test('a slide\'s fill changes merge over the theme\'s without touching it', () => {
  const theme = { id: 'bg', type: 'background', fill: 'gradient', color: '#0b0b0f', color2: '#1c1c30', angle: 160, opacity: 100 };
  assert.equal(withFillOverride(theme, {}), theme);
  assert.equal(withFillOverride(theme, null), theme);
  assert.equal(withFillOverride(theme, { fill: 'gradient' }), theme);
  const slide = withFillOverride(theme, { fill: 'image', src: 'backgrounds/royal.jpg', dim: 20, pos: { x: 1 } });
  assert.notEqual(slide, theme);
  assert.equal(slide.fill, 'image');
  assert.equal(slide.src, 'backgrounds/royal.jpg');
  assert.equal(slide.dim, 20);
  assert.equal(slide.pos, undefined, 'only fill fields merge');
  assert.equal(theme.fill, 'gradient', 'the theme layer is untouched');
});

test('an end time reads however it is typed, "9:30 a.m." included', () => {
  const { resolveFlexibleTime } = sandbox.window;
  assert.equal(resolveFlexibleTime('9:30 a.m.'), '09:30');
  assert.equal(resolveFlexibleTime('11:45 PM'), '23:45');
  assert.equal(resolveFlexibleTime('21:30'), '21:30');
  assert.equal(resolveFlexibleTime('9.30pm'), '21:30');
  assert.equal(resolveFlexibleTime('25:00'), null);
});

test('a slide\'s rotation, accent and photo look merge over the theme\'s; null takes one away', () => {
  const { withLayerOverride, animOverride } = sandbox.window;
  const theme = { id: 'photo', type: 'image', rotation: 0, grayscale: 100, fade: { side: 'left', amount: 60 }, build: { type: 'fade' } };
  assert.equal(withLayerOverride(theme, {}), theme);
  const slide = withLayerOverride(theme, { rotation: 12, grayscale: null, fade: { side: 'right', amount: 40 }, pos: { x: 1 } });
  assert.equal(slide.rotation, 12);
  assert.equal('grayscale' in slide, false, 'null removes the theme\'s value');
  assert.equal(JSON.stringify(slide.fade), JSON.stringify({ side: 'right', amount: 40 }));
  assert.equal(slide.pos, undefined, 'only the listed keys merge');
  assert.equal(theme.grayscale, 100, 'the theme layer is untouched');
  // Build-in and idle: the slide's own when it has one, null = none. (Objects
  // from the script's own context compare by value, not by prototype.)
  const plain = (o) => JSON.stringify(o);
  assert.equal(plain(animOverride(theme, {})), plain({ build: { type: 'fade' } }));
  assert.equal(plain(animOverride(theme, { build: null, idle: { type: 'float' } })), plain({ build: null, idle: { type: 'float' } }));
});
