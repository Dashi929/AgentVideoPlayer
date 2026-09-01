// 打包脚本：优先输出到 build-out；若 asar 被系统锁定则自动改用时间戳目录。
// 产物 exe 始终复制到 dist-exe/（覆盖旧版），用户只需要看这个目录。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname + '/..';
const stable = path.join(root, 'dist-exe');
fs.mkdirSync(stable, { recursive: true });

function build(outDir) {
  console.log('打包到 ' + outDir + ' ...');
  execSync(`npx electron-builder --win -c.directories.output=${outDir}`, {
    cwd: root, stdio: 'inherit',
  });
}

let out = 'build-out';
try {
  build(out);
} catch {
  out = 'build-' + new Date().toISOString().replace(/[:T-]/g, '').slice(0, 12);
  console.log('默认目录被锁定，改用 ' + out);
  build(out);
}

for (const f of ['AgentVideoPlayer-Portable.exe', 'AgentVideoPlayer-Setup.exe']) {
  fs.copyFileSync(path.join(root, out, f), path.join(stable, f));
  console.log('已更新 dist-exe/' + f);
}
