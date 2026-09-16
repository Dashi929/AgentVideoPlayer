import { toast, goBack } from './app.js';
import { icon } from './icons.js';

const videoEl = document.getElementById('videoEl');
const wrap = document.getElementById('playerWrap');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const muteBtn = document.getElementById('muteBtn');
const topMuteBtn = document.getElementById('topMuteBtn');
const timeLabel = document.getElementById('timeLabel');
const progressBar = document.getElementById('progressBar');
const progressPlayed = document.getElementById('progressPlayed');
const progressBuffered = document.getElementById('progressBuffered');
const progressDot = document.getElementById('progressDot');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const playerTitle = document.getElementById('playerTitle');
const resBadge = document.getElementById('resBadge');
const speedBtn = document.getElementById('speedBtn');
const subBtn = document.getElementById('subBtn');
const audioBtn = document.getElementById('audioBtn');
const listBtn = document.getElementById('listBtn');
const setBtn = document.getElementById('setBtn');
const menuLayer = document.getElementById('menuLayer');
const snapBtn = document.getElementById('snapBtn');
const pipBtn = document.getElementById('pipBtn');
const picBtn = document.getElementById('picBtn');
const castBtn = document.getElementById('castBtn');
const volumeSlider = document.getElementById('volumeSlider');
const volumeOsd = document.getElementById('volumeOsd');
const osdFill = document.getElementById('osdFill');
const osdPct = document.getElementById('osdPct');
const osdIcon = document.getElementById('osdIcon');
const seekPreview = document.getElementById('seekPreview');
const previewCanvas = document.getElementById('previewCanvas');
const previewTime = document.getElementById('previewTime');

let current = null;      // 当前视频
let fileUrl = null;      // 当前视频的 file:// URL（进度条预览用，预览需要可定位的原始文件）
let playlist = [];       // 播放列表（片库当前排序）
let saveTimer = null;
let hideTimer = null;
let refreshLibrary = () => {};
let trackEl = null;      // 当前字幕 track
let picSettings = { brightness: 100, contrast: 100, saturate: 100, hue: 0, fill: false };
let stream = null;       // 实时转码会话 { id, dur, offset }（所选音轨不能直接播时启用；offset=当前会话起点，界面时间=currentTime+offset）
let restarting = false;  // 转码流拖动重启期间，忽略旧连接断开产生的 error/ended
let probeSeq = 0;        // 音轨异步探测的代次，防止慢探测结果串台
let lastFalseEnd = { t: 0, at: 0 }; // 假结束守卫：20 秒内同一位置反复假结束 = 真结尾
let barHover = false;    // 鼠标悬在进度条上时不自动收控制条/预览
let audioTracks = [];    // 当前文件的音轨明细（probe.audioTracks）
let audioIdx = -1;       // 转码流正在播的音轨下标；-1 = 未知（直接播放时以默认轨为准）

function fmt(s) {
  if (!isFinite(s)) return '00:00';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 有效时长：转码流的 videoEl.duration 是直播式 Infinity，逐级兜底到探测时长/库记录时长 */
const knownDur = () =>
  (stream && stream.dur) ||
  (isFinite(videoEl.duration) ? videoEl.duration : 0) ||
  (current && current.duration) || 0;
/** 界面显示/记忆用的播放位置：转码流的时间轴每次重启都从 0 开始，加上会话起点才是影片真实位置 */
const dispTime = () => videoEl.currentTime + (stream ? stream.offset : 0);

const CODEC_NAMES = {
  aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC',
  ac3: 'AC3', eac3: 'E-AC3', dts: 'DTS', dca: 'DTS', truehd: 'TrueHD',
};
function codecLabel(codecs) {
  return (codecs || []).map(c => CODEC_NAMES[c] || String(c).toUpperCase()).join('/');
}

// ---- 音轨选择 ----
const LANG_NAMES = {
  chi: '中文', zho: '中文', eng: '英语', jpn: '日语', kor: '韩语', fre: '法语', fra: '法语',
  ger: '德语', deu: '德语', spa: '西班牙语', rus: '俄语', por: '葡萄牙语', ita: '意大利语',
  tha: '泰语', vie: '越南语', hin: '印地语', cant: '粤语',
};
function trackLabel(t, i) {
  const parts = [`音轨 ${i + 1}`];
  if (t.lang && t.lang !== 'und') parts.push(LANG_NAMES[t.lang.toLowerCase()] || t.lang.toUpperCase());
  parts.push(CODEC_NAMES[t.codec] || String(t.codec || '').toUpperCase());
  if (t.channels) parts.push(t.channels);
  if (t.default) parts.push('默认');
  return parts.join(' · ');
}
const prefKey = () => 'avp_audio:' + (current ? current.path : '');
/** 默认轨下标（Chromium 直接播放的就是它）；没有标记默认时取第一条 */
function defaultTrackIdx(tracks) {
  const i = (tracks || []).findIndex(t => t.default);
  return i >= 0 ? i : 0;
}
/** 会播出来的音轨下标：上次手动选过的优先，否则用默认轨 */
function prefTrackIdx(info) {
  const tracks = info?.audioTracks || [];
  if (!tracks.length) return 0;
  const saved = parseInt(localStorage.getItem(prefKey()), 10);
  if (Number.isInteger(saved) && saved >= 0 && saved < tracks.length) return saved;
  return defaultTrackIdx(tracks);
}
/** 这条音轨是否必须走转码/重混流：编码不支持，或不是直接播放时的默认轨 */
function trackNeedsStream(info, idx) {
  const tracks = info?.audioTracks || [];
  if (!tracks.length) return !!(info && info.hasAudio && !info.audioSupported); // 无明细的旧探测结果
  const t = tracks[Math.max(0, Math.min(idx || 0, tracks.length - 1))];
  return !t.supported || idx !== defaultTrackIdx(tracks);
}

// ---- 控制条自动隐藏 ----
function showControls() {
  wrap.classList.remove('controls-hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!videoEl.paused && !menuLayerVisible() && !barHover) {
      wrap.classList.add('controls-hidden');
      hideSeekPreview();
    }
  }, 2800);
}
function menuLayerVisible() { return !menuLayer.classList.contains('hidden'); }
wrap.addEventListener('mousemove', showControls);
wrap.addEventListener('click', showControls);

