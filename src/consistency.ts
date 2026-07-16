import { Modal, Notice, Setting, TFile } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { ProjectConfig, projectPath, getTrackerFile, reportSaveDir, listCharacters, extractSection } from "./project";
import { extractJson } from "./llm";
import { chapterLabel } from "./track";

interface ConsistencyIssue {
  severity: "矛盾" | "疑似" | "语气参考";
  location: string;
  issue: string;
  basis: string;
}

const SYSTEM = `你是长篇小说的设定校对员。对照项目档案（bible）、世界观硬设定、时间线和角色资料，找出本章的矛盾。

检查项：
1. 事实矛盾：地名、人名、年龄、身体设定、组织规则与既有设定不符
2. 时间逻辑：本章故事内时间与时间线冲突（如两章间隔三天但剧情过了一个月、季节错乱、周期性事件对不上）
3. 底层真相冲突：情节走向与 bible 的底层真相相悖
4. 语气参考（单独分级）：对照角色资料与既往语言风格，指出明显不像该角色会说的对白。这类是主观参考意见，不是硬错误

规则：
- 只报告有依据的问题，每条注明依据来自哪个设定
- 没有问题就返回空数组，不要为了凑数硬找
- severity 取值：矛盾（确定冲突）/ 疑似（可能冲突，需要作者判断）/ 语气参考
- 严格输出 JSON：{"issues": [{"severity": "...", "location": "本章中的位置/引文", "issue": "问题描述", "basis": "依据（出自哪个设定文档的哪条）"}]}`;

export async function runConsistencyCheck(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  chapter: TFile
): Promise<void> {
  const app = plugin.app;
  const notice = new Notice("一致性检查中…", 0);
  try {
    const read = async (path: string): Promise<string> => {
      const f = app.vault.getFileByPath(path);
      return f ? app.vault.read(f) : "";
    };

    const chapterText = await app.vault.read(chapter);
    const bible = await app.vault.read(project.bibleFile);
    const worldbook = await read(projectPath(project, project.settingsDir, "世界观手册.md"));
    const worldbookHard = extractSection(worldbook, "硬设定速查区") ?? worldbook.slice(0, 4000);
    const timelineFile = getTrackerFile(app, project, "timeline");
    const timeline = timelineFile ? await app.vault.read(timelineFile) : "";

    const cards: string[] = [];
    for (const cf of listCharacters(app, project)) {
      if (cf.basename.includes("模板")) continue;
      const content = await app.vault.read(cf);
      cards.push(`### ${cf.basename}\n${content.slice(0, 2500)}`);
    }

    const user = `# 项目档案（bible）
${bible.slice(0, 5000)}

# 世界观硬设定
${worldbookHard.slice(0, 5000)}

# 故事内时间线
${timeline.slice(0, 3000)}

# 角色资料
${cards.join("\n\n").slice(0, 8000)}

# 待校对章节（${chapterLabel(chapter)}）
${chapterText}`;

    const provider = plugin.llm();
    const reply = await provider.complete({
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
      jsonMode: true,
    });
    const data = extractJson(reply) as { issues?: ConsistencyIssue[] };
    const issues = data.issues ?? [];
    new ConsistencyResultModal(plugin, project, chapter, issues).open();
  } catch (e) {
    new Notice(`检查失败: ${(e as Error).message}`, 8000);
  } finally {
    notice.hide();
  }
}

class ConsistencyResultModal extends Modal {
  constructor(
    private plugin: NovelTrackerPlugin,
    private project: ProjectConfig,
    private chapter: TFile,
    private issues: ConsistencyIssue[]
  ) {
    super(plugin.app);
  }

  onOpen() {
    this.modalEl.addClass("novel-tracker-review-modal");
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `一致性检查：${this.chapter.basename}` });

    if (this.issues.length === 0) {
      contentEl.createEl("p", { text: "没有发现矛盾。" });
      return;
    }

    const order = { 矛盾: 0, 疑似: 1, 语气参考: 2 } as Record<string, number>;
    const sorted = [...this.issues].sort(
      (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
    );
    for (const issue of sorted) {
      const item = contentEl.createDiv({ cls: "novel-tracker-issue" });
      item.createEl("strong", {
        text: `[${issue.severity}] ${issue.issue}`,
      });
      item.createEl("div", { text: `位置：${issue.location}`, cls: "setting-item-description" });
      item.createEl("div", { text: `依据：${issue.basis}`, cls: "setting-item-description" });
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("存为校对报告")
        .setCta()
        .onClick(async () => {
          const label = chapterLabel(this.chapter);
          const path = `${reportSaveDir(this.plugin.app, this.project)}/校对报告_${label}.md`;
          const body =
            `# 校对报告 · ${this.chapter.basename}\n\n` +
            sorted
              .map(
                (i) =>
                  `## [${i.severity}] ${i.issue}\n- 位置：${i.location}\n- 依据：${i.basis}\n`
              )
              .join("\n");
          const existing = this.plugin.app.vault.getFileByPath(path);
          if (existing) await this.plugin.app.vault.modify(existing, body);
          else await this.plugin.app.vault.create(path, body);
          new Notice(`已保存 ${path}`);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
