'use strict';
// Pure rules engine for Cosmic Wimpout. No networking in here.
const crypto = require('crypto');

// Each die rolls uniformly from these 7 symbols ("random cubes" style).
// Tweak here if you want to match your physical dice more closely.
const FACES = ['sun', '2', '3', '4', '5', '6', '10'];
const FLASH = { '2': 20, '3': 30, '4': 40, '5': 50, '6': 60, '10': 100 };
const FREIGHT = { '2': 200, '4': 400, '5': 500 }; // '6' = instant win, '10' = supernova
const OPEN_MIN = 35;

const rollFace = () => FACES[crypto.randomInt(FACES.length)];

// Score one roll of n dice (n = 1..5). Returns indices (into `faces`) that score / don't.
function evaluate(faces) {
  const n = faces.length;
  const sunIdx = [];
  const by = {};
  faces.forEach((f, i) => {
    if (f === 'sun') sunIdx.push(i);
    else (by[f] = by[f] || []).push(i);
  });
  const suns = sunIdx.length;

  if (n === 5) {
    if (suns === 5) return { special: 'win' };
    for (const f of Object.keys(by)) {
      if (by[f].length + suns === 5) {
        if (f === '6') return { special: 'win' };
        if (f === '10') return { special: 'supernova' };
        if (FREIGHT[f]) return { special: 'freight', score: FREIGHT[f], scoring: [0, 1, 2, 3, 4], nonScoring: [], flash: null, freeSuns: [] };
      }
    }
  }

  // Possible flashes (three matching faces; the Flaming Sun is wild)
  const cands = [];
  for (const f of Object.keys(FLASH)) {
    const c = (by[f] || []).length;
    const need = Math.max(0, 3 - c);
    if (need <= suns) cands.push({ f, c, need });
  }
  // Flaming Sun Rule: sun rolled with a pair MUST make a flash
  const forced = cands.some((x) => x.c === 2 && x.need === 1);
  const options = forced ? cands : [null, ...cands];

  const build = (cand) => {
    const used = new Set();
    let score = 0;
    let flash = null;
    const sunsLeft = sunIdx.slice();
    if (cand) {
      flash = cand.f;
      (by[cand.f] || []).slice(0, 3).forEach((i) => used.add(i));
      for (let k = 0; k < cand.need; k++) used.add(sunsLeft.shift());
      score += FLASH[cand.f];
    }
    const scoring = [...used];
    const non = [];
    const freeSuns = [];
    faces.forEach((f, i) => {
      if (used.has(i)) return;
      if (f === 'sun') { score += 10; scoring.push(i); freeSuns.push(i); return; }
      if (cand && f === cand.f) { non.push(i); return; } // 4th matching face is non-scoring
      if (f === '5') { score += 5; scoring.push(i); }
      else if (f === '10') { score += 10; scoring.push(i); }
      else non.push(i);
    });
    return { score, scoring, nonScoring: non, flash, freeSuns };
  };

  let best = null;
  for (const o of options) {
    const r = build(o);
    if (!best || r.score > best.score || (r.score === best.score && r.scoring.length > best.scoring.length)) best = r;
  }
  return best;
}

function newTurn() {
  return {
    pts: 0,
    dice: Array.from({ length: 5 }, () => ({ face: null, scoring: false })),
    avail: [0, 1, 2, 3, 4], // dice that will be rolled next
    pending: null,          // flash face that still has to be cleared
    mustAll: false,         // scored with all 5 -> must roll all 5 again
    rolled: false,
    freeSuns: [],
    canRerollSun: false,
    over: false,
    outcome: null,          // wimpout | trainwreck | supernova | win
    lastRoll: [],
    rollNo: 0,
    note: ''
  };
}

function canBank(turn, opened) {
  return !turn.over && turn.rolled && !turn.mustAll && !turn.pending && turn.pts > 0 && (opened || turn.pts >= OPEN_MIN);
}

function rollTurn(turn, { rerollSun = false } = {}) {
  if (turn.over) throw new Error('Turn is over');
  if (rerollSun && turn.canRerollSun) {
    for (const i of turn.freeSuns) { turn.pts -= 10; turn.dice[i].scoring = false; turn.avail.push(i); }
    turn.freeSuns = [];
  }
  const idxs = turn.avail.slice();
  let faces;
  let guard = 0;
  do { // Reroll Clause: can't match the flash face while clearing
    faces = idxs.map(rollFace);
    guard++;
  } while (turn.pending && faces.includes(turn.pending) && guard < 500);
  faces.forEach((f, k) => { turn.dice[idxs[k]].face = f; turn.dice[idxs[k]].scoring = false; });
  turn.rolled = true;
  turn.lastRoll = idxs;
  turn.rollNo++;
  turn.note = '';

  const ev = evaluate(faces);
  if (ev.special === 'win') { turn.over = true; turn.outcome = 'win'; return turn; }
  if (ev.special === 'supernova') { turn.over = true; turn.outcome = 'supernova'; turn.pts = 0; return turn; }
  if (ev.score === 0) {
    turn.over = true;
    turn.outcome = idxs.length === 5 ? 'trainwreck' : 'wimpout';
    turn.pts = 0;
    return turn;
  }
  turn.pts += ev.score;
  ev.scoring.forEach((k) => { turn.dice[idxs[k]].scoring = true; });
  const non = ev.nonScoring.map((k) => idxs[k]);
  if (ev.special === 'freight') turn.note = 'FREIGHT TRAIN!';
  else if (ev.flash) turn.note = 'Flash of ' + ev.flash + 's!';
  if (non.length === 0) {
    turn.mustAll = true;
    turn.avail = [0, 1, 2, 3, 4];
    turn.pending = null;
    turn.freeSuns = [];
    turn.canRerollSun = false;
  } else {
    turn.mustAll = false;
    turn.avail = non;
    turn.pending = ev.flash;
    turn.freeSuns = ev.freeSuns.map((k) => idxs[k]);
    turn.canRerollSun = turn.freeSuns.length > 0 && ev.scoring.length - ev.freeSuns.length >= 1;
  }
  return turn;
}

module.exports = { FACES, FLASH, FREIGHT, OPEN_MIN, evaluate, newTurn, rollTurn, canBank };
