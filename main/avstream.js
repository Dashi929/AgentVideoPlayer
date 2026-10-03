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
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const media = require('./media');
const mkvindex = require('./mkvindex');

const IDLE_MS = 10 * 60 * 1000;
// 混合起播策略：视频拷贝只能从关键帧起切，遇到长 GOP（如蓝光原盘 9 秒+）拖动/续播会
// 回跳一大截。距关键帧超过 GAP_COPY_MAX 秒时改为转码视频（libx264 veryfast，1080p 可达
// 数倍实时），从精确位置起播——代价是 CPU，收益是拖哪就从哪播。更高分辨率仍走关键帧
// 对齐拷贝，避免 4K 转码压垮 CPU。
const GAP_COPY_MAX = 1.5;
const TRANSCODE_MAX_HEIGHT = 1440;

/** 网络路径（UNC）：直放时 Chromium 深定位有病理性慢路径，这类文件一律走本地流 */
function isNetworkPath(file) {
  return typeof file === 'string' && (file.startsWith('\\\\') || file.startsWith('//'));
}

// 诊断开关（AVP_STREAM_DEBUG=1）：输出预热/采用/重启决策日志，排查流问题时启用
const DBG = !!process.env.AVP_STREAM_DEBUG;
const dbg = (...a) => { if (DBG) console.error('[avstream]', ...a); };

const sessions = new Map(); // id -> { file, startAt, info, videoCopy, audioIndex, audioCopy, proc, lastUsed, prefetch }
let server = null;
let port = 0;
let listenReady = null;

// 预热（悬停/按下时提前起流）：缓存上限与未采用时的存活时间
const PREFETCH_CAP = 8 * 1024 * 1024;
const PREFETCH_TTL_MS = 8000;

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
    // frag_duration：不等到下一个关键帧才封分片（长 GOP 源第一片要攒数秒数据，
    // 浏览器要等它才出画）；每 0.5 秒封一片，首片秒出。min 置 0 保证严格生效
    '-frag_duration', '500000', '-min_frag_duration', '0',
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

/** 丢弃未采用的预热进程 */
function killPrefetch(sess) {
  const pf = sess && sess.prefetch;
  if (!pf) return;
  sess.prefetch = null;
  clearTimeout(pf.timer);
  try { pf.proc.kill(); } catch { /* 已退出 */ }
}

/**
 * 探测 T 之前最近的关键帧位置（重复 seek/假结束续播零开销）。
 * 视频流是拷贝时只能从关键帧起切；如果直接 -ss T（T 在 GOP 中间），拷出的视频开头
 * 带着无法解码的残帧，Chromium 会丢弃到下一个关键帧才出画，而音频从 T 正常播 →
 * 音画出现 T-K 的固定错位。所以 seek 前先探测关键帧、按关键帧对齐起播。
 *
 * 优先查 MKV Cues 索引（解析 15-60ms、缓存命中 0ms，实测与 ffmpeg 探测逐点吻合）；
 * 无索引/非 MKV/解析失败才回退 ffmpeg 解码探测（~350-400ms）。
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
  // 索引快路径（同步读 100KB 级索引 + 解析，毫秒级；有缓存时近零）
  try {
    const times = mkvindex.parseCuesSync(file);
    const k = mkvindex.keyframeAtOrBefore(times, t);
    if (k != null && Number.isFinite(k) && k >= 0) {
      kfCache.set(key, k);
      if (kfCache.size > 100) kfCache.delete(kfCache.keys().next().value);
      return Promise.resolve(k);
    }
  } catch { /* 回退 ffmpeg */ }
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
  killProc(sess); // 顶掉当前流的进程（旧连接即使未关闭也不能再占用）
  // 采用预热进程：与本次定位目标完全一致时，直接接管已缓冲的输出（点击即切、无需重启等待）
  const pf = sess.prefetch;
  if (pf) {
    dbg('spawnFor: prefetch found', JSON.stringify({ pfStart: pf.cfg.startAt, sessStart: sess.startAt, pfCopy: pf.cfg.videoCopy, sessCopy: sess.videoCopy, exit: pf.proc.exitCode, sig: pf.proc.signalCode, bytes: pf.bytes, match: pf.cfg.startAt === sess.startAt && pf.cfg.videoCopy === sess.videoCopy }));
  } else {
    dbg('spawnFor: no prefetch; sessStart=', sess.startAt);
  }
  if (pf
    && pf.cfg.startAt === sess.startAt && pf.cfg.videoCopy === sess.videoCopy
    && pf.cfg.audioCopy === sess.audioCopy && pf.cfg.audioIndex === sess.audioIndex
    && pf.proc.exitCode == null && pf.proc.signalCode == null) {
    dbg('spawnFor: ADOPT prefetch bytes=', pf.bytes);
    sess.prefetch = null;
    clearTimeout(pf.timer);
    sess.proc = pf.proc;
    sess.lastUsed = Date.now();
    attachProc(sess, pf.proc, res);
    try { for (const c of pf.chunks) res.write(c); } catch { /* 断开则忽略 */ }
    pf.chunks = [];
    pf.proc.stdout.pipe(res);
    try { pf.proc.stdout.resume(); } catch { /* 忽略 */ } // 缓冲满暂停过则恢复流动（先 pipe 再 resume，避免丢数据）
    return;
  }
  killPrefetch(sess);
  let proc;
  try {
    proc = spawn(media.ffmpegPath(), argsFor(sess), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    res.destroy();
    return;
  }
  sess.proc = proc;
  sess.lastUsed = Date.now();
  attachProc(sess, proc, res);
  proc.stdout.pipe(res);
}

