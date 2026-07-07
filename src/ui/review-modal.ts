import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type NovelTrackerPlugin from "../main";
import { ProjectConfig } from "../project";
import { TrackResult, ApplySelection, applyTrackResult } from "../track";

/** Track 结果审阅弹窗：逐条复选，确认后写入 */
export class TrackReviewModal extends Modal {
  private sel: ApplySelection;

  constructor(
    app: App,
    private plugin: NovelTrackerPlugin,
    private project: ProjectConfig,
    private chapter: TFile,
    private result: TrackResult
  ) {
    super(app);
    this.sel = {
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

  onOpen() {
    this.modalEl.addClass("novel-tracker-review-modal");
    const { contentEl } = this;
    const r = this.result;
    contentEl.createEl("h2", { text: `Track 结果审阅：${this.chapter.basename}` });
    contentEl.createEl("p", {
      text: "勾选的条目会写入对应文档，取消勾选则丢弃。",
      cls: "setting-item-description",
    });

    if (r.summary) {
      this.single(`本章梗概 → 标题页`, r.summary, (v) => (this.sel.summary = v));
    }
    this.group("新埋扣子 → 伏笔登记簿", r.newForeshadow, this.sel.newForeshadow,
      (i) => `${i.description}${i.note ? `（指向：${i.note}）` : ""}`);
    this.group("回收扣子 → 伏笔登记簿", r.resolvedForeshadow, this.sel.resolvedForeshadow,
      (i) => i.description);
    this.group("新情报 → 情报追踪", r.newIntel, this.sel.newIntel,
      (i) => `【${i.owner}】${i.content}${i.inference ? ` ⇒ ${i.inference}` : ""}`);
    this.group("知情差变化 → 知情差矩阵", r.knowledgeUpdates, this.sel.knowledgeUpdates,
      (i) => `${i.character} 对「${i.fact}」：${i.state}`);
    if (r.storyTime) {
      this.single("故事内时间 → 时间线", `${r.storyTime.date}：${r.storyTime.events}`,
        (v) => (this.sel.storyTime = v));
    }
    this.group("角色状态变化 → 角色卡快照", r.characterUpdates, this.sel.characterUpdates,
      (i) => `【${i.name}】${i.update}`);
    this.group("新痕迹 → 痕迹追踪表", r.newTraces, this.sel.newTraces,
      (i) => `【${i.character}】${i.trace}（${i.type}，${i.permanent === "是" ? "永久" : i.permanent}）`);
    this.group("新设定 → 世界观手册待归档区", r.newSettings, this.sel.newSettings,
      (i) => `【${i.category}】${i.content}`);
    this.group("新 NPC → 世界观手册 NPC 表", r.newNPCs, this.sel.newNPCs,
      (i) => `${i.name}（${i.identity}）${i.keyInfo}`);
    this.group("用掉的梗 → 情节梗清单", r.usedPlotIdeas, this.sel.usedPlotIdeas,
      (i) => i.idea);

    if (r.beatsHit.length || r.beatsMissed.length) {
      this.single(
        "踩点核对 → 踩点清单",
        `踩到：${r.beatsHit.join("；") || "无"}\n漏踩滚入下章：${r.beatsMissed.join("；") || "无"}`,
        (v) => (this.sel.beats = v)
      );
    }
    if (r.appearingCharacters.length) {
      this.single("出场记录", r.appearingCharacters.join("、"),
        (v) => (this.sel.appearances = v));
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("全部取消").onClick(() => {
          this.close();
        })
      )
      .addButton((b) =>
        b
          .setButtonText("写入勾选项")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("写入中…");
            try {
              const log = await applyTrackResult(
                this.plugin, this.project, this.chapter, this.result, this.sel
              );
              new Notice(log.length ? log.join("\n") : "没有勾选任何条目", 8000);
              this.close();
            } catch (e) {
              new Notice(`写入失败: ${(e as Error).message}`, 8000);
              b.setDisabled(false).setButtonText("写入勾选项");
            }
          })
      );
  }

  private single(title: string, desc: string, onChange: (v: boolean) => void) {
    new Setting(this.contentEl)
      .setName(title)
      .setDesc(desc)
      .addToggle((t) => t.setValue(true).onChange(onChange));
  }

  private group<T>(
    title: string,
    items: T[],
    mask: boolean[],
    render: (item: T) => string
  ) {
    if (items.length === 0) return;
    this.contentEl.createEl("h4", { text: title });
    items.forEach((item, i) => {
      new Setting(this.contentEl)
        .setDesc(render(item))
        .addToggle((t) => t.setValue(true).onChange((v) => (mask[i] = v)));
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