// ---- 弹层菜单 ----
function openPopup(anchorEl, build) {
  closePopup();
  menuLayer.classList.remove('hidden');
  const pop = document.createElement('div');
  pop.className = 'popup';
  build(pop);
  menuLayer.appendChild(pop);
  // 以 playerWrap 为坐标系：默认锚点上方弹出、右缘对齐；
  // 按弹窗实际尺寸水平/垂直夹取，保证完整落在窗口内（左侧竖栏按钮也能正常显示）
  const wr = wrap.getBoundingClientRect();
  const pr = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const m = 10; // 与窗口边缘的最小间距
  const aTop = pr.top - wr.top, aBottom = pr.bottom - wr.top;
  const aRight = pr.right - wr.left;
  // 垂直：上方放不下且下方放得下 → 改为锚点下方弹出
  const below = ph + m > aTop && aBottom + ph + m <= wr.height - m;
  if (below) {
    pop.style.top = (aBottom + m) + 'px';
    pop.style.bottom = 'auto';
  } else {
    let bottom = wr.height - aTop + m;
    if (bottom + ph > wr.height - m) bottom = Math.max(m, wr.height - m - ph);
    pop.style.bottom = bottom + 'px';
    pop.style.top = 'auto';
  }
  // 水平：右缘先对齐锚点右缘，再夹取左缘不越界
  let right = wr.width - aRight;
  if (wr.width - right - pw < m) right = Math.max(m, wr.width - m - pw);
  pop.style.right = right + 'px';
  pop.style.left = 'auto';
}
function closePopup() {
  menuLayer.classList.add('hidden');
  menuLayer.innerHTML = '';
}
menuLayer.addEventListener('click', (e) => { if (e.target === menuLayer) closePopup(); });

function menuItem(pop, label, active, fn) {
  const d = document.createElement('div');
  d.className = 'pitem' + (active ? ' active' : '');
  d.textContent = label;
  d.addEventListener('click', () => { fn(); closePopup(); });
  pop.appendChild(d);
}

// ---- 播放核心 ----
function playVideo(video) {
  hidePlayError();
  stopStream();
  audioTracks = [];
  audioIdx = -1;
  const seq = ++probeSeq;
  return window.api.readVideo(video.path).then(async res => {
    if (seq !== probeSeq) return;
    current = res.video;
    fileUrl = res.url;
    playerTitle.textContent = current.virtualName || current.title || current.name;
    removeSubtitle();
    resetPreviewSource();

    // 先探测再决定播放方式（未缓存的首次探测约几百 ms）：若留到播放中异步探测，
    // 转码流就位会吞掉"续播到上次位置"的定位逻辑，导致每次冷启动都从片头重播
    let probe = res.audio;
    if (!probe && window.api.probeAudio) {
      probe = await window.api.probeAudio(current.path).catch(() => null);
      if (seq !== probeSeq) return;
    }
    if (probe && probe.ok && probe.hasAudio) {
      audioTracks = probe.audioTracks || [];
      const idx = prefTrackIdx(probe);
      if (trackNeedsStream(probe, idx)) {
        // 所选音轨不能直接播（默认轨编码不支持，或上次选的不是默认轨）：
        // 以转码流起播（含上次进度），AAC 轨是直通混流、其他轨实时转码
        startStream(probe, resumeTarget(probe.duration), idx).then(r => {
          if (!r) return;
          if (probe.audioSupported) toast(`已按上次的音轨选择播放：${trackLabel(audioTracks[idx] || {}, idx)}`, 5000);
          else toast(`音轨为 ${codecLabel(probe.audioCodecs)}，内置播放器不支持，已自动转码播放`, 5000);
        });
        return;
      }
      audioIdx = idx;
    }
    videoEl.removeAttribute('crossorigin');
    videoEl.src = res.url;
    videoEl.play().catch(() => {});
    videoEl.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
  });
}

