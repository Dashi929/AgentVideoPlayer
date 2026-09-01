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
const playerTags = document.getElementById('playerTags');
const analyzeBtn = document.getElementById('analyzeBtn');
const resBadge = document.getElementById('resBadge');
const speedBtn = document.getElementById('speedBtn');
const subBtn = document.getElementById('subBtn');
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

let current = null;      // 当前视频
let playlist = [];       // 播放列表（片库当前排序）
let saveTimer = null;
let hideTimer = null;
let refreshLibrary = () => {};
let trackEl = null;      // 当前字幕 track
let picSettings = { brightness: 100, contrast: 100, saturate: 100, hue: 0, fill: false };

function fmt(s) {
  if (!isFinite(s)) return '00:00';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---- 控制条自动隐藏 ----
function showControls() {
  wrap.classList.remove('controls-hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!videoEl.paused && !menuLayerVisible()) wrap.classList.add('controls-hidden');
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
  return window.api.readVideo(video.path).then(res => {
    current = res.video;
    videoEl.src = res.url;
    playerTitle.textContent = current.virtualName || current.title || current.name;
    playerTags.innerHTML = (current.tags || []).map(t => `<span class="tag-chip">${t}</span>`).join('');
    removeSubtitle();
    videoEl.play().catch(() => {});
    videoEl.addEventListener('loadedmetadata', () => {
      updateResBadge();
      const target = current.position;
      if (target > 5 && target < videoEl.duration - 10) {
        // 实测：大 mkv 缺索引时"未播放就深定位"会永久卡死（readyState 停在 1），
        // 先播起来再定位则秒级完成 —— 因此等播放流动后再跳到上次位置
        let sought = false;
        const onTimeupdate = () => {
          if (sought || videoEl.currentTime <= 0.5) return;
          sought = true;
          videoEl.removeEventListener('timeupdate', onTimeupdate);
          videoEl.currentTime = target;
          videoEl.addEventListener('seeked', () => {
            toast(`已从上次位置 ${fmt(target)} 继续播放`);
          }, { once: true });
          // 看门狗：播放中定位 15 秒仍未完成 → 回到开头继续播
          setTimeout(() => {
            if (videoEl.seeking) {
              videoEl.currentTime = 0;
              videoEl.play().catch(() => {});
              toast('该视频缺少索引、定位较慢，已从头播放');
            }
          }, 15000);
        };
        videoEl.addEventListener('timeupdate', onTimeupdate);
      }
    }, { once: true });
  });
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
  videoEl.addEventListener('volumechange', setMuteIcon);
  videoEl.addEventListener('error', () => {
    const e = videoEl.error;
    // code 1 = 切换片源时的中止，不算播放失败
    if (!e || e.code === 1 || !current) return;
    showPlayError(e);
  });

  stopBtn.addEventListener('click', () => {
    videoEl.pause();
    videoEl.currentTime = 0;
    if (current) window.api.updateVideo({ id: current.id, position: 0 });
  });
  prevBtn.addEventListener('click', () => playNeighbor(-1));
  nextBtn.addEventListener('click', () => playNeighbor(1));
  muteBtn.addEventListener('click', toggleMute);
  topMuteBtn.addEventListener('click', toggleMute);

  speedBtn.addEventListener('click', showSpeedMenu);
  subBtn.addEventListener('click', showSubtitleMenu);
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
    const d = videoEl.duration || 1;
    const pct = videoEl.currentTime / d * 100;
    progressPlayed.style.width = pct + '%';
    progressDot.style.left = pct + '%';
    if (videoEl.buffered.length) {
      progressBuffered.style.width = (videoEl.buffered.end(videoEl.buffered.length - 1) / d * 100) + '%';
    }
    timeLabel.textContent = `${fmt(videoEl.currentTime)} / ${fmt(videoEl.duration)}`;
    if (current && !saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        window.api.updateVideo({ id: current.id, position: videoEl.currentTime, lastPlayed: Date.now() });
      }, 3000);
    }
  });

  videoEl.addEventListener('ended', () => {
    if (current && !videoEl.loop) window.api.updateVideo({ id: current.id, position: 0, lastPlayed: Date.now() });
    playNeighbor(1); // 自动连播
  });

  progressBar.addEventListener('click', (e) => {
    const rect = progressBar.getBoundingClientRect();
    videoEl.currentTime = (e.clientX - rect.left) / rect.width * (videoEl.duration || 0);
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
    else if (e.code === 'ArrowRight') videoEl.currentTime += 5;
    else if (e.code === 'ArrowLeft') videoEl.currentTime -= 5;
    else if (e.code === 'ArrowUp') { setVolume(videoEl.volume + 0.1); }
    else if (e.code === 'ArrowDown') { setVolume(videoEl.volume - 0.1); }
    else if (e.key === 'f' || e.key === 'F') fullscreenBtn.click();
    else if (e.key === 'm' || e.key === 'M') toggleMute();
    else if (e.code === 'PageUp') playNeighbor(-1);
    else if (e.code === 'PageDown') playNeighbor(1);
  });

  // AI 分析当前视频
  analyzeBtn.addEventListener('click', async () => {
    if (!current) return;
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '🤖 分析中…';
    try {
      const res = await window.api.runAgent(
        `请分析这个视频并打标签、设置封面：${current.name}（id: ${current.id}）`, []);
      toast(res.finalText || '完成');
      const fresh = (await window.api.listVideos()).find(v => v.id === current.id);
      if (fresh) {
        current = fresh;
        playerTags.innerHTML = (fresh.tags || []).map(t => `<span class="tag-chip">${t}</span>`).join('');
      }
      refreshLibrary();
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '🤖 AI 分析此视频';
    }
  });
}
