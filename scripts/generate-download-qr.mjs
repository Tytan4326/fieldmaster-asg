import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, 'public', 'downloads');
const pngPath = resolve(outputDirectory, 'Fieldmaster-android-qr.png');
const svgPath = resolve(outputDirectory, 'Fieldmaster-android-qr.svg');
const downloadUrl =
  process.env.FM_APK_URL ||
  'https://fieldmaster-t8t4.onrender.com/downloads/Fieldmaster-android.apk';

mkdirSync(outputDirectory, { recursive: true });

const options = {
  errorCorrectionLevel: 'H',
  margin: 4,
  color: {
    dark: '#07110B',
    light: '#FFFFFF',
  },
};

await QRCode.toFile(pngPath, downloadUrl, {
  ...options,
  type: 'png',
  width: 1024,
});
await QRCode.toFile(svgPath, downloadUrl, {
  ...options,
  type: 'svg',
  width: 1024,
});

const png = PNG.sync.read(readFileSync(pngPath));
const decoded = jsQR(
  new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  png.width,
  png.height,
);

if (!decoded || decoded.data !== downloadUrl) {
  throw new Error(
    `Weryfikacja QR nie powiodła się. Odczytano: ${decoded?.data || 'brak danych'}`,
  );
}

console.log(`QR zweryfikowany: ${decoded.data}`);
console.log(`PNG: ${pngPath}`);
console.log(`SVG: ${svgPath}`);