function onLoadedMetadata() {
  updateResBadge();
  if (stream) return; // 转码流从会话起点播，无需再定位
  const target = current.position;
  if (target > 5 && target < videoEl.duration - 10) {
    // 实测：大 mkv 缺索引时"未播放就深定位"会永久卡死（readyState 停在 1），
    // 先播起来再定位则秒级完成 —— 因此等播放流动后再跳到上次位置
    let sought = false;
    const onTimeupdate = () => {
      if (sought || stream) { videoEl.removeEventListener('timeupdate', onTimeupdate); return; }
      if (videoEl.currentTime <= 0.5) return;
      sought = true;
      videoEl.removeEventListener('timeupdate', onTimeupdate);
      seekTo(target);
      videoEl.addEventListener('seeked', () => {
        toast(`已从上次位置 ${fmt(target)} 继续播放`);
      }, { once: true });
      // 看门狗：播放中定位 15 秒仍未完成 → 回到开头继续播
      setTimeout(() => {
        if (videoEl.seeking) {
          seekTo(0);
          videoEl.play().catch(() => {});
          toast('该视频缺少索引、定位较慢，已从头播放');
        }
      }, 15000);
    };
    videoEl.addEventListener('timeupdate', onTimeupdate);
  }
}

function resumeTarget(duration) {
  const pos = current?.position || 0;
  return pos > 5 && (!duration || pos < duration - 10) ? pos : 0;
}

/** 启动实时转码会话并把播放源切到转码流（idx 缺省时用记住的/默认音轨） */
async function startStream(info, startAt, idx) {
  if (!current) return null;
  const myVideo = current; // 等待 avStart 期间用户可能已切到其他视频
  const chosen = (typeof idx === 'number' && idx >= 0) ? idx : prefTrackIdx(info);
  const r = await window.api.avStart(current.path, startAt || 0, chosen).catch(() => null);
  if (!r || !r.ok) {
    toast(info.audioSupported ? '转码流启动失败，可用系统播放器打开'
      : `音轨 ${codecLabel(info.audioCodecs)} 内置不支持，且转码启动失败，可用系统播放器打开`, 6000);
    return null;
  }
  if (current !== myVideo) { window.api.avStop(r.id).catch(() => {}); return null; } // 已切片：丢弃旧会话
  if (info.audioTracks && info.audioTracks.length) audioTracks = info.audioTracks;
  audioIdx = (typeof r.audioIndex === 'number' && r.audioIndex >= 0) ? r.audioIndex : chosen;
  localStorage.setItem(prefKey(), String(audioIdx));
  stream = { id: r.id, dur: info.duration || null, offset: (typeof r.offset === 'number' && isFinite(r.offset)) ? r.offset : (startAt || 0) };
  restarting = false;
  // 转码流带 CORS 头，crossOrigin 保证截图/画中画的 canvas 不被污染
  videoEl.setAttribute('crossorigin', 'anonymous');
  videoEl.src = r.url;
  videoEl.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
  videoEl.load();
  videoEl.play().catch(() => {});
  return r;
}

function stopStream() {
  if (stream) {
    window.api.avStop(stream.id).catch(() => {});
    stream = null;
  }
  restarting = false;
  videoEl.removeAttribute('crossorigin');
}

/** 统一定位：转码流在已缓冲范围内直接定位，范围外重启 ffmpeg 从目标时间转 */
function seekTo(t) {
  if (!current || !isFinite(t) || t < 0) return;
  if (!stream) { videoEl.currentTime = t; return; }
  const local = t - stream.offset; // seekable/buffered 都是转码流自己的时间轴
  const sk = videoEl.seekable;
  for (let i = 0; i < sk.length; i++) {
    if (local >= sk.start(i) - 0.25 && local <= sk.end(i) + 0.25) { videoEl.currentTime = Math.max(0, local); return; }
  }
  queueStreamRestart(t);
}

let restartTimer = null;
let pendingSeek = 0;
let pendingAudio = -1; // ≥0 表示重启时同时切到这条音轨
function queueStreamRestart(t, newAudio) {
  pendingSeek = t;
  if (typeof newAudio === 'number' && newAudio >= 0) pendingAudio = newAudio;
  if (restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (!stream || !current) return;
    const sid = stream.id;
    const wantAudio = pendingAudio;
    pendingAudio = -1;
    restarting = true;
    // 看门狗：重启迟迟没进入播放态就解除抑制，让真正的错误能浮出来
    setTimeout(() => { restarting = false; }, 15000);
    try {
      // 服务端探测关键帧并对齐起点（拷贝视频必须从关键帧起切，否则音画错位），
      // 返回实际起点作为新的显示偏移；带音轨下标时同时换轨
      const k = await window.api.avSeek(sid, pendingSeek, wantAudio >= 0 ? wantAudio : undefined);
      if (!stream || stream.id !== sid) return; // 等待期间已切到其他视频
      stream.offset = (typeof k === 'number' && isFinite(k)) ? k : pendingSeek;
      if (wantAudio >= 0) audioIdx = wantAudio;
    } catch {
      if (!stream || stream.id !== sid) return;
      stream.offset = pendingSeek;
      if (wantAudio >= 0) audioIdx = wantAudio;
    }
    videoEl.load(); // 重新请求同一 URL，服务端按新起点/新音轨重启 ffmpeg
    videoEl.play().catch(() => {});
  }, 250);
}

