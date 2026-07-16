import { Notice, Plugin, SuggestModal, TFile } from "obsidian";
import {
  NovelTrackerSettings,
  DEFAULT_SETTINGS,
  NovelTrackerSettingTab,
} from "./settings";
import { findProject } from "./project";
import { createProvider } from "./llm";
import { NewProjectModal, deepenWorldbookQuestions } from "./scaffold";
import { insertPersonaReference } from "./persona-insert";
import { upgradeCharacterCard } from "./card-upgrade";
import { runTrack } from "./track";
import { TrackReviewModal } from "./ui/review-modal";
import { runConsistencyCheck } from "./consistency";
import { buildBriefing, BriefingModal } from "./briefing";
import {
  queryOpenForeshadow,
  queryPendingIdeas,
  queryTimelineNext,
  queryCharacterKnowledge,
} from "./queries";
import { listCharacters } from "./project";
import { QuickInspirationModal } from "./inspiration";
import { NovelChatView, CHAT_VIEW_TYPE } from "./ui/chat-view";
import { summarizeFeedback } from "./feedback";
import { openBatchTrack } from "./batch";

export default class NovelTrackerPlugin extends Plugin {
  settings: NovelTrackerSettings = DEFAULT_SETTINGS;
  private sessionUsage = { input: 0, output: 0 };
  private statusBar: HTMLElement | null = null;

  /** 统一的 LLM 入口：自动累计 token 用量到状态栏 */
  llm() {
    return createProvider(this.settings.llm, (u) => {
      this.sessionUsage.input += u.input;
      this.sessionUsage.output += u.output;
      this.updateStatusBar();
    });
  }

