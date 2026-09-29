// KAIRO — the bundled background pool: original abstract backgrounds that ship
// with the app (src/backgrounds/), reusable by any theme or slide. Written by
// scripts/make-backgrounds.js — edit the recipes there and re-run it rather
// than editing this list by hand. tone: which text reads on it ('dark' takes
// light text); color: the picture's average colour.
(function (root) {
  'use strict';
  const BACKGROUNDS = [
    {
      "id": "midnight",
      "name": "Midnight",
      "tone": "dark",
      "tags": [
        "blue",
        "soft light"
      ],
      "color": "#1a2154",
      "src": "backgrounds/midnight.jpg",
      "thumb": "backgrounds/thumbs/midnight.jpg"
    },
    {
      "id": "aurora",
      "name": "Aurora",
      "tone": "dark",
      "tags": [
        "teal",
        "violet"
      ],
      "color": "#1a394b",
      "src": "backgrounds/aurora.jpg",
      "thumb": "backgrounds/thumbs/aurora.jpg"
    },
    {
      "id": "teal-studio",
      "name": "Teal Studio",
      "tone": "dark",
      "tags": [
        "teal",
        "announcements"
      ],
      "color": "#234144",
      "src": "backgrounds/teal-studio.jpg",
      "thumb": "backgrounds/thumbs/teal-studio.jpg"
    },
    {
      "id": "ember",
      "name": "Ember",
      "tone": "dark",
      "tags": [
        "warm",
        "amber"
      ],
      "color": "#431a06",
      "src": "backgrounds/ember.jpg",
      "thumb": "backgrounds/thumbs/ember.jpg"
    },
    {
      "id": "royal",
      "name": "Royal",
      "tone": "dark",
      "tags": [
        "purple",
        "magenta"
      ],
      "color": "#390e39",
      "src": "backgrounds/royal.jpg",
      "thumb": "backgrounds/thumbs/royal.jpg"
    },
    {
      "id": "emerald",
      "name": "Emerald",
      "tone": "dark",
      "tags": [
        "green"
      ],
      "color": "#0c3c22",
      "src": "backgrounds/emerald.jpg",
      "thumb": "backgrounds/thumbs/emerald.jpg"
    },
    {
      "id": "crimson",
      "name": "Crimson",
      "tone": "dark",
      "tags": [
        "red",
        "velvet"
      ],
      "color": "#3b0810",
      "src": "backgrounds/crimson.jpg",
      "thumb": "backgrounds/thumbs/crimson.jpg"
    },
    {
      "id": "charcoal",
      "name": "Charcoal",
      "tone": "dark",
      "tags": [
        "neutral",
        "grey"
      ],
      "color": "#212427",
      "src": "backgrounds/charcoal.jpg",
      "thumb": "backgrounds/thumbs/charcoal.jpg"
    },
    {
      "id": "stage",
      "name": "Stage Lights",
      "tone": "dark",
      "tags": [
        "worship",
        "beams"
      ],
      "color": "#2b2f48",
      "src": "backgrounds/stage.jpg",
      "thumb": "backgrounds/thumbs/stage.jpg"
    },
    {
      "id": "golden-bokeh",
      "name": "Golden Bokeh",
      "tone": "dark",
      "tags": [
        "warm",
        "bokeh"
      ],
      "color": "#2a1a0a",
      "src": "backgrounds/golden-bokeh.jpg",
      "thumb": "backgrounds/thumbs/golden-bokeh.jpg"
    },
    {
      "id": "starfield",
      "name": "Starfield",
      "tone": "dark",
      "tags": [
        "night",
        "stars"
      ],
      "color": "#0e132f",
      "src": "backgrounds/starfield.jpg",
      "thumb": "backgrounds/thumbs/starfield.jpg"
    },
    {
      "id": "ocean",
      "name": "Ocean",
      "tone": "dark",
      "tags": [
        "blue",
        "calm"
      ],
      "color": "#052b47",
      "src": "backgrounds/ocean.jpg",
      "thumb": "backgrounds/thumbs/ocean.jpg"
    },
    {
      "id": "dawn",
      "name": "Dawn",
      "tone": "light",
      "tags": [
        "pastel",
        "sunrise"
      ],
      "color": "#eedbe2",
      "src": "backgrounds/dawn.jpg",
      "thumb": "backgrounds/thumbs/dawn.jpg"
    },
    {
      "id": "linen",
      "name": "Linen",
      "tone": "light",
      "tags": [
        "paper",
        "warm"
      ],
      "color": "#ebe5da",
      "src": "backgrounds/linen.jpg",
      "thumb": "backgrounds/thumbs/linen.jpg"
    },
    {
      "id": "mist",
      "name": "Mist",
      "tone": "light",
      "tags": [
        "cool",
        "grey-blue"
      ],
      "color": "#dce4ec",
      "src": "backgrounds/mist.jpg",
      "thumb": "backgrounds/thumbs/mist.jpg"
    }
  ];
  root.KairoBackgrounds = BACKGROUNDS;
  if (typeof module !== 'undefined' && module.exports) module.exports = BACKGROUNDS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