// ---- 进度条预览：隐藏 <video> 定位到悬停时间点，画到 canvas ----
// 预览始终用原始文件（file:// 可定位），转码流播放时也能出预览帧
let previewVideo = null;
let previewSrc = null;       // 预览 video 当前加载的文件
let previewReady = false;    // 当前源已就绪（loadeddata），可以定位抽帧
let previewBroken = false;   // 当前源解码失败（Chromium 解不了的编码），画不出帧
let previewSeeking = false;
let previewPending = null;   // 抽帧期间更新的最新目标
let previewWatchdog = null;

function showSeekPreview(e, frac, scrubUI) {
  if (!current || !isFinite(knownDur()) || knownDur() <= 0) { hideSeekPreview(); return; }
  const t = frac * knownDur();
  seekPreview.classList.remove('hidden');
  const barRect = progressBar.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const w = seekPreview.offsetWidth, h = seekPreview.offsetHeight;
  let left = e.clientX - wrapRect.left - w / 2;
  left = Math.max(8, Math.min(left, wrapRect.width - w - 8));
  seekPreview.style.left = left + 'px';
  seekPreview.style.top = 'auto';
  seekPreview.style.bottom = (wrapRect.bottom - barRect.top + 10) + 'px';
  previewTime.textContent = fmt(t);
  if (scrubUI) {
    // 拖动中先让进度条/时间跟随手指，真正定位在松手时执行
    progressPlayed.style.width = frac * 100 + '%';
    progressDot.style.left = frac * 100 + '%';
    timeLabel.textContent = `${fmt(t)} / ${fmt(knownDur())}`;
  }
  requestPreviewFrame(t);
}

function hideSeekPreview() {
  seekPreview.classList.add('hidden');
  if (!previewVideo) return;
  previewVideo.pause();
  // 收起时废弃进行中的抽帧记账：残留的 pending 会在 seeked 里把隐藏的
  // video 重新唤醒播放（后台全分辨率解码白耗 CPU，还可能拖慢主画面）
  previewSeeking = false;
  previewPending = null;
  clearTimeout(previewWatchdog);
}

/** 换片后让预览源重新加载 */
function resetPreviewSource() {
  if (previewVideo) {
    try { previewVideo.pause(); previewVideo.removeAttribute('src'); previewVideo.load(); } catch { /* 忽略 */ }
  }
  previewSrc = null;
  previewReady = false;
  previewBroken = false;
  previewSeeking = false;
  previewPending = null;
  clearTimeout(previewWatchdog);
  hideSeekPreview();
}

/** 抽帧请求收敛：只保留最新目标；预览已收起就丢弃，避免唤醒隐藏的 video */
function flushPendingPreview() {
  const next = previewPending;
  previewPending = null;
  if (next == null || seekPreview.classList.contains('hidden')) return;
  requestPreviewFrame(next);
}

function ensurePreviewSource() {
  if (!fileUrl) return false;
  if (previewSrc === fileUrl && previewVideo) return true;
  if (!previewVideo) {
    previewVideo = document.createElement('video');
    previewVideo.muted = true;
    previewVideo.preload = 'auto';
    previewVideo.style.position = 'fixed';
    previewVideo.style.left = '-9999px';
    previewVideo.style.width = '320px';
    previewVideo.addEventListener('loadeddata', () => {
      previewReady = true;
      flushPendingPreview();
    });
    previewVideo.addEventListener('seeked', () => {
      previewSeeking = false;
      drawPreviewFrame();
      flushPendingPreview();
    });
    previewVideo.addEventListener('error', () => {
      if (!previewSrc) return; // 换源/收起导致的空加载中断不算失败
      // 预览直解原始文件，内置解不了的编码（HEVC/10-bit 等）永远画不出帧；
      // 给出提示并停止无谓的定位重试（主画面走转码流，不受影响）
      previewBroken = true;
      previewReady = false;
      previewSeeking = false;
      previewPending = null;
      clearTimeout(previewWatchdog);
      drawPreviewUnavailable();
    });
    document.body.appendChild(previewVideo);
  }
  previewSrc = fileUrl;
  previewReady = false;
  previewBroken = false;
  previewSeeking = false;
  previewPending = null;
  clearTimeout(previewWatchdog);
  previewVideo.src = fileUrl;
  // 实测：大 mkv 缺索引时"未播放就深定位"会永久卡死，先播起来再定位则秒级完成
  previewVideo.play().catch(() => {});
  return true;
}

function requestPreviewFrame(t) {
  if (previewBroken || !ensurePreviewSource()) return;
  // 元数据/首帧未就绪时设置 currentTime 不会发起定位（也不触发 seeked），
  // 先记为 pending，等 loadeddata 再抽
  if (!previewReady) { previewPending = t; return; }
  // 保持"播放中定位"的热状态（预览收起时会暂停）
  if (previewVideo.paused) previewVideo.play().catch(() => {});
  if (previewSeeking) { previewPending = t; return; }
  previewSeeking = true;
  clearTimeout(previewWatchdog);
  // 网络文件偶尔定位很慢：3 秒没结果就放弃本次，避免预览卡死
  previewWatchdog = setTimeout(() => {
    previewSeeking = false;
    flushPendingPreview();
  }, 3000);
  try { previewVideo.currentTime = Math.max(0, t); } catch { previewSeeking = false; }
}

