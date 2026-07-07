import { ItemView, Notice, WorkspaceLeaf, TFile } from "obsidian";
import type NovelTrackerPlugin from "../main";
import { ProjectConfig, extractSection, projectPath } from "../project";
import { createProvider, ChatMessage } from "../llm";
import {
  gatherInspirationContext,
  archiveInboxItems,
  saveAsPlotIdea,
  appendToOutline,
  findOutlineFile,
} from "../inspiration";

export const CHAT_VIEW_TYPE = "novel-tracker-chat";

type ChatMode = "inspiration" | "stuck";

const SYSTEM_INSPIRATION = `你是小说创作教练。作者积攒了一批零碎灵感点，你的任务不是替她写，而是帮她挖出每个灵感真正戳中她的内核。

流程：
1. 先把灵感点聚类归纳（哪几条其实在绕同一个东西转）
2. 对每个聚类提出一两个探询式问题，帮作者确认"真正让你兴奋的是什么"——是某种情绪张力？某个画面？某种关系动力？
3. 对话中跟随作者的回应深入，不要急着给方案
4. 当作者确认了某个灵感的内核后，给出 1-2 种把它融入大纲的具体位置建议（参考提供的大纲）

语气自然，像跟朋友聊创作。回复保持精炼，一次聚焦一两个点，不要长篇大论。`;

const SYSTEM_STUCK = `你是小说创作陪聊，作者卡文了。你的任务不是直接续写，而是用角色逻辑帮她推演。

原则：
1. 先搞清楚卡在哪：是不知道角色接下来会做什么？还是知道要去哪但不知道怎么过渡？还是对已写的部分不满意？
2. 用"这个角色在这个处境下会怎么做"来推演，引用项目档案里的人物关系模式和角色设定作为依据
3. 给可能性而不是答案：展示 2-3 条不同的走向，各自说明哪个角色逻辑支撑它、会把故事带向哪里
4. 底层真相是最高基准，推演不能与它冲突
5. 如果作者的困境其实是"两个都想要"，帮她看清两个选项各自的代价

语气自然。回复精炼，别写小作文。`;

export class NovelChatView extends ItemView {
  private plugin: NovelTrackerPlugin;
  private mode: ChatMode = "inspiration";
  private project: ProjectConfig | null = null;
  private history: ChatMessage[] = [];
  private systemPrompt = "";
  private inboxLines: number[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private busy = false;

  constructor(leaf: WorkspaceLeaf, plugin: NovelTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return CHAT_VIEW_TYPE;
  }
  getDisplayText() {
    return "Novel Tracker 对话";
  }
  getIcon() {
    return "messages-square";
  }

  async onOpen() {
    this.render();
  }

  /** 由命令启动一个会话 */
  async startSession(mode: ChatMode, project: ProjectConfig, activeFile: TFile | null) {
    this.mode = mode;
    this.project = project;
    this.history = [];
    this.inboxLines = [];

    if (mode === "inspiration") {
      this.systemPrompt = SYSTEM_INSPIRATION;
      const gathered = await gatherInspirationContext(this.plugin, project);
      if (!gathered) return;
      this.inboxLines = gathered.items.map((i) => i.line);
      this.history.push({
        role: "user",
        content:
          gathered.context +
          "\n\n请开始：先聚类归纳这些灵感点，然后问我最值得先聊的那个问题。",
      });
    } else {
      this.systemPrompt = SYSTEM_STUCK;
      const bible = await this.plugin.app.vault.read(project.bibleFile);
      const outline = findOutlineFile(this.plugin.app, project);
      const outlineText = outline ? await this.plugin.app.vault.read(outline) : "";
      let draft = "";
      if (activeFile) {
        const text = await this.plugin.app.vault.read(activeFile);
        draft = `\n\n# 当前写到一半的稿子（${activeFile.basename}，取末尾部分）\n${text.slice(-4000)}`;
      }
      this.history.push({
        role: "user",
        content: `# 项目档案（bible）\n${bible.slice(0, 4000)}\n\n# 大纲\n${outlineText.slice(0, 5000) || "（无）"}${draft}\n\n我卡文了。先问我卡在哪，别急着给方案。`,
      });
    }

    this.render();
    await this.send(null);
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("novel-tracker-chat");

    const header = container.createDiv({ cls: "novel-tracker-chat-header" });
    header.createEl("strong", {
      text: this.mode === "inspiration" ? "整理灵感" : "卡文论道",
    });
    if (this.project) {
      header.createEl("span", {
        text: ` · ${this.project.root.split("/").pop()}`,
        cls: "setting-item-description",
      });
    }

    this.messagesEl = container.createDiv({ cls: "novel-tracker-chat-messages" });
    for (const m of this.history.slice(1)) {
      // 第一条是自动构建的上下文，不展示
      this.renderMessage(m.role, m.content);
    }

    if (this.mode === "inspiration" && this.project) {
      const actions = container.createDiv({ cls: "novel-tracker-chat-actions" });
      this.actionButton(actions, "选中文字→存为梗", async () => {
        const text = this.getSelectionOrLastReply();
        if (text) await saveAsPlotIdea(this.plugin, this.project!, text.slice(0, 200));
      });
      this.actionButton(actions, "选中文字→追加到大纲", async () => {
        const text = this.getSelectionOrLastReply();
        if (text) await appendToOutline(this.plugin, this.project!, text);
      });
      this.actionButton(actions, "归档本批灵感", async () => {
        await archiveInboxItems(this.plugin, this.project!, this.inboxLines);
        new Notice(`已归档 ${this.inboxLines.length} 条灵感`);
      });
    }

    const inputWrap = container.createDiv({ cls: "novel-tracker-chat-inputwrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      attr: { rows: "3", placeholder: "回复…（回车发送，Shift+回车换行）" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(this.inputEl.value.trim());
      }
    });
  }

  private actionButton(parent: HTMLElement, label: string, fn: () => Promise<void>) {
    const btn = parent.createEl("button", { text: label });
    btn.addEventListener("click", () => fn().catch((e) => new Notice(String(e))));
  }

  /** 取用户在消息区选中的文字；没有选中则取最后一条 AI 回复 */
  private getSelectionOrLastReply(): string | null {
    const sel = window.getSelection()?.toString().trim();
    if (sel) return sel;
    const lastAssistant = [...this.history].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) return lastAssistant.content;
    new Notice("先选中一段文字，或至少等 AI 回复一轮");
    return null;
  }

  private renderMessage(role: string, content: string) {
    const el = this.messagesEl.createDiv({
      cls: `novel-tracker-msg novel-tracker-msg-${role}`,
    });
    el.setText(content);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async send(userText: string | null) {
    if (this.busy) return;
    if (userText !== null) {
      if (!userText) return;
      this.history.push({ role: "user", content: userText });
      this.renderMessage("user", userText);
      this.inputEl.value = "";
    }
    this.busy = true;
    const thinking = this.messagesEl.createDiv({
      cls: "novel-tracker-msg novel-tracker-msg-assistant",
      text: "…",
    });
    try {
      const provider = createProvider(this.plugin.settings.llm);
      const reply = await provider.complete({
        system: this.systemPrompt,
        messages: this.history,
      });
      thinking.remove();
      this.history.push({ role: "assistant", content: reply });
      this.renderMessage("assistant", reply);
    } catch (e) {
      thinking.setText(`出错了: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
