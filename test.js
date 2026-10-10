'use strict';
const assert = require('assert');
const G = require('./game');
const ev = (...f) => G.evaluate(f);

// Basics
assert.strictEqual(ev('5', '2', '3', '4', '6').score, 5);
assert.strictEqual(ev('10', '5', '2', '3', '4').score, 15);
assert.strictEqual(ev('2', '3', '4', '6', '2').score, 0);
// Flashes
assert.strictEqual(ev('2', '2', '2', '3', '4').score, 20);
assert.strictEqual(ev('10', '10', '10', '3', '4').score, 100);
assert.strictEqual(ev('5', '5', '5', '10', '2').score, 60); // 50 + 10
// Rules page example: 4,4,4 + 4th matching (non-scoring) + five = 45
const r = ev('4', '4', '4', '4', '5');
assert.strictEqual(r.score, 45); assert.strictEqual(r.nonScoring.length, 1);
// Rules page example: 6,6,sun,3,2 -> sun makes 60 flash, 3 and 2 must be cleared
const r2 = ev('6', '6', 'sun', '3', '2');
assert.strictEqual(r2.score, 60); assert.strictEqual(r2.flash, '6'); assert.deepStrictEqual(r2.nonScoring.sort(), [3, 4]);
// Freight trains
assert.strictEqual(ev('2', '2', '2', '2', '2').score, 200);
assert.strictEqual(ev('4', '4', '4', '4', '4').score, 400);
assert.strictEqual(ev('5', '5', '5', '5', '5').score, 500);
assert.strictEqual(ev('6', '6', '6', '6', '6').special, 'win');
assert.strictEqual(ev('10', '10', '10', '10', 'sun').special, 'supernova');
// Lone sun is worth 10
assert.strictEqual(ev('sun').score, 10);
assert.strictEqual(ev('sun', '2', '3').score, 10);

// Fuzz the turn engine
for (let g = 0; g < 20000; g++) {
  const t = G.newTurn();
  let opened = Math.random() < 0.5;
  for (let s = 0; s < 40 && !t.over; s++) {
    G.rollTurn(t, { rerollSun: Math.random() < 0.3 });
    assert(t.pts >= 0, 'negative points');
    assert(t.avail.length >= 1 && t.avail.length <= 5);
    if (t.over) break;
    if (t.mustAll) assert.strictEqual(t.avail.length, 5);
    if (G.canBank(t, opened)) { assert(t.pts > 0); if (Math.random() < 0.5) break; }
  }
}
console.log('engine tests passed');
