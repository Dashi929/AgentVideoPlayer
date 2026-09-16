// Windows 文件关联注册（只写 HKCU，无需管理员权限）。
// 注册内容：ProgID（打开命令/图标）+ 各扩展名的 OpenWithProgids + RegisteredApplications 声明，
// 使应用出现在资源管理器「打开方式」列表和系统设置「默认应用」中。
// Win10/11 的默认程序选择（UserChoice）受系统哈希保护，程序不能替用户静默改默认，
// 需要用户在「打开方式 → 始终」或系统设置里确认一次。
const { spawnSync } = require('child_process');

const PROG_ID = 'AgentVideoPlayer.Video';
const APP_NAME = 'AgentVideoPlayer';

function runReg(args) {
  const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

/** 关联指向的打开命令；开发模式下 exe 是 electron.exe，需附加应用目录参数 */
function commandFor({ exePath, appDir }) {
  return appDir ? `"${exePath}" "${appDir}" "%1"` : `"${exePath}" "%1"`;
}

/** exts: ['mp4', ...] 或 Set，兼容带点 '.mp4' */
function extList(exts) {
  return [...exts].map(e => String(e).replace(/^\./, '').toLowerCase());
}

// 「打开方式」菜单里应用条目的显示名/图标按 exe 解析（取 exe 内嵌文件描述与图标），
// 开发模式下 exe 是 electron.exe → 显示「Electron」。MuiCache 以 exe 路径为键、
// 优先于 exe 版本信息，覆盖它即可让菜单显示 AgentVideoPlayer（两处 MuiCache 都写）。
function muiKeys(exePath) {
  return [
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\MuiCache',
    'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache',
  ].map(k => ({ key: k, value: `${exePath}.FriendlyAppName` }));
}

function register(cfg, exts) {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  const cmd = commandFor(cfg);
  const progKey = `HKCU\\Software\\Classes\\${PROG_ID}`;
  let r = runReg(['add', progKey, '/ve', '/t', 'REG_SZ', '/d', APP_NAME + ' 视频', '/f']);
  if (r.ok) r = runReg(['add', progKey, '/v', 'FriendlyTypeName', '/t', 'REG_SZ', '/d', APP_NAME + ' 视频', '/f']);
  // 图标：优先应用专属 ico（「打开方式」菜单/文件图标），打包后 exe 自带图标
  const icon = cfg.iconPath ? `"${cfg.iconPath}"` : `"${cfg.exePath}",0`;
  if (r.ok) r = runReg(['add', progKey + '\\DefaultIcon', '/ve', '/t', 'REG_SZ', '/d', icon, '/f']);
  if (r.ok) r = runReg(['add', progKey + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', cmd, '/f']);
  if (!r.ok) return { ok: false, error: (r.out || '').trim() || '注册表写入失败' };

  for (const ext of extList(exts)) {
    runReg(['add', `HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`, '/v', PROG_ID, '/t', 'REG_SZ', '/d', '', '/f']);
  }
  // 声明应用能力：出现在「Windows 设置 → 默认应用」里可逐格式指定
  const capKey = `HKCU\\Software\\${APP_NAME}\\Capabilities`;
  runReg(['add', capKey, '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', APP_NAME, '/f']);
  runReg(['add', capKey, '/v', 'ApplicationDescription', '/t', 'REG_SZ', '/d', '本地视频播放器，带 AI 整理与片库', '/f']);
  for (const ext of extList(exts)) {
    runReg(['add', capKey + '\\FileAssociations', '/v', '.' + ext, '/t', 'REG_SZ', '/d', PROG_ID, '/f']);
  }
  runReg(['add', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/t', 'REG_SZ', '/d', `Software\\${APP_NAME}\\Capabilities`, '/f']);
  for (const { key, value } of muiKeys(cfg.exePath)) {
    runReg(['add', key, '/v', value, '/t', 'REG_SZ', '/d', APP_NAME, '/f']);
  }
  return { ok: true };
}

function unregister(cfg, exts) {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  for (const ext of extList(exts)) {
    runReg(['delete', `HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`, '/v', PROG_ID, '/f']);
  }
  runReg(['delete', `HKCU\\Software\\Classes\\${PROG_ID}`, '/f']);
  runReg(['delete', `HKCU\\Software\\${APP_NAME}\\Capabilities`, '/f']);
  runReg(['delete', `HKCU\\Software\\${APP_NAME}`, '/f']);
  runReg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']);
  for (const { key, value } of muiKeys(cfg.exePath)) {
    runReg(['delete', key, '/v', value, '/f']);
  }
  return { ok: true };
}

/** state: none=未注册 registered=指向当前程序 stale=指向旧位置（如换了 exe 路径） */
function status(cfg, exts) {
  if (process.platform !== 'win32') return { supported: false, state: 'none' };
  const q = runReg(['query', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve']);
  if (!q.ok) return { supported: true, state: 'none' };
  const stored = (q.out.split(/REG_SZ/i)[1] || '').trim();
  if (!stored) return { supported: true, state: 'none' };
  // 比较 "exe" "appdir" "%1" 时忽略引号、尾部的 "%1" 占位与大小写
  const norm = (s) => s.split('"').join('').replace(/%\s*1\s*$/, '').trim().toLowerCase();
  return { supported: true, state: norm(stored) === norm(commandFor(cfg)) ? 'registered' : 'stale' };
}

/** 只刷新 MuiCache 显示名（Windows 可能把它回写成 exe 的文件描述，启动时覆盖一次自愈） */
function touchMuiCache(cfg) {
  if (process.platform !== 'win32') return;
  for (const { key, value } of muiKeys(cfg.exePath)) {
    runReg(['add', key, '/v', value, '/t', 'REG_SZ', '/d', APP_NAME, '/f']);
  }
}

module.exports = { register, unregister, status, touchMuiCache, commandFor, PROG_ID };
