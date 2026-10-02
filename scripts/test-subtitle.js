// 临时验证脚本：无窗口跑主进程 media.js 的内嵌字幕链路
// 用法：npx electron scripts/test-subtitle.js <视频文件>
const { app } = require('electron');
const media = require('../main/media');

app.whenReady().then(async () => {
  const file = process.argv[2];
  if (!file) { console.error('need a video file'); app.exit(1); return; }
  try {
    const t0 = Date.now();
    const info = await media.probeMedia(file);
    console.log('probe ms:', Date.now() - t0);
    console.log('subtitleTracks:', JSON.stringify(info.subtitleTracks, null, 2));
    console.log('audioTracks:', info.audioTracks.map(t => `${t.streamIndex}:${t.codec}:${t.lang}`).join(', '));
    console.log('videoCopyable:', info.videoCopyable, 'duration:', info.duration);
    if (!info.subtitleTracks.length) { console.log('no embedded subs'); app.exit(0); return; }
    const t = info.subtitleTracks[0];
    const t1 = Date.now();
    const vtt = await media.extractSubtitle(file, t.streamIndex);
    console.log(`extract ms (${t.codec}):`, Date.now() - t1, 'vtt bytes:', Buffer.byteLength(vtt));
    console.log('vtt head:', JSON.stringify(vtt.slice(0, 120)));
    const t2 = Date.now();
    const vtt2 = await media.extractSubtitle(file, t.streamIndex);
    console.log('cached extract ms:', Date.now() - t2, 'same:', vtt2 === vtt);
    console.log('PASS');
    app.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    app.exit(1);
  }
});
