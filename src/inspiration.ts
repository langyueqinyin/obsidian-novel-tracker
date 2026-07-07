import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { ProjectConfig, trackerPath, getTrackerFile } from "./project";
import { appendInboxItem, listUnprocessedInbox, markInboxProcessed, addPlotIdea, modifyFile } from "./trackers";

/** 速记灵感：小输入框，回车落进灵感收集箱 */
export class QuickInspirationModal extends Modal {
  private text = "";

  constructor(app: App, private plugin: NovelTrackerPlugin, private project: ProjectConfig) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "速记灵感" });
    const input = contentEl.createEl("textarea", {
      cls: "novel-tracker-quick-input",
      attr: { rows: "3", placeholder: "记下来就不会丢。回车提交，Shift+回车换行。" },
    });
    input.focus();
    input.addEventListener("input", () => (this.text = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("存入灵感收集箱").setCta().onClick(() => this.submit())
    );
  }

  private async submit() {
    const text = this.text.trim();
    if (!text) return;
    let file = getTrackerFile(this.plugin.app, this.project, "inbox");
    if (!file) {
      file = await this.plugin.app.vault.create(
        trackerPath(this.project, "inbox"),
        "# 灵感收集箱\n"
      );
    }
    await modifyFile(this.plugin.app, file, (c) => appendInboxItem(c, text));
    new Notice("已记入灵感收集箱");
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 找项目里的大纲文件（任意层级下名字含"大纲"的 md） */
export function findOutlineFile(app: App, project: ProjectConfig): TFile | null {
  const root = project.root
    ? app.vault.getFolderByPath(project.root)
    : app.vault.getRoot();
  if (!root) return null;
  const stack: TFolder[] = [root];
  const candidates: TFile[] = [];
  while (stack.length) {
    const folder = stack.pop()!;
    for (const child of folder.children) {
      if (child instanceof TFolder) stack.push(child);
      else if (child instanceof TFile && child.extension === "md" && child.basename.includes("大纲")) {
        candidates.push(child);
      }
    }
  }
  if (candidates.length === 0) return null;
  // 名字最短的优先（"大纲.md" 优于 "大纲修改记录.md"）
  candidates.sort((a, b) => a.basename.length - b.basename.length);
  return candidates[0];
}

/** 收集灵感整理模式的上下文 */
export async function gatherInspirationContext(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig
): Promise<{ items: { line: number; text: string }[]; context: string } | null> {
  const app = plugin.app;
  const inboxFile = getTrackerFile(app, project, "inbox");
  if (!inboxFile) {
    new Notice("找不到灵感收集箱");
    return null;
  }
  const inbox = await app.vault.read(inboxFile);
  const items = listUnprocessedInbox(inbox);
  if (items.length === 0) {
    new Notice("灵感收集箱里没有未处理的条目");
    return null;
  }
  const bible = await app.vault.read(project.bibleFile);
  const outline = findOutlineFile(app, project);
  const outlineText = outline ? await app.vault.read(outline) : "";
  const context = `# 项目档案（bible）
${bible.slice(0, 4000)}

# 大纲
${outlineText.slice(0, 6000) || "（没有大纲文件）"}

# 待整理的灵感点（${items.length} 条）
${items.map((i, n) => `${n + 1}. ${i.text}`).join("\n")}`;
  return { items, context };
}

/** 把灵感箱条目标记为已处理 */
export async function archiveInboxItems(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  lines: number[]
): Promise<void> {
  const file = getTrackerFile(plugin.app, project, "inbox");
  if (!file) return;
  await modifyFile(plugin.app, file, (c) => markInboxProcessed(c, lines));
}

/** 把一段文本存为情节梗 */
export async function saveAsPlotIdea(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  idea: string,
  note = "来自灵感整理"
): Promise<void> {
  const file = getTrackerFile(plugin.app, project, "plotIdeas");
  if (!file) return void new Notice("找不到情节梗回收清单");
  await modifyFile(plugin.app, file, (c) => addPlotIdea(c, idea, note));
  new Notice("已存为情节梗");
}

/** 把一段文本追加到大纲末尾 */
export async function appendToOutline(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  text: string
): Promise<void> {
  const outline = findOutlineFile(plugin.app, project);
  if (!outline) return void new Notice("项目里找不到大纲文件（文件名需含「大纲」）");
  const stamp = new Date().toISOString().slice(0, 10);
  await modifyFile(plugin.app, outline, (c) =>
    c.trimEnd() + `\n\n---\n（${stamp} 灵感整理落点）\n${text}\n`
  );
  new Notice(`已追加到 ${outline.basename}`);
}
