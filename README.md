<div align="center">

<img src="build/icon-source.png" width="128" alt="DeskPet" />

# 🐾 DeskPet · 本地大模型桌宠

**连接本地部署大模型（Ollama / LM Studio / llama.cpp / vLLM）的桌面宠物**

基于 [isKage/desk-llm-pet](https://github.com/isKage/desk-llm-pet)（MIT）改造

</div>

---

## ✨ 和原版的区别

| 原版 DeskLLMPet | DeskPet（本项目） |
|---|---|
| 调用 DeepSeek 云端 API，必须填 API Key | 连接**本机 / 局域网**里的模型服务，API Key 可选，数据不出本机 |
| 双击桌宠显示 API 余额 | 双击桌宠显示**模型状态**：是否在线、当前模型、延迟、已加载到显存的模型（Ollama） |
| 模型名手动填写 | 自动读取服务上的**模型列表**；不选则自动用第一个可对话模型；对话窗口里可直接切换 |
| — | 推理模型（DeepSeek-R1 / QwQ / Qwen3 …）的 `<think>` **思考过程**单独折叠显示，不回传进上下文 |
| — | **桌宠闲聊**：右键「说句话」，或按间隔自动让模型生成一句话，用气泡说出来 |
| — | 服务没启动时给出明确提示（「连接不到本地模型服务 127.0.0.1:11434」） |

原版的动画、拖拽、窗口裁剪、插件系统、多会话管理、流式输出等功能全部保留。

## 🚀 快速开始

### 1. 准备本地模型服务（任选其一）

**Ollama（推荐）**

```bash
# 安装：https://ollama.com/download ，安装后会自动在后台运行
ollama pull qwen2.5:7b        # 或 qwen3:8b / deepseek-r1:8b / llama3.1:8b ...
```

**LM Studio**：下载模型 → 左侧「Developer」→ 启动 Server（默认 `http://127.0.0.1:1234/v1`）

**llama.cpp**：`llama-server -m model.gguf --port 8080`

**vLLM**：`vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000`

### 2. 运行桌宠

```bash
npm install
npm run dev
```

### 3. 配置

右键桌宠 → **设置 → 🧠 本地模型**：

| 配置项 | 说明 |
|---|---|
| 服务类型 | Ollama / LM Studio / llama.cpp / vLLM / 其它 OpenAI 兼容服务，切换时自动填默认地址 |
| 服务地址 | OpenAI 兼容的 base 地址，只写 `http://主机:端口` 会自动补 `/v1` |
| 模型 | 点 🔄 读取服务上的模型；留空自动使用第一个可对话模型 |
| API Key | 可选，只有服务开了鉴权时才需要 |

点 **🔗 测试连接** 确认服务在线、模型存在。

> 💡 连接**局域网里另一台机器**上的 Ollama：在那台机器上设置环境变量 `OLLAMA_HOST=0.0.0.0` 后重启 Ollama，然后在这里把地址填成 `http://那台机器的IP:11434/v1`。

## 🎮 使用

- **单击**桌宠：播放反应动画
- **双击**桌宠：显示本地模型状态气泡（可在「宠物设置」里关掉，改成随机说自定义语句）
- **右键 → 💬 AI 对话**：打开对话窗口（多会话、流式、思考过程、底部切换模型）
- **右键 → 🗨️ 说句话**：让模型生成一句话，由桌宠说出来
- **设置 → 💬 AI 对话**：temperature / max_tokens / 系统提示词 / 是否显示思考过程 / **闲聊间隔**与闲聊提示词；也可以给对话单独指定另一个服务或模型

## 🧭 行为感知 & 对话联动

- **对话联动**：等待回复时桌宠思考冒泡、推理时碎碎念、输出时忙碌点按、完成后庆祝、出错时叹气；对话窗口不在前台时，回复会用可点击的气泡同步到桌面（设置 → 💬 AI 对话）
- **行为感知**（设置 → 🧭 行为感知）：按前台程序切换情景——写代码、学习 / 文档、听音乐、看视频、打游戏；键鼠 2 分钟不动打哈欠、5 分钟睡着、回来时被惊醒；吃饭 / 熬夜提醒；元旦、春节、中秋、圣诞节日动画
- **隐私**：默认只读程序名；**窗口标题默认不读**，需手动开启（用于识别浏览器里看视频）；程序名与标题只在本机内存中匹配，不写盘、不发给模型
- 识别不准时，点「🔍 查看当前识别」看到前台程序名，把它加到对应列表即可

## 🎬 动画素材

动画素材不随仓库分发，没有 `.webm` 时会使用内置的 Canvas 占位动画。把 WebM（支持透明通道）放进 `assets/animations/idle/`（闲置）和 `assets/animations/click/`（点击反应），再到「设置 → 动画素材」里勾选即可。原作者使用的素材来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。

## 📦 打包

```bash
npm run build:win   # Windows NSIS 安装包 → dist/DeskPet Setup 2.0.0.exe
npm run build:mac   # macOS dmg（需在 macOS 上打包）
```

配置保存在 `%APPDATA%\DeskPet`（Windows）/ `~/Library/Application Support/DeskPet`（macOS），与原版互不影响。

## ✅ 自检

```bash
npm run check           # 静态自检（含地址解析、<think> 分流、离线报错等）
npm run check:renderer  # 真实 Electron 冒烟测试
```

## 🏗️ 主要改动的文件

```
src/shared/local-llm.js              # 新增：本地服务预设、地址解析、模型列表、状态检测
src/plugins/llm-chat/chat-client.js  # Key 可选、localhost→127.0.0.1、思考过程分流、模型列表
src/plugins/llm-chat/main.js         # 自动选模型、切换模型、桌宠闲聊
src/renderer/settings/*              # 「本地模型」设置页
src/renderer/bubble/*                # 模型状态卡片
```

插件开发文档见 [`src/plugins/README.md`](src/plugins/README.md)。

## 📄 License

MIT。原项目 © [isKage](https://github.com/isKage/desk-llm-pet)，本项目在其基础上修改。
