import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, latLonToUtm, mgrs, pointInPolygon, utmToLatLon } from '../public/geo.js';

test('konwersja WGS84, UTM i MGRS zachowuje pozycję', () => {
  const source = { lat: 52.2304, lon: 21.0184 };
  const utm = latLonToUtm(source.lat, source.lon);
  assert.equal(utm.zone, 34);
  assert.equal(utm.band, 'U');
  const restored = utmToLatLon(utm.easting, utm.northing, utm.zone, utm.northern);
  assert.ok(distanceMeters(source.lat, source.lon, restored.lat, restored.lon) < 0.2);
  assert.match(mgrs(source.lat, source.lon), /^34U [A-Z]{2} \d{5} \d{5}$/);
});

test('geometria granicy i dystans działają w metrach', () => {
  const area = [[52.22, 21.00], [52.24, 21.00], [52.24, 21.04], [52.22, 21.04]];
  assert.equal(pointInPolygon(52.23, 21.02, area), true);
  assert.equal(pointInPolygon(52.30, 21.02, area), false);
  assert.ok(distanceMeters(52.23, 21.02, 52.2309, 21.02) > 95);
});
