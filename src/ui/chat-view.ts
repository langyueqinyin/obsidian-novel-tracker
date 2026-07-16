import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, TFile } from "obsidian";
import type NovelTrackerPlugin from "../main";
import {
  ProjectConfig,
  findProject,
  projectPath,
  getTrackerFile,
  listCharacters,
  extractSection,
} from "../project";
import { ChatMessage } from "../llm";
import { parseForeshadow, addBeat, modifyFile } from "../trackers";
import { chapterLabel } from "../track";
import { reportSaveDir } from "../project";
import {
  gatherInspirationContext,
  archiveInboxItems,
  saveAsPlotIdea,
  appendToOutline,
  findOutlineFile,
} from "../inspiration";

export const CHAT_VIEW_TYPE = "novel-tracker-chat";

/* ------------------------------------------------------------------ */
/* 数据模型：聊天串按文件持久化                                          */
/* ------------------------------------------------------------------ */

export interface ChapterCtxOpts {
  bible: boolean;
  outline: boolean;
  /** 本章正文喂多少 */
  chapter: "full" | "tail" | "none";
  foreshadow: boolean;
  timeline: boolean;
  snapshots: boolean;
}

const DEFAULT_CTX: ChapterCtxOpts = {
  bible: true,
  outline: true,
  chapter: "full",
  foreshadow: false,
  timeline: false,
  snapshots: false,
};

export interface StoredThread {
  key: string; // 章节串 = 文件路径；灵感串 = "insp:" + 项目根
  title: string;
  mode: "chapter" | "inspiration";
  projectRoot: string;
  filePath?: string;
  /** 首条消息发出时锁定的背景资料（不展示，只随 API 请求发送） */
  context: string;
  contextDesc: string;
  ctxOpts: ChapterCtxOpts;
  history: ChatMessage[];
  inboxLines?: number[];
  createdAt: number;
  updatedAt: number;
}

const MAX_THREADS = 30;

const SYSTEM_CHAPTER = `你是小说作者的剧情陪聊，围绕"当前这篇文稿"展开：聊走向、核对逻辑、推演卡点。

原则：
1. 若背景资料里提供了项目档案（bible），其中的底层设定与底层真相是最高事实基准，推演不能与之冲突；「阁楼仓库」里的条目是开放问题，可以一起探讨但别当成定论。若没提供 bible，以文稿本身为准
2. 不替作者写正文。作者要的是推演和讨论：用"这个角色在这个处境下会怎么做"来展开，引用人物关系模式和角色设定作为依据
3. 给可能性而不是唯一答案：卡点处展示 2-3 条不同走向，各自说明哪个角色逻辑支撑它、会把故事带向哪里
4. 如果作者的困境是"两个都想要"，帮她看清两个选项各自的代价
5. 语气自然，像跟朋友聊创作。回复精炼，一次聚焦一两个点，别写小作文`;

const SYSTEM_INSPIRATION = `你是小说创作教练。作者积攒了一批零碎灵感点，你的任务不是替她写，而是帮她挖出每个灵感真正戳中她的内核。

流程：
1. 先把灵感点聚类归纳（哪几条其实在绕同一个东西转）
2. 对每个聚类提出一两个探询式问题，帮作者确认"真正让你兴奋的是什么"——是某种情绪张力？某个画面？某种关系动力？
3. 对话中跟随作者的回应深入，不要急着给方案
4. 当作者确认了某个灵感的内核后，给出 1-2 种把它融入大纲的具体位置建议（参考提供的大纲）

语气自然，像跟朋友聊创作。回复保持精炼，一次聚焦一两个点，不要长篇大论。`;

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

export class NovelChatView extends ItemView {
  private plugin: NovelTrackerPlugin;
  private thread: StoredThread | null = null;
  private project: ProjectConfig | null = null;
  private pendingCtxOpts: ChapterCtxOpts = { ...DEFAULT_CTX };
  private busy = false;

  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;

