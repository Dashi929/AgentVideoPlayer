const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ffmpegBin = null;
let ffmpegOk = null;

/**
 * ffmpeg 可执行文件路径：打包版/开发版都优先用 ffmpeg-static 的二进制
 * （打包后模块被打进 asar，实际 exe 解包在 app.asar.unpacked，需换成真实磁盘路径才能 spawn），
 * 都找不到时退回 PATH。
 */
function ffmpegPath() {
  if (ffmpegBin) return ffmpegBin;
  if (process.platform === 'win32' && app.isPackaged) {
    const p = path.join(process.resourcesPath, 'ffmpeg.exe');
    if (fs.existsSync(p)) { ffmpegBin = p; return p; }
  }
  try {
    let p = require('ffmpeg-static');
    if (p && p.includes(`${path.sep}app.asar${path.sep}`)) {
      p = p.split(`${path.sep}app.asar${path.sep}`).join(`${path.sep}app.asar.unpacked${path.sep}`);
    }
    if (p && fs.existsSync(p)) { ffmpegBin = p; return p; }
  } catch { /* 未安装 ffmpeg-static 时忽略 */ }
  ffmpegBin = 'ffmpeg';
  return ffmpegBin;
}

function checkFfmpeg() {
  return new Promise((resolve) => {
    if (ffmpegOk !== null) return resolve(ffmpegOk);
    execFile(ffmpegPath(), ['-version'], (err) => {
      ffmpegOk = !err;
      resolve(ffmpegOk);
    });
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/** 用 ffprobe 探测时长（秒），失败返回 null */
async function probeDuration(file) {
  if (!(await checkFfmpeg())) return null;
  try {
    const out = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ]);
    const d = parseFloat(out.trim());
    return isFinite(d) ? d : null;
  } catch { return null; }
}

// Chromium/Electron 内置解码器只认这些音频编码；AC3/E-AC3/DTS 等会"有画面没声音"
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
// 视频流可以直接 copy 的编码；其余（mpeg4/wmv 等）转码时重编为 H.264
const VIDEO_COPY_OK = new Set(['h264', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'mjpeg']);

/** ffmpeg 的声道描述 → 简短显示文案（stereo→立体声，5.1(side)→5.1，6 channels→6声道） */
function channelsLabel(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (/^mono$/i.test(s)) return '单声道';
  if (/^stereo$/i.test(s)) return '立体声';
  const ch = s.match(/^(\d+(?:\.\d+)?)\s*channels?\b/i);
  if (ch) return ch[1] + '声道';
  return s.replace(/\([^)]*\)/g, '').trim() || s;
}

const probeCache = new Map();

/**
 * 用 ffmpeg -i 读文件头，探测音轨/视频编码。
 * 返回 { ok, duration, hasAudio, audioSupported, audioCodecs, audioTracks, defaultAudioIndex,
 *        videoCodec, videoCopyable }。
 * audioTracks 为逐条音轨明细：{ index, streamIndex, codec, lang, channels, default, supported }，
 * 供播放器做音轨切换菜单（ffmpeg -i 不输出轨标题，标题信息拿不到）。
 */
function probeMedia(file) {
  let st;
  try { st = fs.statSync(file); } catch { return Promise.resolve({ ok: false }); }
  const key = `${file.toLowerCase()}|${st.size}|${st.mtimeMs}`;
  const hit = probeCache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file],
      { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        // 只带 -i 不带输出必然退出码 1，头部信息在 stderr
        const text = stderr || '';
        if (!text.trim()) return resolve({ ok: false });
        const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const duration = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : null;
        const audio = [], video = [];
        // 形如：Stream #0:1[0x2](eng): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)
        for (const m of text.matchAll(/Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (\w+): ([a-zA-Z0-9_]+)([^\r\n]*)/g)) {
          const entry = {
            streamIndex: +m[1],
            lang: (m[2] || 'und').trim() || 'und',
            codec: m[4].toLowerCase(),
            default: /\(default\)/.test(m[0]),
            channels: '',
          };
          if (m[3] === 'Audio') {
            // "…, 48000 Hz, stereo, fltp, …" → 取 Hz 后面的声道描述
            const ch = m[5].match(/Hz,\s*([^,]+)/i);
            entry.channels = channelsLabel(ch ? ch[1] : '');
            entry.supported = AUDIO_OK.has(entry.codec);
            audio.push(entry);
          } else if (m[3] === 'Video') {
            const dim = m[5].match(/(\d{2,5})x(\d{2,5})/);
            entry.width = dim ? +dim[1] : 0;
            entry.height = dim ? +dim[2] : 0;
            video.push(entry);
          }
        }
        audio.forEach((t, i) => { t.index = i; });
        const defIdx = audio.findIndex(t => t.default);
        const info = {
          ok: true,
          duration,
          hasAudio: audio.length > 0,
          audioCodecs: [...new Set(audio.map(a => a.codec))],
          audioSupported: audio.length > 0 && audio.every(a => AUDIO_OK.has(a.codec)),
          audioTracks: audio.map(t => ({ ...t })),
          defaultAudioIndex: defIdx >= 0 ? defIdx : 0,
          videoCodec: video[0]?.codec || null,
          videoWidth: video[0]?.width || 0,
          videoHeight: video[0]?.height || 0,
          videoCopyable: video.length > 0 && VIDEO_COPY_OK.has(video[0].codec),
        };
        probeCache.set(key, info);
        resolve(info);
      });
  });
}

/** 同步取缓存的探测结果（没有就返回 null），供 video:read 决定首发 URL */
function peekProbe(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  return probeCache.get(`${file.toLowerCase()}|${st.size}|${st.mtimeMs}`) || null;
}

/**
 * 在指定时间点截帧，输出 JPEG 到 outDir。
 * 返回生成的图片路径数组；无 ffmpeg 返回 []（渲染层用 canvas 回退）。
 */
async function extractFrames(file, times, outDir, prefix = 'frame') {
  if (!(await checkFfmpeg())) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (let i = 0; i < times.length; i++) {
    const out = path.join(outDir, `${prefix}_${i}.jpg`);
    try {
      await run(ffmpegPath(), [
        '-y', '-ss', String(times[i]), '-i', file,
        '-frames:v', '1', '-q:v', '3', out,
      ]);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) results.push(out);
    } catch (e) {
      console.error('frame extract failed at', times[i], e.message);
    }
  }
  return results;
}

function tempFramesDir() {
  return path.join(os.tmpdir(), 'agent-video-player-frames');
}

module.exports = { checkFfmpeg, ffmpegPath, probeMedia, peekProbe, probeDuration, extractFrames, tempFramesDir };
