const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  checkFfmpeg: () => ipcRenderer.invoke('media:check-ffmpeg'),

  scanFolder: () => ipcRenderer.invoke('library:scan'),
  getRoots: () => ipcRenderer.invoke('library:roots'),
  listVideos: () => ipcRenderer.invoke('library:list'),
  listFolders: () => ipcRenderer.invoke('library:folders'),
  updateVideo: (patch) => ipcRenderer.invoke('library:update', patch),
  readVideo: (p) => ipcRenderer.invoke('video:read', p),
  openExternal: (p) => ipcRenderer.invoke('video:open-external', p),

  // 音轨探测 + 实时转码流（不支持的音轨转 AAC；audioIndex 选择多音轨中的一条）
  probeAudio: (p) => ipcRenderer.invoke('media:probe', p),
  avStart: (file, startAt, audioIndex) => ipcRenderer.invoke('av:start', { file, startAt, audioIndex }),
  avSeek: (id, t, audioIndex) => ipcRenderer.invoke('av:seek', { id, t, audioIndex }),
  avStop: (id) => ipcRenderer.invoke('av:stop', id),

  runAgent: (message, history) => ipcRenderer.invoke('agent:run', { message, history }),
  testAi: () => ipcRenderer.invoke('ai:test'),

  // 收藏分类
  getCollections: () => ipcRenderer.invoke('collections:get'),
  createCollection: (name, ids, dirs) => ipcRenderer.invoke('collections:create', { name, ids, dirs }),
  renameCollection: (id, name) => ipcRenderer.invoke('collections:rename', { id, name }),
  copyCollection: (id) => ipcRenderer.invoke('collections:copy', { id }),
  deleteCollection: (id) => ipcRenderer.invoke('collections:delete', { id }),

  // 批量操作（多选 + 右键菜单）
  removeVideos: (paths) => ipcRenderer.invoke('library:remove', paths),
  deleteFiles: (ids) => ipcRenderer.invoke('library:deleteFiles', ids),
  setFav: (ids, fav) => ipcRenderer.invoke('library:setFav', { ids, fav }),
  setFavFolder: (dirs, fav) => ipcRenderer.invoke('library:setFavFolder', { dirs, fav }),
  queueAdd: (op, ids, dirs) => ipcRenderer.invoke('queue:add', { op, ids, dirs }),
  queueRemove: (id) => ipcRenderer.invoke('queue:remove', id),
  onQueueUpdate: (handler) => ipcRenderer.on('queue-update', (_e, jobs) => handler(jobs)),

  // 沉浸式播放器
  winMinimize: () => ipcRenderer.send('window:minimize'),
  winMaximize: () => ipcRenderer.send('window:maximize'),
  winClose: () => ipcRenderer.send('window:close'),
  findSubtitles: (videoPath) => ipcRenderer.invoke('subtitle:find', videoPath),
  readSubtitle: (srtPath) => ipcRenderer.invoke('subtitle:read', srtPath),
  saveScreenshot: (videoName, base64) => ipcRenderer.invoke('screenshot:save', { videoName, base64 }),
  castSearch: () => ipcRenderer.invoke('cast:search'),
  castPlay: (location, videoId, title) => ipcRenderer.invoke('cast:play', { location, videoId, title }),

  // 外部打开（文件关联/命令行）：渲染层就绪后主进程推送视频记录
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  onOpenVideoFile: (handler) => ipcRenderer.on('open-video-file', (_e, videos) => handler(videos)),

  // 文件关联注册（Windows）
  assocStatus: () => ipcRenderer.invoke('assoc:status'),
  assocRegister: () => ipcRenderer.invoke('assoc:register'),
  assocUnregister: () => ipcRenderer.invoke('assoc:unregister'),

  // 接收主进程的截帧请求，渲染层用 video+canvas 完成
  onCaptureFrames: (handler) => {
    ipcRenderer.on('capture-frames', (_e, { videoPath, times }) => {
      captureFramesFor(videoPath, times).then((frames) => {
        ipcRenderer.send('capture-frames-result', frames);
      }).catch(() => ipcRenderer.send('capture-frames-result', []));
    });
  },
});

async function captureFramesFor(videoPath, times) {
  const frames = [];
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.width = '640px';
  video.src = videoPath.startsWith('\\\\') || videoPath.startsWith('//')
    ? 'file://' + videoPath.split('\\').join('/').split('/').map(s => s ? encodeURIComponent(s) : '').join('/')
    : 'file:///' + videoPath.split('\\').join('/').split('/').map(s => s ? encodeURIComponent(s) : '').join('/');
  document.body.appendChild(video);

  const waitSeek = (t) => new Promise((resolve, reject) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); setTimeout(resolve, 120); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
    setTimeout(() => reject(new Error('seek timeout')), 8000);
  });

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('无法解码: ' + videoPath));
      setTimeout(() => reject(new Error('加载超时')), 20000);
    });
    // 先让播放流动起来再逐帧定位：缺索引的大 mkv 未播放时深定位会永久卡死
    try { await video.play(); } catch { /* 自动播放策略拒绝时按原样继续 */ }
    for (const t of times) {
      try {
        await waitSeek(Math.min(t, (video.duration || t) - 0.1));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        // 帧质量打分：亮度 + 色彩丰富度（挑封面用，避开黑屏/纯色帧）
        let score = 0;
        try {
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let lum = 0, sat = 0, n = 0;
          for (let i = 0; i < data.length; i += 4 * 97) { // 采样
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            lum += 0.299 * r + 0.587 * g + 0.114 * b;
            sat += mx === 0 ? 0 : (mx - mn) / mx;
            n++;
          }
          if (n) {
            lum /= n; sat /= n;
            // 偏好亮度适中（避免黑帧/白帧）、色彩饱满
            score = (sat * 60) + (lum > 25 && lum < 215 ? 40 - Math.abs(lum - 120) * 0.15 : 0);
          }
        } catch { /* 跨域等情况忽略打分 */ }
        frames.push({ time: t, base64Jpeg: canvas.toDataURL('image/jpeg', 0.8).split(',')[1], score });
      } catch { /* 单帧失败跳过 */ }
    }
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.remove();
  }
  return frames;
}