/** 进程与响应的公共接线：错误/退出/连接关闭（采用预热进程与常规启动共用） */
function attachProc(sess, proc, res) {
  proc.stderr.on('data', d => { proc._errTail = ((proc._errTail || '') + String(d)).slice(-2000); });
  proc.on('error', (e) => {
    console.error('[avstream] ffmpeg 启动失败:', e.message, 'path:', media.ffmpegPath());
    if (sess.proc === proc) sess.proc = null;
    try { res.destroy(); } catch { /* 已断开 */ }
  });
  proc.on('exit', code => {
    if (code && code !== 0) console.error('[avstream] ffmpeg 异常退出 code=' + code, String(proc._errTail || '').split('\n').slice(-3).join(' | '));
    if (sess.proc === proc) sess.proc = null; // 已被新进程顶替时不动新进程的记录
    if (res.writableEnded || res.destroyed) return;
    if (code === 0) res.end();          // 正常播完
    else try { res.destroy(); } catch { /* 已断开 */ } // 异常断流 → 渲染层走播放错误浮层
  });
  res.on('close', () => {
    // 只在当前进程仍属于这条响应时才杀：旧连接的 close 不能误杀新 ffmpeg
    // （否则拖动重启时新流会被旧响应掐断，表现为断流/播放错误浮层）
    if (sess.proc === proc) killProc(sess);
  });
  res.on('error', () => { if (sess.proc === proc) killProc(sess); });
}

/**
 * 预热指定位置：解析定位点并提前启动 ffmpeg，把输出缓冲起来（≤8MB）。
 * 渲染层在进度条悬停/按下时调用；随后 seek 到同一位置时 spawnFor 直接采用，
 * 点击到出画几乎没有等待。未采用则 TTL 后自动回收。
 */
