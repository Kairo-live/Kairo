// KAIRO — Hymn bank
//
// Public-domain hymns, stored as ordered verse blocks so the presenter can send
// one block at a time. Every hymn here is long out of copyright (all pre-1928),
// which is what makes it safe to ship the full lyrics inside the app.
//
// Shape:
//   { id, title, author, year, meter, blocks: [{ label, lines: [string] }] }
//
// `blocks` is what actually reaches the screen — one block per slide. Refrains
// are ordinary blocks so an operator can interleave them freely rather than
// having the app guess when a chorus repeats.
'use strict';

const HYMNS = [
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    author: 'John Newton',
    year: 1779,
    meter: 'CM',
    blocks: [
      { label: 'Verse 1', lines: [
        'Amazing grace! how sweet the sound',
        'That saved a wretch like me!',
        'I once was lost, but now am found,',
        'Was blind, but now I see.',
      ]},
      { label: 'Verse 2', lines: [
        "'Twas grace that taught my heart to fear,",
        'And grace my fears relieved;',
        'How precious did that grace appear',
        'The hour I first believed!',
      ]},
      { label: 'Verse 3', lines: [
        'Through many dangers, toils and snares,',
        'I have already come;',
        "'Tis grace hath brought me safe thus far,",
        'And grace will lead me home.',
      ]},
      { label: 'Verse 4', lines: [
        'When we’ve been there ten thousand years,',
        'Bright shining as the sun,',
        "We've no less days to sing God's praise",
        'Than when we first begun.',
      ]},
    ],
  },
  {
    id: 'how-great-thou-art-public',
    title: 'O Store Gud (How Great Thou Art)',
    author: 'Carl Boberg',
    year: 1885,
    meter: '11.10.11.10 with Refrain',
    blocks: [
      { label: 'Verse 1', lines: [
        'O Lord my God! When I in awesome wonder',
        'Consider all the worlds Thy hands have made,',
        'I see the stars, I hear the rolling thunder,',
        'Thy power throughout the universe displayed.',
      ]},
      { label: 'Refrain', lines: [
        'Then sings my soul, my Saviour God, to Thee;',
        'How great Thou art, how great Thou art!',
      ]},
      { label: 'Verse 2', lines: [
        'When through the woods and forest glades I wander',
        'And hear the birds sing sweetly in the trees;',
        'When I look down from lofty mountain grandeur,',
        'And hear the brook, and feel the gentle breeze;',
      ]},
    ],
  },
  {
    id: 'holy-holy-holy',
    title: 'Holy, Holy, Holy',
    author: 'Reginald Heber',
    year: 1826,
    meter: '11.12.12.10',
    blocks: [
      { label: 'Verse 1', lines: [
        'Holy, holy, holy! Lord God Almighty!',
        'Early in the morning our song shall rise to Thee;',
        'Holy, holy, holy! merciful and mighty!',
        'God in three Persons, blessed Trinity!',
      ]},
      { label: 'Verse 2', lines: [
        'Holy, holy, holy! all the saints adore Thee,',
        'Casting down their golden crowns around the glassy sea;',
        'Cherubim and seraphim falling down before Thee,',
        'Which wert, and art, and evermore shalt be.',
      ]},
      { label: 'Verse 3', lines: [
        'Holy, holy, holy! though the darkness hide Thee,',
        'Though the eye of sinful man Thy glory may not see,',
        'Only Thou art holy; there is none beside Thee',
        'Perfect in power, in love, and purity.',
      ]},
      { label: 'Verse 4', lines: [
        'Holy, holy, holy! Lord God Almighty!',
        'All Thy works shall praise Thy name, in earth, and sky, and sea;',
        'Holy, holy, holy! merciful and mighty!',
        'God in three Persons, blessed Trinity!',
      ]},
    ],
  },
  {
    id: 'great-is-thy-faithfulness-public',
    title: 'Come, Thou Fount of Every Blessing',
    author: 'Robert Robinson',
    year: 1758,
    meter: '8.7.8.7 D',
    blocks: [
      { label: 'Verse 1', lines: [
        'Come, Thou Fount of every blessing,',
        'Tune my heart to sing Thy grace;',
        'Streams of mercy, never ceasing,',
        'Call for songs of loudest praise.',
      ]},
      { label: 'Verse 2', lines: [
        'Here I raise mine Ebenezer;',
        'Hither by Thy help I’m come;',
        'And I hope, by Thy good pleasure,',
        'Safely to arrive at home.',
      ]},
      { label: 'Verse 3', lines: [
        'O to grace how great a debtor',
        'Daily I’m constrained to be!',
        'Let Thy goodness, like a fetter,',
        'Bind my wandering heart to Thee.',
      ]},
    ],
  },
  {
    id: 'it-is-well',
    title: 'It Is Well With My Soul',
    author: 'Horatio G. Spafford',
    year: 1873,
    meter: '11.8.11.9 with Refrain',
    blocks: [
      { label: 'Verse 1', lines: [
        'When peace like a river attendeth my way,',
        'When sorrows like sea billows roll;',
        'Whatever my lot, Thou hast taught me to say,',
        'It is well, it is well with my soul.',
      ]},
      { label: 'Refrain', lines: [
        'It is well with my soul,',
        'It is well, it is well with my soul.',
      ]},
      { label: 'Verse 2', lines: [
        'Though Satan should buffet, though trials should come,',
        'Let this blest assurance control,',
        'That Christ hath regarded my helpless estate,',
        'And hath shed His own blood for my soul.',
      ]},
      { label: 'Verse 3', lines: [
        'My sin—oh, the bliss of this glorious thought!—',
        'My sin, not in part but the whole,',
        'Is nailed to the cross, and I bear it no more,',
        'Praise the Lord, praise the Lord, O my soul!',
      ]},
    ],
  },
  {
    id: 'blessed-assurance',
    title: 'Blessed Assurance',
    author: 'Fanny J. Crosby',
    year: 1873,
    meter: '9.10.9.9 with Refrain',
    blocks: [
      { label: 'Verse 1', lines: [
        'Blessed assurance, Jesus is mine!',
        'Oh, what a foretaste of glory divine!',
        'Heir of salvation, purchase of God,',
        'Born of His Spirit, washed in His blood.',
      ]},
      { label: 'Refrain', lines: [
        'This is my story, this is my song,',
        'Praising my Saviour all the day long.',
      ]},
      { label: 'Verse 2', lines: [
        'Perfect submission, perfect delight,',
        'Visions of rapture now burst on my sight;',
        'Angels descending bring from above',
        'Echoes of mercy, whispers of love.',
      ]},
    ],
  },
  {
    id: 'to-god-be-the-glory',
    title: 'To God Be the Glory',
    author: 'Fanny J. Crosby',
    year: 1875,
    meter: '11.11.11.11 with Refrain',
    blocks: [
      { label: 'Verse 1', lines: [
        'To God be the glory, great things He hath done,',
        'So loved He the world that He gave us His Son,',
        'Who yielded His life an atonement for sin,',
        'And opened the life-gate that all may go in.',
      ]},
      { label: 'Refrain', lines: [
        'Praise the Lord, praise the Lord,',
        'Let the earth hear His voice!',
      ]},
    ],
  },
  {
    id: 'what-a-friend',
    title: 'What a Friend We Have in Jesus',
    author: 'Joseph M. Scriven',
    year: 1855,
    meter: '8.7.8.7 D',
    blocks: [
      { label: 'Verse 1', lines: [
        'What a friend we have in Jesus,',
        'All our sins and griefs to bear!',
        'What a privilege to carry',
        'Everything to God in prayer!',
      ]},
      { label: 'Verse 2', lines: [
        'Have we trials and temptations?',
        'Is there trouble anywhere?',
        'We should never be discouraged;',
        'Take it to the Lord in prayer.',
      ]},
    ],
  },
  {
    id: 'a-mighty-fortress',
    title: 'A Mighty Fortress Is Our God',
    author: 'Martin Luther',
    year: 1529,
    meter: '8.7.8.7.6.6.6.6.7',
    blocks: [
      { label: 'Verse 1', lines: [
        'A mighty fortress is our God,',
        'A bulwark never failing;',
        'Our helper He, amid the flood',
        'Of mortal ills prevailing.',
      ]},
      { label: 'Verse 2', lines: [
        'Did we in our own strength confide,',
        'Our striving would be losing;',
        'Were not the right Man on our side,',
        'The Man of God’s own choosing.',
      ]},
    ],
  },
  {
    id: 'be-thou-my-vision',
    title: 'Be Thou My Vision',
    author: 'Irish, tr. Mary E. Byrne',
    year: 1905,
    meter: '10.10.10.10',
    blocks: [
      { label: 'Verse 1', lines: [
        'Be Thou my vision, O Lord of my heart;',
        'Naught be all else to me, save that Thou art;',
        'Thou my best thought, by day or by night,',
        'Waking or sleeping, Thy presence my light.',
      ]},
      { label: 'Verse 2', lines: [
        'Be Thou my wisdom, and Thou my true word;',
        'I ever with Thee and Thou with me, Lord;',
        'Thou my great Father, I Thy true son;',
        'Thou in me dwelling, and I with Thee one.',
      ]},
    ],
  },
];