function drawPreviewFrame() {
  const v = previewVideo;
  if (!v || !v.videoWidth) return;
  const ctx = previewCanvas.getContext('2d');
  const W = previewCanvas.width, H = previewCanvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(W / v.videoWidth, H / v.videoHeight);
  const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawPreviewUnavailable() {
  const ctx = previewCanvas.getContext('2d');
  const W = previewCanvas.width, H = previewCanvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#8a93a3';
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('该编码不支持画面预览', W / 2, H / 2);
}

/** 解码/加载失败浮层：重试 或 交给系统播放器 */
function showPlayError(err) {
  hidePlayError();
  const ov = document.createElement('div');
  ov.id = 'playErrorOverlay';
  ov.innerHTML = `
    <div class="pe-card">
      <div class="pe-title">⚠ 视频无法播放</div>
      <div class="pe-msg">解码失败（错误码 ${err?.code ?? '?'}）。常见原因：编码不被内置播放器支持
        （如 10-bit H.264 / HEVC），或网络文件读取超时。可尝试用系统播放器打开。</div>
      <div class="pe-btns">
        <button id="peRetry">重试</button>
        <button id="peExternal" class="primary">用系统播放器打开</button>
      </div>
    </div>`;
  wrap.appendChild(ov);
  ov.querySelector('#peRetry').addEventListener('click', () => { if (current) playVideo(current); });
  ov.querySelector('#peExternal').addEventListener('click', async () => {
    if (!current) return;
    const r = await window.api.openExternal(current.path);
    if (r) toast(r);
    hidePlayError();
  });
}
function hidePlayError() {
  document.getElementById('playErrorOverlay')?.remove();
}

function updateResBadge() {
  const h = videoEl.videoHeight;
  if (!h) return;
  const label = h >= 2000 ? '4K' : h >= 1000 ? '1080P' : h >= 700 ? '720P' : `${h}P`;
  resBadge.textContent = label;
  resBadge.classList.remove('hidden');
}

async function loadPlaylist() {
  const all = await window.api.listVideos();
  playlist = [...all].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

function neighbor(dir) {
  if (!current || playlist.length === 0) return null;
  const i = playlist.findIndex(v => v.id === current.id);
  return playlist[(i + dir + playlist.length) % playlist.length];
}
async function playNeighbor(dir) {
  const n = neighbor(dir);
  if (n) { await playVideo(n); await loadPlaylist(); }
}

function togglePlay() {
  if (videoEl.paused) videoEl.play(); else videoEl.pause();
}

function setMuteIcon() {
  const name = videoEl.muted || videoEl.volume === 0 ? 'muted' : 'volume';
  muteBtn.innerHTML = icon(name, 22);
  topMuteBtn.innerHTML = icon(name, 20);
}

function toggleMute() {
  videoEl.muted = !videoEl.muted;
  setMuteIcon();
}

function removeSubtitle() {
  if (trackEl) { trackEl.remove(); trackEl = null; }
}

async function showSubtitleMenu() {
  if (!current) return;
  const subs = await window.api.findSubtitles(current.path);
  openPopup(subBtn, (pop) => {
    const h = document.createElement('h4');
    h.textContent = subs.length ? '选择字幕（同目录 .srt）' : '视频同目录未找到 .srt 字幕';
    pop.appendChild(h);
    menuItem(pop, '关闭字幕', !trackEl, removeSubtitle);
    for (const s of subs) {
      menuItem(pop, s.name, trackEl && trackEl.dataset.file === s.file, async () => {
        removeSubtitle();
        const vtt = await window.api.readSubtitle(s.file);
        const blob = new Blob([vtt], { type: 'text/vtt' });
        trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = s.name;
        trackEl.src = URL.createObjectURL(blob);
        trackEl.dataset.file = s.file;
        trackEl.default = true;
        videoEl.appendChild(trackEl);
        trackEl.addEventListener('load', () => { videoEl.textTracks[0].mode = 'showing'; }, { once: true });
        setTimeout(() => { if (videoEl.textTracks[0]) videoEl.textTracks[0].mode = 'showing'; }, 500);
        toast('已加载字幕: ' + s.name);
      });
    }
  });
}

// ---- 音轨菜单 ----
/** 当前正在响的音轨下标：转码流用 audioIdx；直接播放时 Chromium 播的是默认轨 */
function activeAudioIdx() {
  if (stream) return audioIdx >= 0 ? audioIdx : 0;
  return audioTracks.length ? defaultTrackIdx(audioTracks) : -1;
}

/** 切回默认支持轨时退出转码流，恢复直接播放原始文件 */
function playDirect(at) {
  const pos = at || 0;
  stopStream();
  videoEl.src = fileUrl;
  videoEl.addEventListener('loadedmetadata', () => {
    try { videoEl.currentTime = pos; } catch { /* 元数据未就绪时忽略 */ }
  }, { once: true });
  videoEl.load();
  videoEl.play().catch(() => {});
}

function selectAudioTrack(i) {
  if (!current || !audioTracks.length) return;
  i = Math.max(0, Math.min(i, audioTracks.length - 1));
  const t = audioTracks[i];
  localStorage.setItem(prefKey(), String(i));
  const pos = dispTime();
  if (!stream) {
    if (t.supported && i === defaultTrackIdx(audioTracks)) {
      toast('正在播放 ' + trackLabel(t, i)); // 直接播放本来就是这条默认轨
      return;
    }
    // 非默认轨或不支持的轨：从当前位置起转码/重混流
    const info = { audioTracks, audioCodecs: [t.codec], duration: current.duration || null };
    startStream(info, pos, i).then(r => { if (r) toast('已切换到 ' + trackLabel(t, i)); });
    return;
  }
  if (i === activeAudioIdx()) return;
  if (t.supported && i === defaultTrackIdx(audioTracks)) playDirect(pos); // 切回默认轨退出转码流
  else queueStreamRestart(pos, i); // 同一会话换轨重启，播放位置连续
  toast('已切换到 ' + trackLabel(t, i));
}

function showAudioMenu() {
  if (!current) return;
  openPopup(audioBtn, (pop) => {
    const h = document.createElement('h4');
    pop.appendChild(h);
    if (!audioTracks.length) {
      // 还没探测到音轨明细（首次播放探测未完成）：探完自动刷新菜单
      h.textContent = '正在读取音轨信息…';
      const p = current.path;
      window.api.probeAudio(p).then(info => {
        if (!current || current.path !== p) return;
        if (info && info.ok && info.hasAudio) {
          audioTracks = info.audioTracks || [];
          if (audioTracks.length) { closePopup(); showAudioMenu(); return; }
        }
        h.textContent = '未检测到音轨';
      });
      return;
    }
    h.textContent = stream ? '选择音轨（转码流）' : '选择音轨';
    const act = activeAudioIdx();
    audioTracks.forEach((t, i) => menuItem(pop, trackLabel(t, i), i === act, () => selectAudioTrack(i)));
    if (!audioTracks.some(t => t.supported)) {
      const tip = document.createElement('h4');
      tip.textContent = '音轨编码内置不支持，播放时实时转码';
      pop.appendChild(tip);
    }
  });
}

function showSpeedMenu() {
  openPopup(speedBtn, (pop) => {
    const h = document.createElement('h4'); h.textContent = '倍速'; pop.appendChild(h);
    for (const s of [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]) {
      menuItem(pop, s.toFixed(1) + 'x', videoEl.playbackRate === s, () => {
        videoEl.playbackRate = s;
        speedBtn.textContent = s.toFixed(1);
      });
    }
  });
}

function showPlaylistMenu() {
  openPopup(listBtn, (pop) => {
    const h = document.createElement('h4'); h.textContent = `播放列表（${playlist.length}）`; pop.appendChild(h);
    for (const v of playlist.slice(0, 100)) {
      menuItem(pop, (v.id === current?.id ? '▶ ' : '') + (v.virtualName || v.title || v.name), v.id === current?.id, () => {
        playVideo(v);
      });
    }
  });
}

function showSettingsMenu() {
  openPopup(setBtn, (pop) => {
    const h = document.createElement('h4'); h.textContent = '播放设置'; pop.appendChild(h);
    const loop = document.createElement('label');
    loop.className = 'setrow';
    loop.innerHTML = `<input type="checkbox" ${videoEl.loop ? 'checked' : ''}/> 单视频循环`;
    loop.querySelector('input').addEventListener('change', (e) => videoEl.loop = e.target.checked);
    pop.appendChild(loop);
    const fill = document.createElement('label');
    fill.className = 'setrow';
    fill.innerHTML = `<input type="checkbox" ${picSettings.fill ? 'checked' : ''}/> 拉伸铺满画面`;
    fill.querySelector('input').addEventListener('change', (e) => {
      picSettings.fill = e.target.checked;
      wrap.classList.toggle('force-fill', picSettings.fill);
    });
    pop.appendChild(fill);
  });
}

function showPicMenu() {
  openPopup(picBtn, (pop) => {
    const h = document.createElement('h4'); h.textContent = '画面设置'; pop.appendChild(h);
    const rows = [
      ['brightness', '亮度', 50, 150], ['contrast', '对比度', 50, 150],
      ['saturate', '饱和度', 0, 200], ['hue', '色调', 0, 180],
    ];
    for (const [key, label, min, max] of rows) {
      const row = document.createElement('label');
      row.className = 'setrow';
      row.innerHTML = `<span style="width:44px">${label}</span><input type="range" min="${min}" max="${max}" value="${picSettings[key]}" />`;
      row.querySelector('input').addEventListener('input', (e) => {
        picSettings[key] = +e.target.value;
        applyPicFilter();
      });
      pop.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.className = 'pbtn'; reset.textContent = '↺ 恢复默认';
    reset.addEventListener('click', () => {
      picSettings = { brightness: 100, contrast: 100, saturate: 100, hue: 0, fill: picSettings.fill };
      applyPicFilter(); closePopup();
    });
    pop.appendChild(reset);
  });
}

function applyPicFilter() {
  videoEl.style.filter = `brightness(${picSettings.brightness}%) contrast(${picSettings.contrast}%) saturate(${picSettings.saturate}%) hue-rotate(${picSettings.hue}deg)`;
}

async function doScreenshot() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvas.getContext('2d').drawImage(videoEl, 0, 0);
    const base64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    const file = await window.api.saveScreenshot(current.name, base64);
    toast('📷 已保存截图: ' + file);
  } catch (e) {
    toast('截图失败: ' + e.message);
  }
}

async function showCastMenu() {
  openPopup(castBtn, (pop) => {
    const h = document.createElement('h4'); h.textContent = '搜索局域网设备中…'; pop.appendChild(h);
    window.api.castSearch().then(devices => {
      h.textContent = devices.length ? '选择要投屏的设备' : '未发现 DLNA 设备（电视需在同一局域网并开启投屏/DLNA）';
      for (const d of devices) {
        menuItem(pop, '📺 ' + d.name, false, async () => {
          toast(`正在投屏到 ${d.name}…`);
          try {
            await window.api.castPlay(d.location, current.id, current.virtualName || current.name);
            toast(`✅ 已投屏到 ${d.name}`);
          } catch (e) { toast('投屏失败: ' + e.message); }
        });
      }
    });
  });
}

// ---- 事件绑定 ----
export function initPlayer({ refreshLibrary: rl }) {
  refreshLibrary = rl;
  playBtn.innerHTML = icon('play', 24);
  setMuteIcon();
  // 自动化测试钩子：当前播放位置/时长/是否转码流/音轨
  window.__playerDebug = () => ({
    t: dispTime(), dur: knownDur(), transcoded: !!stream,
    audio: { count: audioTracks.length, idx: activeAudioIdx() },
  });

  // ---- 音量：滑条 / 滚轮 / 上下键，带记忆 ----
  const savedVol = parseFloat(localStorage.getItem('avp_volume'));
  if (!isNaN(savedVol)) videoEl.volume = Math.min(1, Math.max(0, savedVol));
  volumeSlider.value = videoEl.volume;

  let osdTimer = null;
  function showVolumeOsd() {
    const pct = videoEl.muted ? 0 : videoEl.volume;
    osdFill.style.width = pct * 100 + '%';
    osdPct.textContent = Math.round(pct * 100) + '%';
    osdIcon.textContent = (videoEl.muted || videoEl.volume === 0) ? '🔇' : '🔊';
    volumeOsd.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => volumeOsd.classList.remove('show'), 900);
  }
  function setVolume(v) {
    videoEl.volume = Math.min(1, Math.max(0, v));
    if (videoEl.volume > 0 && videoEl.muted) videoEl.muted = false;
    showVolumeOsd();
  }

  volumeSlider.addEventListener('input', () => setVolume(+volumeSlider.value));
  // 鼠标滚轮在播放器画面上滚动 = 调音量
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    setVolume(videoEl.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    showControls();
  }, { passive: false });
  // 音量变化时同步滑条（值 + 已填充轨道）+ 记忆
  function syncVolumeSlider() {
    const vol = videoEl.muted ? 0 : videoEl.volume;
    volumeSlider.value = vol;
    const pct = vol * 100;
    volumeSlider.style.background = `linear-gradient(to right, #2196f3 ${pct}%, #4a505e ${pct}%)`;
    localStorage.setItem('avp_volume', String(videoEl.volume));
  }
  videoEl.addEventListener('volumechange', syncVolumeSlider);
  syncVolumeSlider();

  window.__openVideo = async (video) => {
    document.body.classList.add('player-view');
    await loadPlaylist();
    // 保证片库列表顺序里包含当前视频
    await playVideo(video);
    await loadPlaylist();
    showControls();
  };

  // 两个后退按钮都走导航历史：回到打开播放器之前的页面与层级
  const leavePlayer = () => {
    videoEl.pause();
    stopStream();
    resetPreviewSource();
    document.body.classList.remove('player-view');
    refreshLibrary();
  };
  document.getElementById('backBtn').addEventListener('click', () => {
    leavePlayer();
    goBack();
  });

  playBtn.addEventListener('click', togglePlay);
  videoEl.addEventListener('click', togglePlay);
  videoEl.addEventListener('dblclick', () => fullscreenBtn.click());
  videoEl.addEventListener('play', () => { playBtn.innerHTML = icon('pause', 24); showControls(); });
  videoEl.addEventListener('pause', () => { playBtn.innerHTML = icon('play', 24); showControls(); });
  videoEl.addEventListener('playing', () => { restarting = false; });
  videoEl.addEventListener('volumechange', setMuteIcon);
  videoEl.addEventListener('error', () => {
    const e = videoEl.error;
    // code 1 = 切换片源时的中止，不算播放失败；restarting = 拖动重启时旧连接正常断开
    if (!e || e.code === 1 || !current || restarting) return;
    showPlayError(e);
  });

  stopBtn.addEventListener('click', () => {
    videoEl.pause();
    seekTo(0);
    if (current) window.api.updateVideo({ id: current.id, position: 0 });
  });
  prevBtn.addEventListener('click', () => playNeighbor(-1));
  nextBtn.addEventListener('click', () => playNeighbor(1));
  muteBtn.addEventListener('click', toggleMute);
  topMuteBtn.addEventListener('click', toggleMute);

  speedBtn.addEventListener('click', showSpeedMenu);
  subBtn.addEventListener('click', showSubtitleMenu);
  audioBtn.addEventListener('click', showAudioMenu);
  listBtn.addEventListener('click', showPlaylistMenu);
  setBtn.addEventListener('click', showSettingsMenu);
  picBtn.addEventListener('click', showPicMenu);
  snapBtn.addEventListener('click', doScreenshot);
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoEl.requestPictureInPicture();
    } catch (e) { toast('画中画不可用: ' + e.message); }
  });
  castBtn.addEventListener('click', showCastMenu);

  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen().catch(() => {});
  });

  videoEl.addEventListener('timeupdate', () => {
    if (scrubbing) return; // 拖动中 UI 由预览逻辑接管，避免被实际播放位置覆盖
    const d = knownDur() || 1;
    const t = dispTime();
    const pct = t / d * 100;
    progressPlayed.style.width = pct + '%';
    progressDot.style.left = pct + '%';
    if (videoEl.buffered.length) {
      const bufEnd = videoEl.buffered.end(videoEl.buffered.length - 1) + (stream ? stream.offset : 0);
      progressBuffered.style.width = (bufEnd / d * 100) + '%';
    }
    timeLabel.textContent = `${fmt(t)} / ${fmt(knownDur())}`;
    if (current && !saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        window.api.updateVideo({ id: current.id, position: dispTime(), lastPlayed: Date.now() });
      }, 3000);
    }
  });

  videoEl.addEventListener('ended', () => {
    if (restarting) return; // 拖动重启断流不算播完
    // 直播式转码流的"假结束"：Chromium 认为的时长是已解析分片的末端（比实际进度只多几秒），
    // 播放追上时会误报 ended。离探测到的真实时长还远就续播当前进度；同一位置反复出现则视为真播完。
    if (stream && (!stream.dur || dispTime() < stream.dur - 2)) {
      const now = Date.now();
      const here = dispTime();
      const sameSpot = now - lastFalseEnd.at < 20000 && Math.abs(here - lastFalseEnd.t) < 5;
      if (!sameSpot) {
        lastFalseEnd = { t: here, at: now };
        queueStreamRestart(here); // 必须用影片位置：videoEl.currentTime 是转码流本地时间
        return;
      }
    }
    if (current && !videoEl.loop) window.api.updateVideo({ id: current.id, position: 0, lastPlayed: Date.now() });
    playNeighbor(1); // 自动连播
  });

  // ---- 进度条：悬停/拖动预览 + 拖动定位 ----
  const progressFrac = (e) => {
    const rect = progressBar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  let scrubbing = false;
  progressBar.addEventListener('mousemove', (e) => showSeekPreview(e, progressFrac(e), false));
  progressBar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    scrubbing = true;
    showSeekPreview(e, progressFrac(e), true);
  });
  window.addEventListener('mousemove', (e) => {
    if (scrubbing) showSeekPreview(e, progressFrac(e), true);
  });
  window.addEventListener('mouseup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    seekTo(progressFrac(e) * (knownDur() || 0));
    // 松手时鼠标已不在进度条上就收起预览
    const rect = progressBar.getBoundingClientRect();
    if (e.clientY < rect.top - 12 || e.clientY > rect.bottom + 12) hideSeekPreview();
  });
  progressBar.addEventListener('mouseenter', () => { barHover = true; });
  progressBar.addEventListener('mouseleave', () => {
    barHover = false;
    if (!scrubbing) hideSeekPreview();
    showControls(); // 离开进度条后恢复自动隐藏倒计时
  });

  // 窗口控制
  document.getElementById('winMinBtn').addEventListener('click', () => window.api.winMinimize());
  document.getElementById('winMaxBtn').addEventListener('click', () => window.api.winMaximize());
  document.getElementById('winCloseBtn').addEventListener('click', () => window.api.winClose());
  document.getElementById('fwMin').addEventListener('click', () => window.api.winMinimize());
  document.getElementById('fwMax').addEventListener('click', () => window.api.winMaximize());
  document.getElementById('fwClose').addEventListener('click', () => window.api.winClose());

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    showControls();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') seekTo(dispTime() + 5);
    else if (e.code === 'ArrowLeft') seekTo(dispTime() - 5);
    else if (e.code === 'ArrowUp') { setVolume(videoEl.volume + 0.1); }
    else if (e.code === 'ArrowDown') { setVolume(videoEl.volume - 0.1); }
    else if (e.key === 'f' || e.key === 'F') fullscreenBtn.click();
    else if (e.key === 'm' || e.key === 'M') toggleMute();
    else if (e.code === 'PageUp') playNeighbor(-1);
    else if (e.code === 'PageDown') playNeighbor(1);
  });
}
