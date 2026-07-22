import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHeadingOffset, bearingBetween, calibrationOffset, fovSectorPoints, remoteEventSignature, remoteSlotFromInput, shortestAngleDelta } from '../public/field-input.js';

test('FOV jest symetryczny względem kierunku także przy przejściu przez 0 stopni', () => {
  const sector = fovSectorPoints(52.2304, 21.0184, 5, 70, 180, 20);
  assert.equal(sector.arc.length, 21);
  const left = bearingBetween(52.2304, 21.0184, ...sector.arc[0]);
  const right = bearingBetween(52.2304, 21.0184, ...sector.arc.at(-1));
  assert.ok(Math.abs(shortestAngleDelta(5, left) + 35) < 0.05);
  assert.ok(Math.abs(shortestAngleDelta(5, right) - 35) < 0.05);
  const axis = bearingBetween(52.2304, 21.0184, ...sector.axis[1]);
  assert.ok(Math.abs(shortestAngleDelta(5, axis)) < 0.05);
});

test('kalibracja kierunku kompensuje dowolne ułożenie telefonu', () => {
  const offset = calibrationOffset(112, 28);
  assert.equal(offset, 276);
  assert.equal(applyHeadingOffset(112, offset), 28);
});

test('pilot rozpoznaje popularne sygnały oraz nauczony przycisk', () => {
  assert.equal(remoteSlotFromInput({ key: 'AudioVolumeUp' }), 'A');
  assert.equal(remoteSlotFromInput({ keyCode: 114 }), 'B');
  assert.equal(remoteSlotFromInput({ key: 'Enter' }), 'A');
  assert.equal(remoteSlotFromInput({ key: ' ' }), 'B');
  const learned = remoteEventSignature({ key: 'b', code: 'KeyB', keyCode: 66 });
  assert.equal(learned, 'key:b');
  assert.equal(remoteSlotFromInput({ key: 'b', code: 'KeyB' }, { keyA: learned }), 'A');
});
