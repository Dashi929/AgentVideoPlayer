/**
 * 极简 HTTP 流媒体服务：把片库视频以 http 形式提供给 DLNA 电视等设备。
 * 支持 Range 请求，视频通过库内 id 引用，只在投屏期间运行。
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const db = require('./db');

let server = null;
let port = 0;

function localIp() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function ensureServer() {
  if (server) return port;
  server = http.createServer((req, res) => {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const v = id && db.getVideo(id);
    if (!v || !fs.existsSync(v.path)) {
      res.writeHead(404).end('not found');
      return;
    }
    const stat = fs.statSync(v.path);
    const range = req.headers.range;
    const headers = {
      'Content-Type': 'video/mp4', // DLNA 设备普遍接受 mp4 标记
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m[1] ? parseInt(m[1]) : 0;
      let end = m[2] ? parseInt(m[2]) : stat.size - 1;
      start = Math.min(start, stat.size - 1);
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(v.path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      fs.createReadStream(v.path).pipe(res);
    }
  });
  server.listen(0, () => { port = server.address().port; });
  return port;
}

function streamUrl(id) {
  const p = ensureServer();
  return `http://${localIp()}:${p}/stream?id=${id}`;
}

module.exports = { streamUrl, localIp };
