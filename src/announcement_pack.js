// KAIRO — the Announcements pack: pre-service slides in one visual language —
// a dark teal slide with soft moving light and film grain, heavy two-tone
// headlines that arrive word by word and keep drifting, a washed-back photo,
// hand-drawn lines and arrows that draw themselves on. Every element is an
// ordinary layer, so everything is editable in Theme Studio: the copy (double-
// click it on the canvas), the colours, the photo (Replace…), each line's
// shape and colour, what arrives when, and how it moves.
//
// The same designs are used two ways:
//   • Theme Studio lists each one as a built-in theme (the Announcements
//     group), to use on a Slides item like any theme;
//   • the Timer tab's "+ Pre-service loop" makes a countdown segment whose
//     scenes are these slides, paced by the countdown (KairoMotion.sceneAt:
//     the shorter the countdown, the faster they change), each carrying the
//     countdown itself — a large, faded number up the right edge that the
//     copy shines through. The last slide, Service Begins, holds the final
//     minute with the countdown full size inside a progress ring.
(function (root) {
  'use strict';

  const PAL = {
    bg1: '#1d3b3f', bg2: '#0c2023', gold: '#e3cf6c', cream: '#f3ead3',
    pink: '#f0b9d4', ink: '#10262a', light1: '#5f9096', light2: '#2f6269',
  };
  const W = 1920, H = 1080;

  // Stand-in photos (abstract, so they read as photography once washed back
  // in black & white) — swap in real ones with the image layer's Replace….
  // Apostrophes encoded too: renderers drop these into CSS url('…').
  const svg = (s) => 'data:image/svg+xml;utf8,' + encodeURIComponent(s).replace(/'/g, '%27');
  const PHOTO_WORSHIP = svg(`<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='1080' viewBox='0 0 1200 1080'>
<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#4a4f58'/><stop offset='1' stop-color='#0d0f12'/></linearGradient>
<linearGradient id='b' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='.42'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>
<radialGradient id='s' cx='42%' cy='10%' r='62%'><stop offset='0' stop-color='#fff4dc' stop-opacity='.85'/><stop offset='1' stop-color='#fff4dc' stop-opacity='0'/></radialGradient></defs>
<rect width='1200' height='1080' fill='url(#g)'/><rect width='1200' height='1080' fill='url(#s)'/>
<polygon points='430,0 520,0 900,1080 160,1080' fill='url(#b)'/><polygon points='860,0 920,0 1180,1080 640,1080' fill='url(#b)' opacity='.6'/>
<g fill='#fff' opacity='.35'><circle cx='180' cy='240' r='26'/><circle cx='980' cy='320' r='18'/><circle cx='760' cy='170' r='12'/><circle cx='300' cy='460' r='10'/><circle cx='1080' cy='520' r='22'/></g>
<g fill='#050607'><path d='M300 1080 L320 760 L335 560 L352 548 L360 760 L380 1080 Z'/><path d='M860 1080 L875 800 L905 610 L922 604 L918 800 L930 1080 Z'/>
<path d='M0 1080 L0 930 C40 880 110 880 140 930 C160 860 250 850 280 920 C310 840 420 850 440 930 C470 860 560 860 590 940 C620 870 720 870 740 940 C780 860 880 860 900 930 C930 850 1040 860 1060 935 C1090 880 1170 880 1200 920 L1200 1080 Z'/>
<circle cx='90' cy='900' r='52'/><circle cx='230' cy='880' r='56'/><circle cx='380' cy='890' r='54'/><circle cx='530' cy='900' r='52'/><circle cx='680' cy='895' r='56'/><circle cx='830' cy='885' r='54'/><circle cx='990' cy='890' r='56'/><circle cx='1140' cy='900' r='52'/></g></svg>`);
  const PHOTO_BOOK = svg(`<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='1080' viewBox='0 0 1200 1080'>
<defs><radialGradient id='l' cx='55%' cy='40%' r='70%'><stop offset='0' stop-color='#f5e6c8'/><stop offset='1' stop-color='#1a1712'/></radialGradient>
<linearGradient id='p' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#fdf8ee'/><stop offset='1' stop-color='#d9d0bf'/></linearGradient></defs>
<rect width='1200' height='1080' fill='url(#l)'/>
<path d='M160 760 C360 640 520 650 600 700 L600 1000 C520 950 360 940 160 1060 Z' fill='url(#p)'/>
<path d='M1040 760 C840 640 680 650 600 700 L600 1000 C680 950 840 940 1040 1060 Z' fill='url(#p)' opacity='.92'/>
<g stroke='#8f8574' stroke-width='5' opacity='.5'><path d='M240 780 C360 720 470 715 560 745'/><path d='M240 820 C360 760 470 755 560 785'/><path d='M240 860 C360 800 470 795 560 825'/>
<path d='M960 780 C840 720 730 715 640 745'/><path d='M960 820 C840 760 730 755 640 785'/><path d='M960 860 C840 800 730 795 640 825'/></g>
<g fill='#2b241b'><path d='M330 560 C380 470 470 450 540 480 L610 690 C560 660 470 660 420 690 Z'/><path d='M880 560 C830 470 740 450 670 480 L600 690 C650 660 740 660 790 690 Z'/></g></svg>`);
  const QR_PLACEHOLDER = svg(`<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>
<rect x='8' y='8' width='384' height='384' rx='36' fill='#ffffff'/>
<g fill='none' stroke='#10262a' stroke-width='18'><rect x='52' y='52' width='84' height='84' rx='10'/><rect x='264' y='52' width='84' height='84' rx='10'/><rect x='52' y='264' width='84' height='84' rx='10'/></g>
<g fill='#10262a'><rect x='82' y='82' width='24' height='24'/><rect x='294' y='82' width='24' height='24'/><rect x='82' y='294' width='24' height='24'/></g>
<text x='270' y='292' font-family='Arial, sans-serif' font-size='26' font-weight='700' fill='#6b7b7d' text-anchor='middle'>YOUR</text>
<text x='270' y='324' font-family='Arial, sans-serif' font-size='26' font-weight='700' fill='#6b7b7d' text-anchor='middle'>QR CODE</text></svg>`);

  // ── Building blocks ───────────────────────────────────────────────────────
  const NO_SHADOW = { enabled: false, color: '#000000', opacity: 70, blur: 4, x: 0, y: 1 };
  const SOFT_SHADOW = { enabled: true, color: '#000000', opacity: 45, blur: 18, x: 0, y: 4 };
  const NO_OUTLINE = { enabled: false, color: '#000000', width: 2 };
  const box = (x, y, w, h) => ({ x, y, w, h });

  // The bundled Teal Studio background (src/backgrounds), with the palette's
  // own gradient kept for a switch to Gradient.
  const canvas = () => ({ id: 'bg', type: 'background', name: 'Canvas', visible: true,
    fill: 'image', src: 'backgrounds/teal-studio.jpg', color: PAL.bg1, opacity: 100, color2: PAL.bg2, angle: 160 });
  const light = (seed) => ({ id: 'light', type: 'motion', name: 'Soft light', visible: true, opacity: 100,
    pos: box(0, 0, W, H), graphic: { kind: 'aurora', colors: [PAL.light1, PAL.light2], count: 3, size: 95, intensity: 34, speed: 0.35, blend: 'glow', seed } });
  const grain = () => ({ id: 'grain', type: 'motion', name: 'Film grain', visible: true, opacity: 100,
    pos: box(0, 0, W, H), graphic: { kind: 'grain', intensity: 7, size: 2, blend: 'overlay', speed: 1, seed: 11 } });

  function text(id, name, copy, pos, font, extra = {}) {
    return {
      id, type: 'text', name, visible: true, binding: 'custom', customText: copy, pos,
      font: { family: 'Manrope', size: 40, weight: 600, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none', ...font },
      color: '#ffffff', opacity: 100, align: 'left', shadow: { ...NO_SHADOW }, outline: { ...NO_OUTLINE },
      ...extra,
    };
  }
  // Heavy two-tone headline: *words* in gold, the rest cream. Arrives word by
  // word, then keeps a slow float.
  const headline = (copy, pos, size = 180, delay = 0.35) => text('headline', 'Headline', copy, pos,
    { family: 'Anton', size, weight: 400, lineHeight: 0.98, letterSpacing: 1, transform: 'uppercase' },
    { color: PAL.cream, accentColor: PAL.gold, shadow: { ...SOFT_SHADOW },
      build: { type: 'words', delay, duration: 0.8 }, idle: { type: 'float', amount: 22, speed: 0.55 } });
  const kicker = (copy, pos, delay = 0.2) => text('kicker', 'Small heading', copy, pos,
    { size: 34, weight: 800, letterSpacing: 7, transform: 'uppercase', lineHeight: 1.1 },
    { color: PAL.gold, build: { type: 'left', delay, duration: 0.7 } });
  const support = (copy, pos, delay = 0.95, size = 42) => text('sub', 'Supporting line', copy, pos,
    { size, weight: 600, lineHeight: 1.35 },
    { opacity: 90, accentColor: PAL.gold, build: { type: 'rise', delay, duration: 0.8 } });
  const flowLine = (id, shape, pos, color = PAL.pink, delay = 0.15, extra = {}) => ({
    id, type: 'motion', name: 'Flowing line', visible: true, opacity: 90, pos, ...extra,
    build: { type: 'fade', delay, duration: 0.4 },
    graphic: { kind: 'line', colors: [color], shape, thickness: 7, draw: 2.4, mirror: 'none', drift: 35, speed: 0.6, seed: 5 },
  });
  const arrow = (id, shape, pos, delay = 1.3, mirror = 'none', rotation = 0) => ({
    id, type: 'motion', name: 'Doodle arrow', visible: true, opacity: 100, pos, rotation,
    build: { type: 'fade', delay, duration: 0.3 },
    graphic: { kind: 'doodle', colors: [PAL.gold], shape, thickness: 9, draw: 1.1, mirror, drift: 20, speed: 0.8, seed: 9 },
  });
  // The washed-back photo: black & white, fading into the slide from one
  // side, easing in slowly and breathing a little while it's up.
  const photo = (src, pos, side = 'left', amount = 60) => ({
    id: 'photo', type: 'image', name: 'Photo', visible: true, src, fit: 'cover', opacity: 80, radius: 0, pos,
    grayscale: 100, fade: { side, amount },
    build: { type: 'fade', delay: 0, duration: 1.4 }, idle: { type: 'breathe', amount: 18, speed: 0.35 },
  });
  const card = (id, pos, delay, color = '#ffffff', opacity = 95) => ({
    id, type: 'background', name: 'Card', visible: true, fill: 'solid', color, opacity, color2: color, angle: 0, radius: 26, pos,
    build: { type: 'rise', delay, duration: 0.8 },
  });
  const cardText = (id, name, copy, pos, font, delay, extra = {}) => text(id, name, copy, pos, font,
    { color: PAL.ink, build: { type: 'rise', delay, duration: 0.8 }, ...extra });
  const qr = (pos, delay = 1) => ({ id: 'qr', type: 'image', name: 'QR code', visible: true, src: QR_PLACEHOLDER, fit: 'contain',
    opacity: 100, radius: 0, pos, build: { type: 'pop', delay, duration: 0.7 } });

  // ── The slides ────────────────────────────────────────────────────────────
  // 1920×1080; copy starts 140 in from the left. The right edge is kept
  // clear enough for the pre-service countdown.
  const SLIDES = [
    { id: 'welcome', name: 'Welcome to Church', layers: [
      canvas(), light(3),
      flowLine('line', 'loop', box(1060, 90, 780, 620)),
      headline('Welcome\n*to church*', box(140, 290, 1200, 400), 196),
      support("We're so glad you're *here*.", box(146, 720, 1100, 70), 0.95, 46),
      grain(),
    ] },
    { id: 'worship', name: 'Worship With Us', layers: [
      canvas(), light(8),
      flowLine('line', 'swoosh', box(80, 660, 1500, 360), PAL.pink, 0.2),
      headline('Worship\n*with us*', box(140, 230, 1200, 400), 196),
      support('Wherever you are, lift your heart to *God*.', box(146, 660, 1100, 70), 0.95, 46),
      grain(),
    ] },
    { id: 'first-time', name: 'First Time With Us?', layers: [
      canvas(), light(13),
      photo(PHOTO_WORSHIP, box(860, 0, 1060, H), 'left', 62),
      flowLine('line', 'loop', box(1210, 60, 560, 760), PAL.pink, 0.25),
      headline('*First time*\nwith us?', box(140, 250, 1000, 400), 188),
      support("Welcome! We're happy to have you with us.", box(146, 690, 780, 130), 0.95, 44),
      grain(),
    ] },
    { id: 'verse', name: 'Verse of the Week', layers: [
      canvas(), light(21),
      headline('*Verse*\nof the\nweek', box(140, 200, 560, 640), 170),
      text('quote', 'Verse', 'The LORD is my strength and my shield; my heart trusted in him, and I am helped: therefore *my heart greatly rejoiceth*; and with my song will I praise him.',
        box(760, 230, 780, 500), { size: 44, weight: 600, lineHeight: 1.42 },
        { accentColor: PAL.gold, opacity: 95, build: { type: 'words', delay: 0.9, duration: 0.6 } }),
      text('reference', 'Reference', 'Psalm 28:7', box(764, 740, 700, 60), { size: 30, weight: 800, letterSpacing: 6, transform: 'uppercase' },
        { color: PAL.gold, build: { type: 'left', delay: 2.4, duration: 0.7 } }),
      flowLine('line', 'underline', box(760, 810, 420, 50), PAL.pink, 2.6),
      grain(),
    ] },
    { id: 'mission', name: 'Our Mission', layers: [
      canvas(), light(34),
      headline('*Our*\nmission', box(140, 260, 700, 420), 200),
      support('To reach out and make *disciples* for Christ.', box(820, 420, 700, 200), 0.95, 56),
      arrow('arrow', 'curve', box(700, 620, 300, 220), 1.5, 'h', 12),
      grain(),
    ] },
    { id: 'prayer', name: 'Need Prayer?', layers: [
      canvas(), light(55),
      photo(PHOTO_BOOK, box(880, 0, 1040, H), 'left', 62),
      headline('Need\n*prayer?*', box(140, 240, 900, 400), 196),
      support('Our prayer team would love to pray with you. Find us at the front after the service.', box(146, 690, 760, 180), 0.95, 40),
      arrow('arrow', 'curl', box(760, 820, 200, 200), 1.6),
      grain(),
    ] },
    { id: 'discipleship', name: 'Join Our Discipleship Group', layers: [
      canvas(), light(89),
      photo(PHOTO_WORSHIP, box(1000, 0, 920, H), 'left', 58),
      kicker('Join our', box(146, 230, 600, 50)),
      headline('*Discipleship*\ngroup', box(140, 290, 1100, 400), 172),
      support("Meeting weekly to study God's word together and grow in *fellowship*.", box(146, 700, 820, 140), 0.95, 42),
      grain(),
    ] },
    { id: 'bible-study', name: 'Join Our Bible Study', layers: [
      canvas(), light(144),
      photo(PHOTO_BOOK, box(980, 0, 940, H), 'left', 60),
      kicker('Join our', box(146, 250, 600, 50)),
      headline('*Bible*\nstudy', box(140, 310, 900, 400), 196),
      text('details', 'Days & time', 'Thursday & Saturday\n*4PM – 6PM*', box(146, 730, 800, 150), { size: 50, weight: 800, lineHeight: 1.2 },
        { accentColor: PAL.gold, build: { type: 'rise', delay: 1, duration: 0.8 } }),
      grain(),
    ] },
    { id: 'missed', name: 'Missed a Sunday?', layers: [
      canvas(), light(233),
      headline('Missed a\n*Sunday?*', box(140, 240, 1000, 400), 190),
      support('All past sermons are streaming on our *YouTube*.', box(146, 690, 800, 130), 0.95, 44),
      qr(box(1080, 330, 380, 380), 1.1),
      arrow('arrow', 'curve', box(820, 150, 300, 220), 1.7, 'none', 18),
      grain(),
    ] },
    { id: 'weekly', name: 'Weekly Service', layers: [
      canvas(), light(377),
      headline('Weekly *service*', box(140, 150, 1360, 190), 150, 0.25),
      card('card1', box(140, 420, 440, 400), 0.8),
      cardText('card1-title', 'Card 1 title', 'Sunday\nService', box(186, 470, 350, 150), { size: 52, weight: 800, lineHeight: 1.05 }, 0.95),
      cardText('card1-body', 'Card 1 details', 'Every Sunday\n9:00 AM', box(186, 660, 350, 110), { size: 32, weight: 600, lineHeight: 1.3 }, 1.05, { opacity: 75 }),
      card('card2', box(600, 420, 440, 400), 1.0),
      cardText('card2-title', 'Card 2 title', 'Prayer\nMeeting', box(646, 470, 350, 150), { size: 52, weight: 800, lineHeight: 1.05 }, 1.15),
      cardText('card2-body', 'Card 2 details', 'Every Wednesday\n6:00 PM', box(646, 660, 350, 110), { size: 32, weight: 600, lineHeight: 1.3 }, 1.25, { opacity: 75 }),
      card('card3', box(1060, 420, 440, 400), 1.2),
      cardText('card3-title', 'Card 3 title', 'Dawn\nWatch', box(1106, 470, 350, 150), { size: 52, weight: 800, lineHeight: 1.05 }, 1.35),
      cardText('card3-body', 'Card 3 details', 'Every Saturday\n6:00 AM', box(1106, 660, 350, 110), { size: 32, weight: 600, lineHeight: 1.3 }, 1.45, { opacity: 75 }),
      grain(),
    ] },
    { id: 'give', name: 'Ways to Give', layers: [
      canvas(), light(610),
      headline('Ways to\n*give*', box(140, 200, 800, 400), 196),
      qr(box(146, 640, 300, 300), 1),
      card('list', box(880, 200, 620, 680), 0.7),
      cardText('give1', 'Option 1', '*In Service*\nDrop your offering in the basket as it comes round.', box(930, 250, 530, 170), { size: 34, weight: 600, lineHeight: 1.35 }, 0.9, { accentColor: '#1d5c63' }),
      cardText('give2', 'Option 2', '*Bank Transfer*\nAccount name · Bank · Account number', box(930, 450, 530, 170), { size: 34, weight: 600, lineHeight: 1.35 }, 1.1, { accentColor: '#1d5c63' }),
      cardText('give3', 'Option 3', '*Text Message*\nText GIVE to your church number.', box(930, 650, 530, 170), { size: 34, weight: 600, lineHeight: 1.35 }, 1.3, { accentColor: '#1d5c63' }),
      grain(),
    ] },
    { id: 'begins', name: 'Service Begins', finale: true, layers: [
      canvas(), light(987),
      flowLine('line', 'swoosh', box(60, 720, 1100, 300), PAL.pink, 0.2),
      headline('*Service*\nbegins', box(140, 250, 1000, 400), 200),
      text('soon', 'In a moment', 'in a moment', box(146, 660, 700, 70), { size: 44, weight: 700, italic: true },
        { color: PAL.gold, build: { type: 'rise', delay: 0.9, duration: 0.8 } }),
      support('Find your seat, quiet your heart, and get ready to worship.', box(146, 760, 820, 130), 1.2, 38),
      grain(),
    ] },
  ];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const slides = () => clone(SLIDES);

  // As built-in themes (Theme Studio's Announcements group).
  function themes() {
    return SLIDES.map(s => ({
      id: 'ann-' + s.id, name: 'Announcement — ' + s.name, layout: 'fullscreen', animation: 'fade',
      groupId: 'grp-announcements', groupName: 'Announcements',
      layers: clone(s.layers),
    }));
  }

  // The countdown every pre-service slide carries: a large, faded number set
  // up the right edge, turned on its side, that the copy shines through — it
  // stays faded as it turns gold for the last minute. It floats gently.
  const sideCountdown = () => text('countdown', 'Countdown', '', box(1230, 380, 1000, 320),
    { family: 'Anton', size: 300, weight: 400, lineHeight: 1, letterSpacing: 8 },
    { binding: 'timer', color: PAL.cream, opacity: 13, align: 'center', rotation: 90,
      warnColor: PAL.gold, overtimeColor: '#e8404a',
      build: { type: 'fade', delay: 0.1, duration: 1.4 }, idle: { type: 'float', amount: 25, speed: 0.4 } });
  // The finale's countdown: full size and full strength inside a ring that
  // runs down with it.
  const finaleCountdown = () => [
    { id: 'ring', type: 'motion', name: 'Countdown ring', visible: true, opacity: 100, pos: box(1180, 190, 620, 620),
      build: { type: 'pop', delay: 0.4, duration: 0.8 },
      graphic: { kind: 'ring', colors: [PAL.gold, PAL.cream, PAL.gold, '#e8404a'], thickness: 3, trackOpacity: 16,
        direction: 'deplete', caps: 'round', glow: 35, stateColors: true, seed: 1 } },
    text('countdown', 'Countdown', '', box(1180, 400, 620, 200),
      { family: 'Anton', size: 170, weight: 400, lineHeight: 1, letterSpacing: 4 },
      { binding: 'timer', color: PAL.cream, align: 'center', warnColor: PAL.gold, overtimeColor: '#e8404a',
        build: { type: 'fade', delay: 0.6, duration: 0.8 } }),
  ];

  // Scenes for a timer segment: the slides in order, Service Begins last (the
  // finale), each with its countdown layered just under the film grain.
  function preserviceScenes() {
    return SLIDES.map((s, i) => {
      const layers = clone(s.layers);
      const grainAt = layers.findIndex(l => l.id === 'grain');
      const count = s.finale ? finaleCountdown() : [sideCountdown()];
      layers.splice(grainAt < 0 ? layers.length : grainAt, 0, ...count);
      return { id: 'scene-' + s.id + '-' + i, name: s.name, durationSec: 30, layers };
    });
  }

  // How the pack's scenes share a countdown: the countdown sets the pace, no
  // slide stays up longer than 30 s, Service Begins holds the final minute,
  // and each change is a soft blur crossfade.
  const PACE = { mode: 'countdown', maxSec: 30, finaleSec: 60, transition: 'blur' };

  const api = { slides, themes, preserviceScenes, PACE, PALETTE: PAL };
  root.KairoAnnouncements = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
