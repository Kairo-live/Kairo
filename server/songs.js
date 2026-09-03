// KAIRO — Song Library
//
// A persistent collection of songs the operator builds up over time —
// distinct from playlists, which are one service's running order. Songs are
// tagged with one of 3 fixed preset categories (worship/praise/hymn, see
// CATEGORIES) rather than freeform folders — nothing here for the operator
// to create/rename/delete, just a category a song is filed under.
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DATA = process.env.KAIRO_APP_DATA_DIR || path.join(__dirname, '..', 'databases');
const SONGS_FILE = path.join(APP_DATA, 'songs', 'songs.json');

const CATEGORIES = ['worship', 'praise', 'hymn'];

function ensureDirs() {
  fs.mkdirSync(path.dirname(SONGS_FILE), { recursive: true });
}

let songs = []; // [{ id, title, author, year, themeId, category, blocks }]

function loadSongs() {
  try {
    const data = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
    songs = Array.isArray(data) ? data : [];
  } catch { songs = []; }
}

function saveSongs() {
  ensureDirs();
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2));
}

function init() {
  ensureDirs();
  loadSongs();
}

function normalizeCategory(category) {
  return CATEGORIES.includes(category) ? category : null;
}

function listSongs() { return songs; }

function addSong(record) {
  const song = {
    id: crypto.randomUUID(),
    title: record.title || 'Untitled',
    author: record.author || '',
    year: record.year || null,
    themeId: record.themeId || null,
    category: normalizeCategory(record.category),
    blocks: Array.isArray(record.blocks) ? record.blocks : [],
  };
  songs.push(song);
  saveSongs();
  return song;
}

function updateSong(id, record) {
  const song = songs.find(s => s.id === id);
  if (!song) return null;
  if (record.title !== undefined) song.title = record.title;
  if (record.author !== undefined) song.author = record.author;
  if (record.year !== undefined) song.year = record.year;
  if (record.themeId !== undefined) song.themeId = record.themeId;
  if (record.category !== undefined) song.category = normalizeCategory(record.category);
  if (record.blocks !== undefined) song.blocks = record.blocks;
  saveSongs();
  return song;
}

function removeSong(id) {
  const before = songs.length;
  songs = songs.filter(s => s.id !== id);
  saveSongs();
  return songs.length !== before;
}

module.exports = {
  CATEGORIES,
  init,
  listSongs, addSong, updateSong, removeSong,
};
