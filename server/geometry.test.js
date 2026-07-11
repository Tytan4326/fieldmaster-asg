import test from 'node:test';
import assert from 'node:assert/strict';

function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

test('point in polygon accepts interior and rejects exterior', () => {
  const square = [[0,0],[0,10],[10,10],[10,0]];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(12, 5, square), false);
});