  constructor(leaf: WorkspaceLeaf, plugin: NovelTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;

    // 主编辑区切换文件 → 自动切到对应聊天串（不抢焦点、不新开面板）：
    // 已有串的任何文件都会跟随；项目正文里的章节即使没有串也会静默新建；
    // 其他文件不自动建串（避免随手翻笔记就把串位挤掉），要聊就手动跑命令。
    this.registerEvent(
      this.plugin.app.workspace.on("file-open", (file) => {
        if (!file || file.extension !== "md") return;
        if (this.thread?.filePath === file.path) return;
        const project = findProject(this.plugin.app, file);
        if (this.store[file.path]) {
          this.openChapterThread(project, file, { silent: true });
          return;
        }
        if (!project) return;
        const chaptersPrefix = projectPath(project, project.chaptersDir) + "/";
        const titlePage = projectPath(project, project.titlePagePath);
        if (!file.path.startsWith(chaptersPrefix) || file.path === titlePage) return;
        this.openChapterThread(project, file, { silent: true });
      })
    );
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return "Novel Tracker 对话"; }
  getIcon() { return "messages-square"; }

  async onOpen() {
    this.render();
  }

  /* ---- 串管理 ---- */

  private get store(): Record<string, StoredThread> {
    return this.plugin.settings.chatThreads;
  }

