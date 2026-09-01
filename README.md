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

## License

[MIT](./LICENSE)