  private updateStatusBar() {
    if (!this.statusBar) return;
    const fmt = (n: number) =>
      n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    this.statusBar.setText(
      `NT ↑${fmt(this.sessionUsage.input)} ↓${fmt(this.sessionUsage.output)} tok`
    );
    this.statusBar.setAttr(
      "aria-label",
      `Novel Tracker 本次 Obsidian 会话的 token 消耗：输入 ${this.sessionUsage.input}，输出 ${this.sessionUsage.output}`
    );
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NovelTrackerSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar();

    this.addCommand({
      id: "new-project",
      name: "新建小说项目",
      callback: () => new NewProjectModal(this.app, this).open(),
    });

    this.addCommand({
      id: "deepen-worldbook",
      name: "AI 深化世界观引导问题（对当前文件追加）",
      callback: () => deepenWorldbookQuestions(this),
    });

    this.addCommand({
      id: "insert-persona",
      name: "插入人格参考（八维排序 + 九型简述）",
      callback: () => insertPersonaReference(this),
    });

    this.addCommand({
      id: "upgrade-character-card",
      name: "补全角色卡模板区块（旧卡迁移）",
      callback: () => upgradeCharacterCard(this),
    });

    this.addCommand({
      id: "track-chapter",
      name: "Track 本章",
      callback: () => this.trackActiveChapter(),
    });
    this.addRibbonIcon("radar", "Novel Tracker: Track 本章", () =>
      this.trackActiveChapter()
    );

    this.addCommand({
      id: "batch-track",
      name: "批量 Track 未追踪章节",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) openBatchTrack(this, ctx.project);
      },
    });

    this.addCommand({
      id: "consistency-check",
      name: "一致性检查（当前章节）",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) runConsistencyCheck(this, ctx.project, ctx.file);
      },
    });

    this.addCommand({
      id: "briefing",
      name: "回坑简报",
      callback: async () => {
        const ctx = this.getActiveContext();
        if (!ctx?.project) return;
        const briefing = await buildBriefing(this, ctx.project);
        new BriefingModal(this, ctx.project, briefing).open();
      },
    });

    this.addCommand({
      id: "query-foreshadow",
      name: "查询：还没接的扣子",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) queryOpenForeshadow(this, ctx.project);
      },
    });

    this.addCommand({
      id: "query-ideas",
      name: "查询：还没用的梗",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) queryPendingIdeas(this, ctx.project);
      },
    });

    this.addCommand({
      id: "query-timeline",
      name: "查询：时间线计划的下一步",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) queryTimelineNext(this, ctx.project);
      },
    });

    this.addCommand({
      id: "query-knowledge",
      name: "查询：某角色知道什么",
      callback: () => {
        const ctx = this.getActiveContext();
        if (!ctx?.project) return;
        const project = ctx.project;
        const names = listCharacters(this.app, project)
          .map((f) => f.basename.replace(/【.*】/g, ""))
          .filter((n) => !n.includes("模板"));
        new CharacterPickModal(this, names, (name) =>
          queryCharacterKnowledge(this, project, name)
        ).open();
      },
    });

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new NovelChatView(leaf, this));

    this.addCommand({
      id: "quick-inspiration",
      name: "速记灵感",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) new QuickInspirationModal(this.app, this, ctx.project).open();
      },
    });

    this.addCommand({
      id: "organize-inspiration",
      name: "整理灵感（对话）",
      callback: () => this.openChat("inspiration"),
    });

    this.addCommand({
      id: "stuck-discussion",
      name: "聊剧情 / 卡文论道（当前章节对话）",
      callback: () => this.openChat("chapter"),
    });

    this.addCommand({
      id: "summarize-feedback",
      name: "归纳读者反馈",
      callback: () => {
        const ctx = this.getActiveContext();
        if (ctx?.project) summarizeFeedback(this, ctx.project);
      },
    });

    this.addCommand({
      id: "which-project",
      name: "当前文件属于哪个项目（调试）",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return new Notice("没有打开的文件");
        const project = findProject(this.app, file);
        new Notice(project ? `项目根: ${project.root}` : "不属于任何小说项目");
      },
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.llm = Object.assign({}, DEFAULT_SETTINGS.llm, this.settings.llm);
    // 避免与 DEFAULT_SETTINGS 共享同一个对象引用
    this.settings.chatThreads = Object.assign({}, this.settings.chatThreads);
    this.settings.consistencyIgnores = Object.assign({}, this.settings.consistencyIgnores);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async openChat(mode: "inspiration" | "chapter") {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("请先打开一个文件");
      return;
    }
    // 聊剧情不要求文件属于项目：单文件小说/任意笔记也能聊（只喂本文）；
    // 整理灵感依赖灵感收集箱，仍需要项目。
    const project = findProject(this.app, file);
    if (mode === "inspiration" && !project) {
      new Notice("整理灵感需要小说项目（附近找不到 项目档案.md）");
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof NovelChatView) {
      if (mode === "inspiration") await view.openInspiration(project!);
      else await view.openChapterThread(project, file);
    }
  }

  async trackActiveChapter() {
    const ctx = this.getActiveContext();
    if (!ctx || !ctx.project) return;
    const notice = new Notice("Track 分析中，长章节可能要一两分钟…", 0);
    try {
      const { result } = await runTrack(this, ctx.project, ctx.file);
      new TrackReviewModal(this.app, this, ctx.project, ctx.file, result).open();
    } catch (e) {
      new Notice(`Track 失败: ${(e as Error).message}`, 8000);
    } finally {
      notice.hide();
    }
  }

  /** 便捷取当前文件 + 项目，取不到时抛 Notice */
  getActiveContext(): { file: TFile; project: ReturnType<typeof findProject> } | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("请先打开一个文件");
      return null;
    }
    const project = findProject(this.app, file);
    if (!project) {
      new Notice("当前文件不属于任何小说项目（附近找不到 项目档案.md）");
      return null;
    }
    return { file, project };
  }
}

class CharacterPickModal extends SuggestModal<string> {
  constructor(
    plugin: NovelTrackerPlugin,
    private names: string[],
    private onPick: (name: string) => void
  ) {
    super(plugin.app);
    this.setPlaceholder("选择角色（也可直接输入表里的其他名字）");
  }
  getSuggestions(query: string): string[] {
    const q = query.trim();
    const matched = this.names.filter((n) => n.includes(q));
    return q && !matched.includes(q) ? [...matched, q] : matched;
  }
  renderSuggestion(name: string, el: HTMLElement) {
    el.setText(name);
  }
  onChooseSuggestion(name: string) {
    this.onPick(name);
  }
}