  private async persist() {
    // 只保留最近 MAX_THREADS 串
    const all = Object.values(this.store).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of all.slice(MAX_THREADS)) delete this.store[t.key];
    await this.plugin.saveSettings();
  }

  /** 打开（或创建）某文件的聊天串（project 可为 null：单文件小说/任意笔记也能聊） */
  async openChapterThread(
    project: ProjectConfig | null,
    file: TFile,
    opt: { silent?: boolean } = {}
  ) {
    this.project = project;
    const existing = this.store[file.path];
    if (existing) {
      this.thread = existing;
      this.pendingCtxOpts = { ...existing.ctxOpts };
    } else {
      this.thread = {
        key: file.path,
        title: file.basename,
        mode: "chapter",
        projectRoot: project?.root ?? "",
        filePath: file.path,
        context: "",
        contextDesc: "",
        ctxOpts: { ...this.pendingCtxOpts },
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.store[file.path] = this.thread;
    }
    this.render();
    if (!opt.silent) this.inputEl?.focus();
  }

  /** 打开（或创建）本项目的灵感整理串 */
  async openInspiration(project: ProjectConfig) {
    this.project = project;
    const key = `insp:${project.root}`;
    const existing = this.store[key];
    if (existing && existing.history.length > 0) {
      this.thread = existing;
      this.render();
      return;
    }
    const gathered = await gatherInspirationContext(this.plugin, project);
    if (!gathered) return;
    this.thread = {
      key,
      title: "整理灵感",
      mode: "inspiration",
      projectRoot: project.root,
      context: gathered.context,
      contextDesc: `${gathered.items.length} 条未处理灵感 + Bible + 大纲`,
      ctxOpts: { ...DEFAULT_CTX },
      history: [],
      inboxLines: gathered.items.map((i) => i.line),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store[key] = this.thread;
    this.render();
    await this.send("请开始：先聚类归纳这些灵感点，然后问我最值得先聊的那个问题。");
  }

  /** 清空当前串重新开始（保留上下文选项设置） */
  private async restartThread() {
    if (!this.thread) return;
    const t = this.thread;
    if (t.mode === "inspiration") {
      if (!this.project) return;
      delete this.store[t.key];
      await this.persist();
      await this.openInspiration(this.project);
      return;
    }
    t.history = [];
    t.context = "";
    t.contextDesc = "";
    t.ctxOpts = { ...this.pendingCtxOpts };
    t.updatedAt = Date.now();
    await this.persist();
    this.render();
  }

  /* ---- 上下文组装 ---- */

  private async buildChapterContext(): Promise<{ text: string; desc: string[] }> {
    const app = this.plugin.app;
    const t = this.thread!;
    const project = this.project;
    const opts = t.ctxOpts;
    const parts: string[] = [];
    const desc: string[] = [];

    if (opts.chapter !== "none" && t.filePath) {
      const f = app.vault.getFileByPath(t.filePath);
      if (f) {
        const text = await app.vault.read(f);
        const body = opts.chapter === "full" ? text : text.slice(-4000);
        parts.push(`# 当前文稿（${t.title}${opts.chapter === "tail" ? "，末尾部分" : ""}）\n${body}`);
        desc.push(opts.chapter === "full" ? `本文全文(${(text.length / 1000).toFixed(1)}k字)` : "本文末尾");
      }
    }
    if (!project) {
      // 无项目：只有文稿本身可喂
      return { text: parts.join("\n\n"), desc };
    }

    if (opts.bible) {
      const bible = await app.vault.read(project.bibleFile);
      parts.push(`# 项目档案（bible，最高事实基准）\n${bible.slice(0, 6000)}`);
      desc.push("Bible");
    }
    if (opts.outline) {
      const outline = findOutlineFile(app, project);
      if (outline) {
        const text = await app.vault.read(outline);
        parts.push(`# 大纲\n${text.slice(0, 6000)}`);
        desc.push("大纲");
      }
    }
    if (opts.foreshadow) {
      const f = getTrackerFile(app, project, "foreshadow");
      if (f) {
        const { entries } = parseForeshadow(await app.vault.read(f));
        const open = entries.filter((e) => e.status === "未回收");
        parts.push(`# 未回收的扣子\n${open.map((e) => `- ${e.description}（埋于${e.chapter}）`).join("\n") || "（无）"}`);
        desc.push("伏笔");
      }
    }
    if (opts.timeline) {
      const f = getTrackerFile(app, project, "timeline");
      if (f) {
        parts.push(`# 故事内时间线\n${(await app.vault.read(f)).slice(0, 3000)}`);
        desc.push("时间线");
      }
    }
    if (opts.snapshots) {
      const cards: string[] = [];
      for (const cf of listCharacters(app, project)) {
        if (cf.basename.includes("模板")) continue;
        const content = await app.vault.read(cf);
        const snapshot = extractSection(content, "状态快照") ?? "";
        const last = snapshot.split(/^###\s/m).pop()?.slice(0, 400) ?? "";
        if (last.trim()) cards.push(`### ${cf.basename}\n${last}`);
      }
      if (cards.length) {
        parts.push(`# 角色最近状态\n${cards.join("\n\n").slice(0, 5000)}`);
        desc.push("角色快照");
      }
    }
    return { text: parts.join("\n\n"), desc };
  }

  /* ---- 发送 ---- */

  private messagesForApi(): ChatMessage[] {
    const t = this.thread!;
    if (t.history.length === 0) return [];
    const [first, ...rest] = t.history;
    const firstContent = t.context
      ? `${t.context}\n\n---\n以上是背景资料。\n\n${first.content}`
      : first.content;
    return [{ role: first.role, content: firstContent }, ...rest];
  }

  private async send(userText: string) {
    // 注意：不能要求 this.project——无项目模式（单文件小说/任意笔记）也要能发
    if (this.busy || !this.thread) return;
    const text = userText.trim();
    if (!text) return;
    const t = this.thread;

    // 首条消息：按当前 chips 锁定并组装上下文
    if (t.history.length === 0 && t.mode === "chapter") {
      t.ctxOpts = { ...this.pendingCtxOpts };
      const { text: ctx, desc } = await this.buildChapterContext();
      t.context = ctx;
      t.contextDesc = desc.join(" + ") || "无背景";
    }

    t.history.push({ role: "user", content: text });
    t.updatedAt = Date.now();
    this.render();
    if (this.inputEl) this.inputEl.value = "";

    this.busy = true;
    const thinking = this.messagesEl.createDiv({
      cls: "novel-tracker-msg novel-tracker-msg-assistant",
      text: "…",
    });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    try {
      const provider = this.plugin.llm();
      const reply = await provider.complete({
        system: t.mode === "inspiration" ? SYSTEM_INSPIRATION : SYSTEM_CHAPTER,
        messages: this.messagesForApi(),
      });
      t.history.push({ role: "assistant", content: reply });
      t.updatedAt = Date.now();
      await this.persist();
      thinking.remove();
      this.render();
    } catch (e) {
      thinking.setText(`出错了: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /* ---- 渲染 ---- */

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("novel-tracker-chat");
    const t = this.thread;

    // 头部：串切换 + 新开一串
    const header = container.createDiv({ cls: "novel-tracker-chat-header" });
    const select = header.createEl("select", { cls: "dropdown" });
    const threads = Object.values(this.store).sort((a, b) => b.updatedAt - a.updatedAt);
    if (threads.length === 0) {
      select.createEl("option", { text: "（还没有聊天串）", value: "" });
    }
    for (const th of threads) {
      const opt = select.createEl("option", {
        text: (th.mode === "inspiration" ? "灵感 · " : "") + th.title,
        value: th.key,
      });
      if (t && th.key === t.key) opt.selected = true;
    }
    select.addEventListener("change", () => {
      const th = this.store[select.value];
      if (!th) return;
      this.thread = th;
      this.pendingCtxOpts = { ...th.ctxOpts };
      // 恢复 project
      const anyFile = th.filePath
        ? this.plugin.app.vault.getFileByPath(th.filePath)
        : this.plugin.app.vault.getFileByPath(`${th.projectRoot}/项目档案.md`);
      if (anyFile) this.project = findProject(this.plugin.app, anyFile);
      this.render();
    });

    const restart = header.createEl("button", { text: "新开一串", cls: "novel-tracker-chat-restart" });
    restart.addEventListener("click", () => this.restartThread());

    if (!t) {
      container.createDiv({
        cls: "novel-tracker-chat-empty",
        text: "打开一个章节文件，然后运行「聊剧情（当前章节对话）」，或在上方选择已有的聊天串。",
      });
      return;
    }

    // 上下文选择：串未开始时可勾选；已开始则显示锁定的摘要
    const ctxBar = container.createDiv({ cls: "novel-tracker-chat-ctxbar" });
    if (t.mode === "chapter" && t.history.length === 0) {
      ctxBar.createEl("span", { text: "喂给 AI：", cls: "novel-tracker-ctx-label" });
      const chip = (label: string, get: () => boolean, set: (v: boolean) => void) => {
        const el = ctxBar.createEl("span", { text: label, cls: "chip" + (get() ? "" : " off") });
        el.addEventListener("click", () => {
          set(!get());
          el.classList.toggle("off", !get());
        });
      };
      const inProject = !!this.project;
      if (inProject) {
        chip("Bible", () => this.pendingCtxOpts.bible, (v) => (this.pendingCtxOpts.bible = v));
        chip("大纲", () => this.pendingCtxOpts.outline, (v) => (this.pendingCtxOpts.outline = v));
      }
      // 本章/本文正文三态
      const unit = inProject ? "本章" : "本文";
      const chapterChip = ctxBar.createEl("span", { cls: "chip" });
      const chapterLabels = { full: `${unit}全文`, tail: `${unit}末尾`, none: `不带${unit}` } as const;
      const syncChapterChip = () => {
        chapterChip.setText(chapterLabels[this.pendingCtxOpts.chapter]);
        chapterChip.classList.toggle("off", this.pendingCtxOpts.chapter === "none");
      };
      syncChapterChip();
      chapterChip.addEventListener("click", () => {
        const order: ChapterCtxOpts["chapter"][] = ["full", "tail", "none"];
        const next = order[(order.indexOf(this.pendingCtxOpts.chapter) + 1) % order.length];
        this.pendingCtxOpts.chapter = next;
        syncChapterChip();
      });
      if (inProject) {
        chip("伏笔", () => this.pendingCtxOpts.foreshadow, (v) => (this.pendingCtxOpts.foreshadow = v));
        chip("时间线", () => this.pendingCtxOpts.timeline, (v) => (this.pendingCtxOpts.timeline = v));
        chip("角色快照", () => this.pendingCtxOpts.snapshots, (v) => (this.pendingCtxOpts.snapshots = v));
      }
    } else {
      ctxBar.createEl("span", {
        text: `背景：${t.contextDesc || "（无）"}`,
        cls: "novel-tracker-ctx-label",
      });
    }

    // 消息区（markdown 渲染）
    this.messagesEl = container.createDiv({ cls: "novel-tracker-chat-messages" });
    for (const m of t.history) {
      this.renderMessage(m.role, m.content);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    // 动作按钮
    const actions = container.createDiv({ cls: "novel-tracker-chat-actions" });
    if (t.mode === "inspiration" && this.project) {
      this.actionButton(actions, "选中文字→存为梗", async () => {
        const text = this.getSelectionOrLastReply();
        if (text) await saveAsPlotIdea(this.plugin, this.project!, text.slice(0, 200));
      });
      this.actionButton(actions, "选中文字→追加到大纲", async () => {
        const text = this.getSelectionOrLastReply();
        if (text) await appendToOutline(this.plugin, this.project!, text);
      });
      this.actionButton(actions, "归档本批灵感", async () => {
        await archiveInboxItems(this.plugin, this.project!, t.inboxLines ?? []);
        new Notice(`已归档 ${t.inboxLines?.length ?? 0} 条灵感`);
      });
    }
    if (t.mode === "chapter" && this.project) {
      this.actionButton(actions, "选中→存为踩点", async () => {
        const text = this.getSelectionOrLastReply();
        if (!text) return;
        await this.saveAsBeat(text.slice(0, 120));
      });
      this.actionButton(actions, "选中→存为梗", async () => {
        const text = this.getSelectionOrLastReply();
        if (text) await saveAsPlotIdea(this.plugin, this.project!, text.slice(0, 200), `来自${t.title}的聊天`);
      });
    }
    if (t.history.length > 0) {
      this.actionButton(actions, "导出本串", () => this.exportThread());
    }

    // 输入区
    const inputWrap = container.createDiv({ cls: "novel-tracker-chat-inputwrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder:
          t.history.length === 0 && t.mode === "chapter"
            ? "第一条消息发送时会带上面勾选的背景…（回车发送，Shift+回车换行）"
            : "回复…（回车发送，Shift+回车换行）",
      },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(this.inputEl.value);
      }
    });
  }

  private renderMessage(role: string, content: string) {
    const el = this.messagesEl.createDiv({
      cls: `novel-tracker-msg novel-tracker-msg-${role}`,
    });
    if (role === "assistant") {
      MarkdownRenderer.render(this.plugin.app, content, el, "", this);
    } else {
      el.setText(content);
    }
  }

  /** 把聊天里选中的结论存为当前章的踩点 */
  private async saveAsBeat(beat: string) {
    if (!this.project || !this.thread?.filePath) return;
    const beatsFile = getTrackerFile(this.plugin.app, this.project, "beats");
    if (!beatsFile) return void new Notice("找不到踩点清单");
    const f = this.plugin.app.vault.getFileByPath(this.thread.filePath);
    const label = f ? chapterLabel(f) : this.thread.title;
    await modifyFile(this.plugin.app, beatsFile, (c) =>
      addBeat(c, label, beat, "来自聊天")
    );
    new Notice(`已存入踩点清单「${label}」小节`);
  }

  /** 导出当前聊天串为 md 笔记 */
  private async exportThread() {
    const t = this.thread;
    if (!t || t.history.length === 0) return;
    const app = this.plugin.app;
    const stamp = new Date().toISOString().slice(0, 10);
    const lines = [
      `# 聊天存档 · ${t.title}`,
      "",
      `- 日期：${stamp}`,
      `- 背景：${t.contextDesc || "（无）"}`,
      "",
      "---",
      "",
    ];
    for (const m of t.history) {
      lines.push(m.role === "user" ? `**我：**` : `**AI：**`, "", m.content, "");
    }
    const safeTitle = t.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    const dir = this.project
      ? reportSaveDir(app, this.project)
      : t.filePath?.split("/").slice(0, -1).join("/") || "";
    let path = `${dir ? dir + "/" : ""}聊天存档_${safeTitle}_${stamp}.md`;
    if (app.vault.getFileByPath(path)) {
      path = path.replace(/\.md$/, `_${Date.now() % 100000}.md`);
    }
    await app.vault.create(path, lines.join("\n"));
    new Notice(`已导出：${path}`, 6000);
  }

  private actionButton(parent: HTMLElement, label: string, fn: () => Promise<void>) {
    const btn = parent.createEl("button", { text: label });
    btn.addEventListener("click", () => fn().catch((e) => new Notice(String(e))));
  }

  /** 取用户在消息区选中的文字；没有选中则取最后一条 AI 回复 */
  private getSelectionOrLastReply(): string | null {
    const sel = window.getSelection()?.toString().trim();
    if (sel) return sel;
    const lastAssistant = [...(this.thread?.history ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) return lastAssistant.content;
    new Notice("先选中一段文字，或至少等 AI 回复一轮");
    return null;
  }
}
