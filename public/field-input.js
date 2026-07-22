const toRadians = value => value * Math.PI / 180;
const toDegrees = value => value * 180 / Math.PI;

export function normalizeDegrees(value) {
  const number = Number(value);
  return Number.isFinite(number) ? ((number % 360) + 360) % 360 : null;
}

export function shortestAngleDelta(from, to) {
  const start = normalizeDegrees(from);
  const end = normalizeDegrees(to);
  if (start === null || end === null) return null;
  return ((end - start + 540) % 360) - 180;
}

export function blendBearing(previous, next, weight = 0.25) {
  const target = normalizeDegrees(next);
  if (target === null) return null;
  const current = normalizeDegrees(previous);
  if (current === null) return target;
  const amount = Math.max(0, Math.min(1, Number(weight) || 0));
  return normalizeDegrees(current + shortestAngleDelta(current, target) * amount);
}

export function destinationPoint(lat, lon, bearing, distance) {
  const radius = 6371000;
  const angularDistance = Number(distance) / radius;
  const heading = toRadians(normalizeDegrees(bearing) ?? 0);
  const lat1 = toRadians(Number(lat));
  const lon1 = toRadians(Number(lon));
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(heading));
  const lon2 = lon1 + Math.atan2(Math.sin(heading) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));
  return [toDegrees(lat2), toDegrees(lon2)];
}

export function bearingBetween(lat1, lon1, lat2, lon2) {
  const start = toRadians(Number(lat1));
  const end = toRadians(Number(lat2));
  const longitudeDelta = toRadians(Number(lon2) - Number(lon1));
  return normalizeDegrees(toDegrees(Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(end),
    Math.cos(start) * Math.sin(end) - Math.sin(start) * Math.cos(end) * Math.cos(longitudeDelta)
  )));
}

export function fovSectorPoints(lat, lon, heading, angle, range, steps = 16) {
  const centerHeading = normalizeDegrees(heading);
  if (centerHeading === null) return null;
  const safeAngle = Math.max(1, Math.min(179, Number(angle) || 1));
  const safeRange = Math.max(1, Number(range) || 1);
  const count = Math.max(4, Math.min(64, Math.round(Number(steps) || 16)));
  const halfAngle = safeAngle / 2;
  const leftBearing = normalizeDegrees(centerHeading - halfAngle);
  const rightBearing = normalizeDegrees(centerHeading + halfAngle);
  const arc = [];
  for (let index = 0; index <= count; index += 1) {
    const offset = -halfAngle + safeAngle * index / count;
    arc.push(destinationPoint(lat, lon, centerHeading + offset, safeRange));
  }
  return {
    polygon: [[Number(lat), Number(lon)], ...arc],
    axis: [[Number(lat), Number(lon)], destinationPoint(lat, lon, centerHeading, safeRange)],
    arc,
    heading: centerHeading,
    halfAngle,
    leftBearing,
    rightBearing
  };
}

export function calibrationOffset(rawHeading, movementHeading) {
  const raw = normalizeDegrees(rawHeading);
  const movement = normalizeDegrees(movementHeading);
  return raw === null || movement === null ? null : normalizeDegrees(movement - raw);
}

export function applyHeadingOffset(rawHeading, offset = 0) {
  const raw = normalizeDegrees(rawHeading);
  return raw === null ? null : normalizeDegrees(raw + (Number(offset) || 0));
}

function normalizedKey(value) {
  if (value === ' ') return 'Space';
  return String(value || '').trim();
}

export function remoteEventTokens(input = {}) {
  const tokens = [];
  const key = normalizedKey(input.key);
  const code = normalizedKey(input.code);
  if (key && key !== 'Unidentified') tokens.push(`key:${key}`);
  if (code && code !== 'Unidentified') tokens.push(`code:${code}`);
  const keyCode = Number(input.keyCode ?? input.which);
  if (Number.isFinite(keyCode) && keyCode > 0) tokens.push(`keyCode:${keyCode}`);
  return [...new Set(tokens)];
}

export function remoteEventSignature(input = {}) {
  return remoteEventTokens(input)[0] || '';
}

const DEFAULT_REMOTE_A = new Set([
  'key:AudioVolumeUp', 'key:VolumeUp', 'code:AudioVolumeUp', 'code:VolumeUp',
  'key:F4', 'code:F4', 'keyCode:115', 'key:Enter', 'code:Enter', 'keyCode:13',
  'key:Camera', 'code:Camera'
]);
const DEFAULT_REMOTE_B = new Set([
  'key:AudioVolumeDown', 'key:VolumeDown', 'code:AudioVolumeDown', 'code:VolumeDown',
  'key:F3', 'code:F3', 'keyCode:114', 'key:Space', 'code:Space', 'keyCode:32',
  'key:MediaPlayPause', 'code:MediaPlayPause'
]);

export function remoteSlotFromInput(input = {}, settings = {}) {
  const tokens = remoteEventTokens(input);
  if (!tokens.length) return null;
  if (settings.keyA && tokens.includes(settings.keyA)) return 'A';
  if (settings.keyB && tokens.includes(settings.keyB)) return 'B';
  if (tokens.some(token => DEFAULT_REMOTE_A.has(token))) return 'A';
  if (tokens.some(token => DEFAULT_REMOTE_B.has(token))) return 'B';
  return null;
}

export function remoteSignalLabel(signature) {
  if (!signature) return 'automatyczne wykrywanie';
  return String(signature).replace(/^key(Code)?:/, '').replace(/^code:/, '');
}
