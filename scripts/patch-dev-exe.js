// 把开发版 electron.exe 的版本信息改成应用自身（文件描述/产品名/公司名/图标）。
// 资源管理器「打开方式」等界面的应用显示名取自 exe 内嵌的文件描述，
// Windows 还会按真实元数据回写 MuiCache —— 之前只改注册表缓存会被冲掉重新显示
// 「Electron」，所以必须改元数据本身才稳定。npm install 后由 postinstall 自动执行。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const icon = path.join(root, 'resources', 'icon.ico');

if (process.platform !== 'win32' || !fs.existsSync(rcedit) || !fs.existsSync(electronExe)) {
  process.exit(0);
}

try {
  const args = [electronExe,
    '--set-version-string', 'FileDescription', 'AgentVideoPlayer',
    '--set-version-string', 'ProductName', 'AgentVideoPlayer',
    '--set-version-string', 'CompanyName', 'Dashi929',
  ];
  if (fs.existsSync(icon)) args.push('--set-icon', icon);
  execFileSync(rcedit, args, { stdio: 'pipe' });
  console.log('[patch-dev-exe] electron.exe 元数据已更新为 AgentVideoPlayer');
} catch (e) {
  // exe 正在运行或被占用时跳过，不影响安装流程
  console.warn('[patch-dev-exe] 跳过：' + (e.message || e));
}
process.exit(0);