// ── Imported bank ─────────────────────────────────────────────────────────
// The ten above are a floor, not the library. `scripts/import-hymns.js`
// converts a third-party dataset into src/hymn-bank.json; when that file is
// present it is merged in ahead of the built-ins (built-ins win on id clash so
// a bad import can never silently replace a known-good hymn).
let IMPORTED = [];

function allHymns() {
  if (!IMPORTED.length) return HYMNS;
  const seen = new Set(HYMNS.map(h => h.id));
  return [...HYMNS, ...IMPORTED.filter(h => h && h.id && !seen.has(h.id) && (h.blocks || []).length)];
}

// Called by the app at boot. Missing file is the normal case, not an error.
async function loadHymnBank(url = 'hymn-bank.json') {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return 0;
    const data = await r.json();
    if (Array.isArray(data)) IMPORTED = data;
    return IMPORTED.length;
  } catch { return 0; }
}

// Case/punctuation-insensitive search across title, author and lyric lines so
// an operator can find a hymn by whatever they remember of it.
function searchHymns(query) {
  const pool = allHymns();
  const q = String(query || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (!q) return pool;
  return pool.filter(h => {
    const hay = [
      h.title, h.author,
      ...h.blocks.flatMap(b => b.lines),
    ].join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    return hay.includes(q);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HYMNS, searchHymns, allHymns };
}
