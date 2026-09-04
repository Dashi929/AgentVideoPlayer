// 把 PNG 包装成 ICO（Vista+ 支持 PNG 直接作为图标项，256x256 单条目）
const fs = require('fs');
const [pngPath, icoPath] = process.argv.slice(2);
const png = fs.readFileSync(pngPath);
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0);   // reserved
head.writeUInt16LE(1, 2);   // type: icon
head.writeUInt16LE(1, 4);   // count
head.writeUInt8(0, 6);      // width 256 (0 = 256)
head.writeUInt8(0, 7);      // height 256
head.writeUInt8(0, 8);      // color count
head.writeUInt8(0, 9);      // reserved
head.writeUInt16LE(1, 10);  // planes
head.writeUInt16LE(32, 12); // bit count
head.writeUInt32LE(png.length, 14);
head.writeUInt32LE(22, 18); // offset
fs.writeFileSync(icoPath, Buffer.concat([head, png]));
console.log('ICO saved:', icoPath, png.length + 22, 'bytes');
