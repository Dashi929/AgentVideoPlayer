# AgentVideoPlayer

跨平台本地视频播放器，带 AI Agent 整理与片库功能。基于 Electron 构建，运行时零第三方依赖。

## 功能特性

- **本地视频播放** — 内置播放器，支持常见视频格式，无边框窗口界面
- **片库管理** — 自动扫描本地视频目录，按分类/标签/收藏组织片库
- **AI Agent 整理** — 通过 AI 自动识别视频元信息，生成标题、标签、封面，并支持重命名/分类等虚拟整理操作（只写本地数据库，不改真实文件路径）
- **任务队列** — AI 任务串行排队执行，逐项容错，失败不影响已完成项
- **DLNA 投屏** — 局域网内投放到 DLNA 设备播放
- **内置 HTTP 服务** — 局域网串流播放

## 环境要求

- [Node.js](https://nodejs.org/) 18+
- npm

## 快速开始

```bash
# 安装依赖（仅 electron 与 electron-builder 两个开发依赖）
npm install

# 以开发模式启动
npm start

# 打包 Windows 安装包与便携版
# 产物 exe 输出到 dist-exe/ 目录
npm run dist
```

## 项目结构

```
├── main/            # Electron 主进程
│   ├── main.js      # 入口：窗口创建与 IPC
│   ├── agent.js     # AI Agent 任务调度
│   ├── ai.js        # AI 接口调用
│   ├── aiMedia.js   # 视频元信息识别
│   ├── queue.js     # 串行任务队列
│   ├── scanner.js   # 本地视频目录扫描
│   ├── db.js        # 本地数据存储
│   ├── media.js     # 媒体信息处理
│   ├── files.js     # 文件操作
│   ├── dlna.js      # DLNA 投屏
│   ├── server.js    # 局域网 HTTP 串流服务
│   └── preload.js   # 预加载脚本
├── renderer/        # 渲染进程（界面）
│   ├── index.html
│   ├── styles.css
│   └── js/          # 播放器、片库、Agent 面板等模块
└── scripts/
    └── dist.js      # 打包脚本
```

## 说明

- AI 整理产生的重命名/分类/封面均为**虚拟操作**，只写入本地应用数据，不会修改磁盘上的真实文件。
- AI 功能需要在设置中配置自己的 API Key。

## 设为系统默认播放器（Windows）

1. 在应用「设置」页点击 **注册文件关联**（写入当前用户注册表 HKCU，无需管理员权限）。
2. 在资源管理器中右键任意视频文件 → **打开方式** → 选择 **AgentVideoPlayer**，并勾选 **始终**；
   也可以到 Windows 设置 → 应用 → **默认应用** 中按格式指定。

之后双击视频文件即可直接用本应用播放；文件不在片库中时会自动登记进片库（可记忆播放进度、打标签、AI 分析）。
应用运行中再次双击其他视频，会在同一窗口直接切换播放。

- 便携版、安装版、开发模式（`npm start`）都支持上述注册方式。
- 开发模式下「打开方式」菜单的应用名/图标默认来自 electron.exe（显示「Electron」），注册时会自动通过 MuiCache 把显示名覆盖为 AgentVideoPlayer，并使用 `resources/icon.ico` 作为关联图标；打包版则直接使用安装 exe 自带名称与图标。
- 若使用 NSIS 安装包并希望安装时静默注册，可改用 `build.fileAssociations` 配置（注意 electron-builder 要求同时开启 `nsis.perMachine`，安装时需要管理员权限）。

## License

[MIT](./LICENSE)
