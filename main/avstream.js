/**
 * 本地实时转码流：播放所选音轨用的 127.0.0.1 HTTP 流。两种场景：
 * 1. 内置播放器（Chromium）解不了的音轨（AC3/E-AC3/DTS 等）→ 音频转 AAC；
 * 2. 多音轨文件切换到非默认轨（Chromium 的 <video> 只能播默认轨，也没有 audioTracks
 *    切换接口）→ 若所选轨本身是 AAC 则 -c:a copy 直通混流（几乎零延迟、不耗 CPU），
 *    否则同样转 AAC。视频优先 copy（起播点距关键帧太远时改转码以精确对齐，
 *    见 GAP_COPY_MAX），以 fragmented MP4 分块推给 <video>。
 *
 * 流是不定长的直播式响应：渲染层在缓冲范围内可以正常定位，范围外（拖到远处/回跳）
 * 由渲染层先调 seek() 更新会话起点、再重新 load 同一个 URL，服务端按请求重启 ffmpeg；
 * seek() 同时可换音轨（更新映射后重启同一个 URL）。
 */
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const media = require('./media');

const IDLE_MS = 10 * 60 * 1000;
// 混合起播策略：视频拷贝只能从关键帧起切，遇到长 GOP（如蓝光原盘 9 秒+）拖动/续播会
// 回跳一大截。距关键帧超过 GAP_COPY_MAX 秒时改为转码视频（libx264 veryfast，1080p 可达
// 数倍实时），从精确位置起播——代价是 CPU，收益是拖哪就从哪播。更高分辨率仍走关键帧
// 对齐拷贝，避免 4K 转码压垮 CPU。
const GAP_COPY_MAX = 1.5;
const TRANSCODE_MAX_HEIGHT = 1440;

const sessions = new Map(); // id -> { file, startAt, info, videoCopy, audioIndex, audioCopy, proc, lastUsed }
let server = null;
let port = 0;
let listenReady = null;

function argsFor(sess) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error',
    // nobuffer：跳过输入端初始缓冲，缩短起播延迟；genpts 补全缺失时间戳
    '-fflags', '+genpts+nobuffer'];
  if (sess.startAt > 0) args.push('-ss', String(sess.startAt));
  args.push('-i', sess.file, '-map', '0:v:0', '-map', `0:a:${sess.audioIndex || 0}`);
  if (sess.videoCopy) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  if (sess.audioCopy) args.push('-c:a', 'copy'); // AAC 直通混流：不起编码器，秒级出声
  else args.push('-c:a', 'aac', '-b:a', '320k');
  args.push('-sn', '-dn', '-muxdelay', '0',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4', '-movflags', 'empty_moov+frag_keyframe+default_base_moof', 'pipe:1');
  return args;
}

function killProc(sess) {
  if (sess.proc) {
    const p = sess.proc;
    sess.proc = null;
    try { p.kill(); } catch { /* 已退出 */ }
  }
}

/**
 * 探测 T 之前最近的关键帧位置（结果按 文件+时间 缓存，重复 seek/假结束续播零开销）。
 * 视频流是拷贝时只能从关键帧起切；如果直接 -ss T（T 在 GOP 中间），拷出的视频开头
 * 带着无法解码的残帧，Chromium 会丢弃到下一个关键帧才出画，而音频从 T 正常播 →
 * 音画出现 T-K 的固定错位。所以 seek 前先探测关键帧、按关键帧对齐起播。
 */
const kfCache = new Map(); // "file|t(0.1s精度)" -> 关键帧位置，LRU 上限 100
function keyframeBefore(file, t) {
  const key = `${file.toLowerCase()}|${Math.round(t * 10) / 10}`;
  if (kfCache.has(key)) {
    const v = kfCache.get(key);
    kfCache.delete(key);
    kfCache.set(key, v); // 触碰一次，保持 LRU 顺序
    return Promise.resolve(v);
  }
  return new Promise((resolve) => {
    execFile(media.ffmpegPath(), [
      '-hide_banner', '-nostdin', '-v', 'info', '-ss', String(t), '-copyts', '-noaccurate_seek',
      '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-',
    ], { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const m = String(stderr).match(/showinfo.*n: *0 .*pts_time:([0-9.-]+)/);
      const k = m ? parseFloat(m[1]) : NaN;
      const r = Number.isFinite(k) && k >= 0 ? k : t;
      kfCache.set(key, r);
      if (kfCache.size > 100) kfCache.delete(kfCache.keys().next().value);
      resolve(r);
    });
  });
}

