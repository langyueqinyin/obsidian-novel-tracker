import { Modal, Notice, Setting, TFile } from "obsidian";
import type NovelTrackerPlugin from "./main";
import {
  ProjectConfig,
  getTrackerFile,
  reportSaveDir,
  listChapters,
  projectPath,
} from "./project";
import { runTrack, applyTrackResult, chapterLabel, TrackResult, ApplySelection } from "./track";
import { findTableByFirstHeader } from "./trackers";

/** 全选的 ApplySelection（批量模式下不逐条审阅） */
function selectAll(result: TrackResult): ApplySelection {
  return {
    summary: !!result.summary,
    newIntel: result.newIntel.map(() => true),
    newSettings: result.newSettings.map(() => true),
    characterUpdates: result.characterUpdates.map(() => true),
    newTraces: result.newTraces.map(() => true),
    newForeshadow: result.newForeshadow.map(() => true),
    resolvedForeshadow: result.resolvedForeshadow.map(() => true),
    usedPlotIdeas: result.usedPlotIdeas.map(() => true),
    storyTime: !!result.storyTime,
    knowledgeUpdates: result.knowledgeUpdates.map(() => true),
    beats: result.beatsHit.length > 0 || result.beatsMissed.length > 0,
    newNPCs: result.newNPCs.map(() => true),
    appearances: result.appearingCharacters.length > 0,
  };
}

/** 已 track 过的章节 = 出场记录里已有行的章节 */
async function getTrackedLabels(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig
): Promise<Set<string>> {
  const f = getTrackerFile(plugin.app, project, "appearances");
  if (!f) return new Set();
  const content = await plugin.app.vault.read(f);
  const table = findTableByFirstHeader(content, "章节");
  return new Set(table?.rows.map((r) => r.cells[0]) ?? []);
}

export async function openBatchTrack(plugin: NovelTrackerPlugin, project: ProjectConfig) {
  const chapters = listChapters(plugin.app, project);
  const titlePagePath = projectPath(project, project.titlePagePath);
  const tracked = await getTrackedLabels(plugin, project);
  const pending = chapters.filter(
    (f) => f.path !== titlePagePath && !tracked.has(chapterLabel(f))
  );
  if (pending.length === 0) {
    return void new Notice("所有章节都已 track 过（以出场记录为准）");
  }
  new BatchTrackModal(plugin, project, pending).open();
}

class BatchTrackModal extends Modal {
  private selected: boolean[];
  private running = false;
  private cancelled = false;

  constructor(
    private plugin: NovelTrackerPlugin,
    private project: ProjectConfig,
    private pending: TFile[]
  ) {
    super(plugin.app);
    this.selected = pending.map(() => true);
  }

  onOpen() {
    this.modalEl.addClass("novel-tracker-review-modal");
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "批量 Track" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `发现 ${this.pending.length} 个未 track 的章节（以出场记录为准）。` +
        `批量模式不逐条审阅、AI 提取结果全部直接写入，跑完出一份汇总报告。` +
        `每章一次 API 调用，长文集中跑会花一些钱和时间，建议分批。`,
    });

    this.pending.forEach((f, i) => {
      new Setting(contentEl)
        .setName(f.basename)
        .addToggle((t) => t.setValue(true).onChange((v) => (this.selected[i] = v)));
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("开始批量 Track")
          .setCta()
          .onClick(() => this.run(b.buttonEl))
      );
  }

  private async run(btn: HTMLButtonElement) {
    if (this.running) return;
    this.running = true;
    const targets = this.pending.filter((_, i) => this.selected[i]);
    btn.setText("跑批中…（关掉这个窗口不会中断）");
    btn.disabled = true;

    const reportLines: string[] = [
      `# 批量 Track 报告 · ${new Date().toLocaleString("zh-CN")}`,
      "",
      `共 ${targets.length} 章。`,
      "",
    ];
    const progress = new Notice("批量 Track 开始…", 0);
    let ok = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
      if (this.cancelled) break;
      const file = targets[i];
      progress.setMessage(`批量 Track ${i + 1}/${targets.length}：${file.basename}`);
      try {
        const { result } = await runTrack(this.plugin, this.project, file);
        const log = await applyTrackResult(
          this.plugin,
          this.project,
          file,
          result,
          selectAll(result)
        );
        ok++;
        reportLines.push(`## ${file.basename}`);
        reportLines.push(`- 梗概：${result.summary || "（无）"}`);
        for (const l of log) reportLines.push(`- ${l}`);
        if (result.newForeshadow.length) {
          reportLines.push(
            `- 新扣子：${result.newForeshadow.map((x) => x.description).join("；")}`
          );
        }
        reportLines.push("");
      } catch (e) {
        failed++;
        reportLines.push(`## ${file.basename}`);
        reportLines.push(`- 失败：${(e as Error).message}`);
        reportLines.push("");
      }
    }

    progress.hide();
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    const path = `${reportSaveDir(this.plugin.app, this.project)}/批量Track报告_${stamp}.md`;
    const report = reportLines.join("\n");
    const existing = this.plugin.app.vault.getFileByPath(path);
    if (existing) await this.plugin.app.vault.modify(existing, report);
    else await this.plugin.app.vault.create(path, report);

    new Notice(`批量 Track 完成：${ok} 成功 / ${failed} 失败。报告：${path}`, 10000);
    this.running = false;
    this.close();
    const reportFile = this.plugin.app.vault.getFileByPath(path);
    if (reportFile) await this.plugin.app.workspace.getLeaf().openFile(reportFile);
  }

  onClose() {
    // 弹窗关闭不中断跑批（running 时任由后台继续）
    if (!this.running) this.cancelled = true;
    this.contentEl.empty();
  }
}
