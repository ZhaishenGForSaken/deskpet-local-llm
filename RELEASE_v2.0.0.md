# 🐾 DeskPet v2.0.0（本地大模型版）

> 基于 [isKage/desk-llm-pet](https://github.com/isKage/desk-llm-pet) v1.1.0（MIT）改造

这一版把桌宠从「查 DeepSeek 余额」改造成**连接本地部署大模型**的桌宠：对话、状态、闲聊全部走你自己电脑（或局域网服务器）上的模型，数据不出本机。

## ✨ 更新内容

- 🧠 **本地模型服务**：设置页新增「本地模型」，一键切换 Ollama / LM Studio / llama.cpp / vLLM / 任意 OpenAI 兼容服务，API Key 可选
- 📋 **自动读取模型列表**：从服务读取已下载的模型；不选模型时自动使用第一个可对话模型
- 🟢 **模型状态气泡**：双击桌宠展示服务是否在线、当前模型、延迟，Ollama 还会显示已加载到显存的模型
- 💭 **思考过程展示**：DeepSeek-R1 / QwQ / Qwen3 等推理模型的 `<think>` 内容单独折叠显示，不回传进上下文
- 🔀 **对话窗口内切换模型**：底部下拉框直接换模型
- 🗨️ **桌宠闲聊**：右键「说句话」或按间隔自动让模型生成一句话，用桌宠气泡说出来
- 🔌 **友好的离线提示**：服务没启动时明确提示「连接不到本地模型服务」

## 📦 打包产物

| 平台 | 文件 |
|---|---|
| 🍎 macOS（Apple Silicon） | `DeskPet-2.0.0-arm64.dmg` |
| 🍎 macOS（Intel） | `DeskPet-2.0.0.dmg` |
| 🪟 Windows x64 | `DeskPet.Setup.2.0.0.exe` |

## ⚠️ 说明

- 配置保存在 `%APPDATA%\DeskPet`（Windows）/ `~/Library/Application Support/DeskPet`（macOS），与原版 DeskLLMPet 互不影响
- 动画素材不随仓库分发，没有 `.webm` 时使用内置的 Canvas 占位动画
