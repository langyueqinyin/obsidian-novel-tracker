import { Modal, Notice } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { ProjectConfig, getTrackerFile, TRACKER_FILES } from "./project";
import {
  parseForeshadow,
  parseTimeline,
  parsePlotIdeas,
  findTables,
} from "./trackers";

/** 结果展示小弹窗 */
class QueryResultModal extends Modal {
  constructor(plugin: NovelTrackerPlugin, private title: string, private lines: string[]) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h3", { text: this.title });
    if (this.lines.length === 0) {
      this.contentEl.createEl("p", { text: "（无）" });
      return;
    }
    const ul = this.contentEl.createEl("ul");
    for (const l of this.lines) ul.createEl("li", { text: l });
  }
  onClose() {
    this.contentEl.empty();
  }
}

async function readTracker(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  key: keyof typeof TRACKER_FILES
): Promise<string> {
  const f = getTrackerFile(plugin.app, project, key);
  return f ? plugin.app.vault.read(f) : "";
}

export async function queryOpenForeshadow(plugin: NovelTrackerPlugin, project: ProjectConfig) {
  const content = await readTracker(plugin, project, "foreshadow");
  const open = parseForeshadow(content).entries.filter((e) => e.status === "未回收");
  new QueryResultModal(
    plugin,
    `还没接的扣子（${open.length}）`,
    open.map((e) => `${e.description} —— 埋于${e.chapter}${e.note ? `（${e.note}）` : ""}`)
  ).open();
}

export async function queryPendingIdeas(plugin: NovelTrackerPlugin, project: ProjectConfig) {
  const content = await readTracker(plugin, project, "plotIdeas");
  const pending = parsePlotIdeas(content).entries.filter((e) => e.status === "待用");
  new QueryResultModal(
    plugin,
    `还没用的梗（${pending.length}）`,
    pending.map((e) => `${e.idea}${e.note ? ` —— ${e.note}` : ""}`)
  ).open();
}

export async function queryTimelineNext(plugin: NovelTrackerPlugin, project: ProjectConfig) {
  const content = await readTracker(plugin, project, "timeline");
  const planned = parseTimeline(content).entries.filter((e) => e.status === "计划");
  new QueryResultModal(
    plugin,
    "时间线上计划的下一步",
    planned.map((e) => `${e.chapter}（${e.date}）：${e.events}`)
  ).open();
}

/** 查某角色的知情状态：扫知情差矩阵所有事实小节 */
export async function queryCharacterKnowledge(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  character: string
) {
  const content = await readTracker(plugin, project, "knowledge");
  if (!content) return void new Notice("知情差矩阵是空的");

  const lines = content.split("\n");
  const results: string[] = [];
  // 遍历事实小节
  const factIndices = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => /^##\s*事实[:：]/.test(x.l));
  for (let k = 0; k < factIndices.length; k++) {
    const start = factIndices[k].i;
    const end = k + 1 < factIndices.length ? factIndices[k + 1].i : lines.length;
    const fact = factIndices[k].l.replace(/^##\s*事实[:：]\s*/, "").trim();
    const sectionText = lines.slice(start, end).join("\n");
    const table = findTables(sectionText).find((t) => t.header[0] === "角色");
    if (!table) continue;
    const row = table.rows.find((r) => r.cells[0] === character);
    if (row) {
      results.push(
        `「${fact}」：${row.cells[1] ?? ""}${row.cells[2] ? `（${row.cells[2]}）` : ""}`
      );
    } else {
      results.push(`「${fact}」：未登记（大概率不知道）`);
    }
  }
  new QueryResultModal(plugin, `${character} 的知情状态`, results).open();
}