/** 为一次 HTTP 请求启动 ffmpeg，把转码输出推给该响应 */
function spawnFor(sess, res) {
  killProc(sess);
  let proc;
  try {
    proc = spawn(media.ffmpegPath(), argsFor(sess), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    res.destroy();
    return;
  }
  sess.proc = proc;
  sess.lastUsed = Date.now();
  let errTail = '';
  proc.stderr.on('data', d => { errTail = (errTail + String(d)).slice(-2000); });
  proc.stdout.pipe(res);
  proc.on('error', (e) => {
    console.error('[avstream] ffmpeg 启动失败:', e.message, 'path:', media.ffmpegPath());
    sess.proc = null;
    try { res.destroy(); } catch { /* 已断开 */ }
  });
  proc.on('exit', code => {
    if (code && code !== 0) console.error('[avstream] ffmpeg 异常退出 code=' + code, errTail.split('\n').slice(-3).join(' | '));
    sess.proc = null;
    if (res.writableEnded || res.destroyed) return;
    if (code === 0) res.end();          // 正常播完
    else try { res.destroy(); } catch { /* 已断开 */ } // 异常断流 → 渲染层走播放错误浮层
  });
  res.on('close', () => killProc(sess));
  res.on('error', () => killProc(sess));
}

function ensureServer() {
  if (listenReady) return listenReady;
  listenReady = new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const id = new URL(req.url, 'http://x').pathname.replace(/^\/av\//, '');
      const sess = sessions.get(id);
      if (!sess) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*', // 配合 video.crossOrigin，保证 canvas 截图不被污染
      });
      spawnFor(sess, res);
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    setInterval(() => {
      for (const [id, s] of sessions) {
        if (!s.proc && Date.now() - s.lastUsed > IDLE_MS) sessions.delete(id);
      }
    }, 60 * 1000).unref();
  });
  return listenReady;
}

/** 会话的音轨序号合法化，并同步 AAC 直通标记 */
function setAudioTrack(sess, audioIndex) {
  const tracks = sess.info.audioTracks || [];
  let idx = Math.max(0, +audioIndex || 0);
  if (tracks.length) idx = Math.min(idx, tracks.length - 1);
  sess.audioIndex = idx;
  sess.audioCopy = tracks.length ? tracks[idx].codec === 'aac' : false;
  return idx;
}

/**
 * 决定一次会话/定位的起点与视频模式，返回实际起点（渲染层用作显示偏移）：
 * - 视频可拷贝且分辨率不高：探测 t 之前最近关键帧 k；t-k 很小 → 拷贝并对齐到 k；
 *   t-k 很大（长 GOP）→ 转码视频从精确 t 起播，消除最大可达数秒的回跳；
 * - 视频本就不能拷贝：转码从精确 t 起播（ffmpeg 精确 seek），无需关键帧探测。
 */
async function resolveStart(sess, t) {
  const info = sess.info;
  let copy = !!info.videoCopyable && (info.videoHeight || 0) <= TRANSCODE_MAX_HEIGHT;
  if (copy && t > 0) {
    const k = await keyframeBefore(sess.file, t);
    if (t - k > GAP_COPY_MAX) copy = false;
    else t = k;
  }
  sess.videoCopy = copy;
  return t;
}

/**
 * 创建转码会话。探测失败或无音轨时返回 null（调用方继续用原文件）。
 * 单播放窗口：新会话顶掉所有旧会话。
 */
async function start({ file, startAt = 0, audioIndex = 0 }) {
  const info = await media.probeMedia(file);
  if (!info.ok || !info.hasAudio) return null;
  await ensureServer();
  stopAll();
  const id = crypto.randomBytes(12).toString('hex');
  const sess = { file, info, proc: null, lastUsed: Date.now() };
  setAudioTrack(sess, audioIndex);
  sess.startAt = await resolveStart(sess, Math.max(0, +startAt || 0));
  sessions.set(id, sess);
  return { id, url: `http://127.0.0.1:${port}/av/${id}`, offset: sess.startAt, audioIndex: sess.audioIndex };
}

/**
 * 更新会话起点（按混合策略返回实际起点，渲染层用作显示偏移）；
 * 传 audioIndex 时同时切换会话音轨（渲染层随后重新 load 同一 URL 生效）。
 */
async function seek(id, t, audioIndex) {
  const s = sessions.get(id);
  if (!s) return null;
  if (audioIndex != null && (s.info.audioTracks || []).length) setAudioTrack(s, audioIndex);
  const at = Math.max(0, +t || 0);
  s.startAt = await resolveStart(s, at);
  s.lastUsed = Date.now();
  return s.startAt;
}

function stop(id) {
  const s = sessions.get(id);
  if (!s) return;
  killProc(s);
  sessions.delete(id);
}

function stopAll() {
  for (const s of sessions.values()) killProc(s);
  sessions.clear();
}

module.exports = { start, seek, stop, stopAll };
