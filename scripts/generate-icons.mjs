import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const name = Buffer.from(type); const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length); return output;
}
function icon(size) {
  const pixels = Buffer.alloc(size * size * 4); const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (Math.floor(y) * size + Math.floor(x)) * 4; pixels.set(color, i);
  };
  const dark = [8, 12, 9, 255], lime = [163, 255, 79, 255], green = [26, 45, 25, 255];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) set(x, y, dark);
  const cx = size / 2, cy = size / 2, radius = size * .43;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if ((x-cx)**2+(y-cy)**2 < radius**2) set(x,y,green);
  const line = (x1,y1,x2,y2,width,color) => { const steps=Math.ceil(Math.max(Math.abs(x2-x1),Math.abs(y2-y1)));for(let s=0;s<=steps;s+=1){const x=x1+(x2-x1)*s/steps,y=y1+(y2-y1)*s/steps;for(let dy=-width;dy<=width;dy+=1)for(let dx=-width;dx<=width;dx+=1)if(dx*dx+dy*dy<=width*width)set(x+dx,y+dy,color);}};
  const w=Math.max(2,Math.round(size*.012));
  line(size*.28,size*.23,size*.72,size*.23,w,lime);line(size*.28,size*.23,size*.28,size*.62,w,lime);line(size*.72,size*.23,size*.72,size*.62,w,lime);line(size*.28,size*.62,size*.5,size*.79,w,lime);line(size*.72,size*.62,size*.5,size*.79,w,lime);
  const fw=Math.round(size*.055);line(size*.42,size*.36,size*.42,size*.64,fw,lime);line(size*.42,size*.36,size*.61,size*.36,fw,lime);line(size*.42,size*.49,size*.57,size*.49,fw,lime);
  const raw = Buffer.alloc((size * 4 + 1) * size); for (let y = 0; y < size; y += 1) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

const output = path.resolve('public');
for (const size of [192, 512]) fs.writeFileSync(path.join(output, `icon-${size}.png`), icon(size));
console.log('Wygenerowano ikony PWA 192×192 i 512×512.');
