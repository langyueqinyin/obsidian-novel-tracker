# Novel Tracker

长篇小说剧情追踪 Obsidian 插件。An Obsidian plugin for tracking long-form fiction: foreshadowing, character knowledge states, in-story timelines, and inspiration management — powered by the LLM of your choice.

为连载作者解决五个真实痛点：**留了扣子接不住、角色知情差靠脑记、时间线靠手算、灵感梗散落遗忘、断更回坑无从捡起**。

## 功能

- **Track 本章**：写完一章跑一次，AI 提取新埋/回收的伏笔、角色知情变化、故事内时间、角色状态与身体/心理痕迹、新 NPC、本章梗概（自动更新目录页）——全部经审阅弹窗逐条确认后写入
- **批量 Track**：存稿多的老坑一键补录，自动跳过已追踪章节，跑完出汇总报告
- **一致性检查**：对照项目 Bible、硬设定、时间线找矛盾（地名、年龄、时间逻辑），角色语气问题单独标注为参考意见
- **回坑简报**：断更回来一键生成"上次写到哪、悬着哪些扣子、计划的下一步"
- **灵感系统**：全局快捷键速记；攒够一批后在侧边栏对话里让 AI 聚类并反问你"真正戳你的是什么"
- **章节聊天串**：每章一个独立对话串，随主编辑区切章自动跟随、切回原样还在、重启不丢；发首条消息前可勾选喂什么背景（Bible / 大纲 / 本章全文 / 伏笔 / 时间线 / 角色快照）。AI 用角色逻辑陪你推演走向，不代写
- **用量可见**：状态栏实时累计本次会话的 token 消耗；网络抖动与限流自动重试
- **本地查询**（不花 API 钱）：还没接的扣子 / 某角色知道什么 / 还没用的梗 / 时间线下一步
- **角色卡工具**：MBTI → 荣格八维排序 + 九型人格推荐与简述（离线静态数据）
- **读者反馈归纳**：评论粘进来，AI 总结读者真正吃的点

## 设计原则

- **数据即笔记**：一切追踪数据存为人类可读的 Markdown 表格，无隐藏数据库；人工增删改是一等公民，插件解析时容忍并绝不覆盖手写内容
- **模型无关**：Anthropic 原生 API 或任意 OpenAI 兼容端点（OpenAI / DeepSeek / Moonshot / 通义…），设置里自由切换
- **Bible 为纲**：每个项目根目录的 `项目档案.md` 是最高事实基准，「底层真相」区写什么 AI 就信什么，「阁楼仓库」区被视为开放问题

## 安装

### 方式一：BRAT（推荐，可自动更新）

1. 安装社区插件 [BRAT](https://obsidian.md/plugins?id=obsidian42-brat)
2. BRAT 设置 → Add Beta plugin → 填 `langyueqinyin/obsidian-novel-tracker`
3. 启用 Novel Tracker

### 方式二：手动

从 [Releases](../../releases) 下载 `main.js`、`manifest.json`、`styles.css`，放进 vault 的 `.obsidian/plugins/novel-tracker/`，然后在设置里启用。

### 配置

设置 → Novel Tracker：选 Provider、填 API key（和可选的 Base URL）、模型名，点「测试」验证。

## 快速开始

1. `Cmd/Ctrl+P` → **新建小说项目**（或在已有文件夹放一个带 `novel-tracker: true` frontmatter 的 `项目档案.md`）
2. 写完一章 → **Track 本章** → 审阅 → 写入
3. 其余命令都在命令面板里，搜中文关键词即可

## 开发

```bash
npm install
npm run dev    # watch 构建
npm run build  # 类型检查 + 产物
```

## License

MIT
