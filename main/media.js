const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ffmpegOk = null;

function checkFfmpeg() {
  return new Promise((resolve) => {
    if (ffmpegOk !== null) return resolve(ffmpegOk);
    execFile('ffmpeg', ['-version'], (err) => {
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
      await run('ffmpeg', [
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

module.exports = { checkFfmpeg, probeDuration, extractFrames, tempFramesDir };
