const WGS84_A = 6378137;
const WGS84_ECC_SQUARED = 0.00669438;
const K0 = 0.9996;
const BANDS = 'CDEFGHJKLMNPQRSTUVWXX';
const EASTING_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const NORTHING_ODD = 'ABCDEFGHJKLMNPQRSTUV';
const NORTHING_EVEN = 'FGHJKLMNPQRSTUVABCDE';

const rad = value => value * Math.PI / 180;
const deg = value => value * 180 / Math.PI;

export function utmZoneFor(lat, lon) {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon < 9) zone = 31;
    else if (lon < 21) zone = 33;
    else if (lon < 33) zone = 35;
    else if (lon < 42) zone = 37;
  }
  return Math.max(1, Math.min(60, zone));
}

export function latLonToUtm(lat, lon, forcedZone) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -80 || lat > 84) return null;
  const zone = forcedZone || utmZoneFor(lat, lon);
  const latitude = rad(lat);
  const longitude = rad(lon);
  const longitudeOrigin = rad((zone - 1) * 6 - 180 + 3);
  const eccPrimeSquared = WGS84_ECC_SQUARED / (1 - WGS84_ECC_SQUARED);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const tanLat = Math.tan(latitude);
  const n = WGS84_A / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLat * sinLat);
  const t = tanLat * tanLat;
  const c = eccPrimeSquared * cosLat * cosLat;
  const a = cosLat * (longitude - longitudeOrigin);
  const m = WGS84_A * (
    (1 - WGS84_ECC_SQUARED / 4 - 3 * WGS84_ECC_SQUARED ** 2 / 64 - 5 * WGS84_ECC_SQUARED ** 3 / 256) * latitude
    - (3 * WGS84_ECC_SQUARED / 8 + 3 * WGS84_ECC_SQUARED ** 2 / 32 + 45 * WGS84_ECC_SQUARED ** 3 / 1024) * Math.sin(2 * latitude)
    + (15 * WGS84_ECC_SQUARED ** 2 / 256 + 45 * WGS84_ECC_SQUARED ** 3 / 1024) * Math.sin(4 * latitude)
    - (35 * WGS84_ECC_SQUARED ** 3 / 3072) * Math.sin(6 * latitude)
  );
  const easting = K0 * n * (a + (1 - t + c) * a ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * eccPrimeSquared) * a ** 5 / 120) + 500000;
  let northing = K0 * (m + n * tanLat * (a ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * a ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * eccPrimeSquared) * a ** 6 / 720));
  const northern = lat >= 0;
  if (!northern) northing += 10000000;
  const band = BANDS[Math.floor((lat + 80) / 8)] || (northern ? 'X' : 'C');
  return { easting, northing, zone, band, northern };
}

export function utmToLatLon(easting, northing, zone, northern = true) {
  const eccPrimeSquared = WGS84_ECC_SQUARED / (1 - WGS84_ECC_SQUARED);
  const e1 = (1 - Math.sqrt(1 - WGS84_ECC_SQUARED)) / (1 + Math.sqrt(1 - WGS84_ECC_SQUARED));
  const x = easting - 500000;
  const y = northern ? northing : northing - 10000000;
  const longitudeOrigin = (zone - 1) * 6 - 180 + 3;
  const m = y / K0;
  const mu = m / (WGS84_A * (1 - WGS84_ECC_SQUARED / 4 - 3 * WGS84_ECC_SQUARED ** 2 / 64 - 5 * WGS84_ECC_SQUARED ** 3 / 256));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinPhi = Math.sin(phi1);
  const cosPhi = Math.cos(phi1);
  const tanPhi = Math.tan(phi1);
  const n1 = WGS84_A / Math.sqrt(1 - WGS84_ECC_SQUARED * sinPhi ** 2);
  const r1 = WGS84_A * (1 - WGS84_ECC_SQUARED) / (1 - WGS84_ECC_SQUARED * sinPhi ** 2) ** 1.5;
  const t1 = tanPhi ** 2;
  const c1 = eccPrimeSquared * cosPhi ** 2;
  const d = x / (n1 * K0);
  const latitude = phi1 - (n1 * tanPhi / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * eccPrimeSquared) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * eccPrimeSquared - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = rad(longitudeOrigin) + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * eccPrimeSquared + 24 * t1 ** 2) * d ** 5 / 120) / cosPhi;
  return { lat: deg(latitude), lon: deg(longitude) };
}

export function mgrs(lat, lon, precision = 5) {
  const utm = latLonToUtm(lat, lon);
  if (!utm) return 'POZA ZAKRESEM MGRS';
  const digits = Math.max(1, Math.min(5, precision));
  const eastingLetters = EASTING_SETS[(utm.zone - 1) % 3];
  const northingLetters = utm.zone % 2 ? NORTHING_ODD : NORTHING_EVEN;
  const eastingIndex = Math.max(0, Math.min(7, Math.floor(utm.easting / 100000) - 1));
  const northingIndex = Math.floor(utm.northing / 100000) % 20;
  const divisor = 10 ** (5 - digits);
  const easting = String(Math.floor((utm.easting % 100000) / divisor)).padStart(digits, '0');
  const northing = String(Math.floor((utm.northing % 100000) / divisor)).padStart(digits, '0');
  return `${utm.zone}${utm.band} ${eastingLetters[eastingIndex]}${northingLetters[northingIndex]} ${easting} ${northing}`;
}

export function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