async function prepare(id, t, immediate) {
  const s = sessions.get(id);
  if (!s) { dbg('prepare: no session', id); return false; }
  const at = Math.max(0, +t || 0);
  const { key, videoCopy } = await resolveKeyframe(s, at);
  dbg('prepare: t=', at.toFixed(2), 'key=', key, 'copy=', videoCopy, 'immediate=', !!immediate, 'sessStart=', s.startAt, 'sessCopy=', s.videoCopy);
  // 与当前流起点相同：跳回这里在缓冲范围内直接完成，无需预热
  if (key === s.startAt && videoCopy === s.videoCopy) { dbg('prepare: same as current, skip'); return true; }
  if (s.prefetch && s.prefetch.cfg.startAt === key && s.prefetch.cfg.videoCopy === videoCopy
    && s.prefetch.cfg.audioCopy === s.audioCopy && s.prefetch.cfg.audioIndex === s.audioIndex
    && s.prefetch.proc.exitCode == null && s.prefetch.proc.signalCode == null) {
    dbg('prepare: already prefetched same key');
    return true; // 同位预热已就绪
  }
  killPrefetch(s);
  // 悬停预热（非 immediate）：先把目标 cluster 预读进系统缓存，SMB 重复读命中缓存从
  // 秒级降到毫秒级，ffmpeg 随后读同一区域几乎零等待（实测 moof 产出 110-163ms → 74-81ms）。
  // 按下瞬时（immediate）：预读会延迟 ffmpeg 启动、得不偿失——直接起流。
  if (!immediate) {
    const off = mkvindex.keyframeEntryAtOrBefore(mkvindex.parseCuesEntriesSync(s.file), key)?.off;
    if (typeof off === 'number' && off > 0) {
      await new Promise((resolve) => {
        const fd = fs.openSync(s.file, 'r');
        const len = Math.min(8 * 1024 * 1024, Math.max(0, fs.fstatSync(fd).size - off));
        const buf = Buffer.alloc(len);
        fs.read(fd, buf, 0, len, off, () => { try { fs.closeSync(fd); } catch { /* 忽略 */ } resolve(); });
      }).catch(() => {});
      dbg('prepare: preread done off=', off);
    }
  }
  // 预读期间用户可能已完成跳转（目标成了当前流起点）：此时无需再起预热进程
  if (s.startAt === key) { dbg('prepare: became current during preread, skip spawn'); return true; }
  const cfg = { file: s.file, startAt: key, videoCopy, audioCopy: s.audioCopy, audioIndex: s.audioIndex };
  let proc;
  try {
    proc = spawn(media.ffmpegPath(), argsFor(cfg), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return false; }
  dbg('prepare: spawned prefetch key=', key);
  const pf = { cfg, proc, chunks: [], bytes: 0, timer: null, at: Date.now() };
  s.prefetch = pf;
  dbg('prepare: pid=', proc.pid, 'file=', cfg.file.slice(-24));
  proc.on('spawn', () => dbg('prefetch spawn event pid=', proc.pid));
  proc.stdout.on('data', d => {
    if (s.prefetch !== pf) return;
    if (pf.bytes === 0) dbg('prefetch first data', d.length, 'after', Date.now() - pf.at, 'ms');
    pf.bytes += d.length;
    pf.chunks.push(d);
    if (pf.bytes >= PREFETCH_CAP) proc.stdout.pause(); // 缓冲满则暂停读取（ffmpeg 随之阻塞）
  });
  proc.stderr.on('data', d => { proc._errTail = ((proc._errTail || '') + String(d)).slice(-2000); if (DBG) dbg('prefetch stderr', String(d).slice(0, 160)); });
  proc.on('error', () => { if (s.prefetch === pf) s.prefetch = null; });
  proc.on('exit', () => { if (s.prefetch === pf) s.prefetch = null; });
  pf.timer = setTimeout(() => killPrefetch(s), PREFETCH_TTL_MS);
  return true;
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
 * 决策一次定位的起点与视频模式（纯函数，不改会话状态），返回 { key, videoCopy }：
 * - 纯直拷会话（remux，源编码浏览器可直接解码的网络大文件）：视频始终拷贝，
 *   定位对齐到关键帧——打开/跳转由 ffmpeg 完成全部磁盘 I/O，避开 Chromium
 *   直读网络文件时深定位的病理性慢路径，也避免高分辨率实时转码压垮 CPU；
 * - 视频可拷贝且分辨率不高：探测 t 之前最近关键帧 k；t-k 很小 → 拷贝并对齐到 k；
 *   t-k 很大（长 GOP）→ 转码视频从精确 t 起播，消除最大可达数秒的回跳；
 * - 视频本就不能拷贝：转码从精确 t 起播（ffmpeg 精确 seek），无需关键帧探测。
 */
async function resolveKeyframe(sess, t) {
  const info = sess.info;
  if (sess.remux && info.videoCopyable) {
    if (t > 0) t = Math.max(0, await keyframeBefore(sess.file, t));
    return { key: t, videoCopy: true };
  }
  let copy = !!info.videoCopyable && (info.videoHeight || 0) <= TRANSCODE_MAX_HEIGHT;
  if (copy && t > 0) {
    const k = await keyframeBefore(sess.file, t);
    if (t - k > GAP_COPY_MAX) copy = false;
    else t = k;
  }
  return { key: t, videoCopy: copy };
}

/** 应用定位决策到会话，返回实际起点（渲染层用作显示偏移） */
async function resolveStart(sess, t) {
  const { key, videoCopy } = await resolveKeyframe(sess, t);
  sess.videoCopy = videoCopy;
  return key;
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
  // 网络路径且视频编码可直拷 → 纯 remux 会话：音视频直接拷贝（近零 CPU），
  // 定位对齐关键帧，规避 Chromium 直读网络文件深定位的病理性慢路径
  sess.remux = isNetworkPath(file) && !!info.videoCopyable;
  setAudioTrack(sess, audioIndex);
  sess.startAt = await resolveStart(sess, Math.max(0, +startAt || 0));
  sessions.set(id, sess);
  // 后台预热关键帧索引：让随后的跳转直接命中缓存（解析 15-60ms，放后台避免抢启动带宽）
  setImmediate(() => { try { mkvindex.warm(file); } catch { /* 忽略 */ } });
  return { id, url: `http://127.0.0.1:${port}/av/${id}`, offset: sess.startAt, audioIndex: sess.audioIndex, remux: !!sess.remux };
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
  killPrefetch(s);
  sessions.delete(id);
}

function stopAll() {
  for (const s of sessions.values()) { killProc(s); killPrefetch(s); }
  sessions.clear();
}

module.exports = { start, seek, prepare, stop, stopAll };
