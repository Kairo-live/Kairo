// KAIRO — Shared Theme Studio design-space canvas size
//
// The 1920x1080 design-space constant used to convert between canvas pixels
// and on-screen percentages was previously declared three times independently
// (app.js's TS_DESIGN_W/H, service.js's DESIGN_W/H, display.html's inline
// DESIGN_W/H) — a real risk of silent divergence if the canvas size ever
// changes. Loaded before all three.
'use strict';

window.KAIRO_DESIGN_W = 1920;
window.KAIRO_DESIGN_H = 1080;
