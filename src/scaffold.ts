import { App, Modal, Notice, Setting, normalizePath, TFile } from "obsidian";
import type NovelTrackerPlugin from "./main";
import {
  bibleTemplate,
  worldbookTemplate,
  characterTemplate,
  TRACKER_TEMPLATES,
} from "./templates";
import { BIBLE_FILENAME } from "./project";

export class NewProjectModal extends Modal {
  private name = "";
  private genre = "";
  private synopsis = "";
  private parentDir = "";

  constructor(app: App, private plugin: NovelTrackerPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "新建小说项目" });

    new Setting(contentEl)
      .setName("小说名")
      .addText((t) => t.onChange((v) => (this.name = v.trim())));

    new Setting(contentEl)
      .setName("题材")
      .setDesc("如：现代探案、西幻、科幻末世（AI 生成引导问题时会参考）")
      .addText((t) => t.onChange((v) => (this.genre = v.trim())));

    new Setting(contentEl)
      .setName("一句话简介")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.onChange((v) => (this.synopsis = v.trim()));
      });

    new Setting(contentEl)
      .setName("放在哪个文件夹下")
      .setDesc("vault 相对路径，留空则放在 vault 根目录")
      .addText((t) =>
        t
          .setPlaceholder("搞创作/比较严肃的正在推进")
          .onChange((v) => (this.parentDir = v.trim().replace(/\/$/, "")))
      );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("创建")
        .setCta()
        .onClick(() => this.create())
    );
  }

  private async create() {
    if (!this.name) return new Notice("小说名不能为空");
    const root = normalizePath(
      this.parentDir ? `${this.parentDir}/${this.name}` : this.name
    );
    if (this.app.vault.getAbstractFileByPath(root)) {
      return new Notice(`已存在同名文件夹：${root}`);
    }

    const dirs = [root, `${root}/正文`, `${root}/周边设定`, `${root}/角色清单`];
    for (const d of dirs) {
      await this.app.vault.createFolder(d).catch(() => {});
    }

    await this.app.vault.create(
      `${root}/${BIBLE_FILENAME}`,
      bibleTemplate(this.name, this.genre, this.synopsis)
    );
    await this.app.vault.create(
      `${root}/周边设定/世界观手册.md`,
      worldbookTemplate(this.name)
    );
    for (const [filename, content] of Object.entries(TRACKER_TEMPLATES)) {
      await this.app.vault.create(`${root}/周边设定/${filename}`, content);
    }
    await this.app.vault.create(
      `${root}/角色清单/角色卡模板.md`,
      characterTemplate("（复制本文件并改名为角色名）")
    );

    new Notice(`项目「${this.name}」已创建`);
    this.close();

    const bible = this.app.vault.getFileByPath(`${root}/${BIBLE_FILENAME}`);
    if (bible instanceof TFile) {
      await this.app.workspace.getLeaf().openFile(bible);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** AI 按题材深化世界观引导问题，追加到当前打开的世界观手册 */
export async function deepenWorldbookQuestions(plugin: NovelTrackerPlugin): Promise<void> {
  const ctx = plugin.getActiveContext();
  if (!ctx || !ctx.project) return;
  const { file, project } = ctx;

  const bibleContent = await plugin.app.vault.read(project.bibleFile);
  const notice = new Notice("正在生成针对性引导问题…", 0);
  try {
    const provider = plugin.llm();
    const reply = await provider.complete({
      system:
        "你是小说世界观设计顾问。根据用户提供的项目档案（题材与简介），生成 5-8 个针对该题材的世界观引导问题，" +
        "帮作者想清楚容易被忽略但会在写作中变成坑的设定。探案题材要问作案逻辑链与信息封锁，奇幻要问力量体系的代价与边界，以此类推。" +
        "只输出 Markdown 无序列表（每行一个问题），不要其他内容、不要标题。",
      messages: [{ role: "user", content: bibleContent.slice(0, 4000) }],
    });
    const current = await plugin.app.vault.read(file);
    await plugin.app.vault.modify(
      file,
      current + `\n\n### AI 深化引导问题\n\n${reply.trim()}\n`
    );
    new Notice("已追加到文档末尾");
  } catch (e) {
    new Notice(`生成失败: ${(e as Error).message}`, 8000);
  } finally {
    notice.hide();
  }
}
