import { Modal, Notice, Setting } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { ProjectConfig, getTrackerFile, reportSaveDir, TRACKER_FILES } from "./project";
import {
  parseForeshadow,
  parseTimeline,
  parsePlotIdeas,
  listUnprocessedInbox,
  findTableByFirstHeader,
} from "./trackers";

/**
 * 回坑简报：纯本地聚合，不走 API。
 * 上次写到哪 / 悬着的扣子 / 未完成踩点 / 时间线计划的下一步 / 灵感箱待处理。
 */
export async function buildBriefing(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig
): Promise<string> {
  const app = plugin.app;
  const read = async (key: keyof typeof TRACKER_FILES): Promise<string> => {
    const f = getTrackerFile(app, project, key);
    return f ? app.vault.read(f) : "";
  };

  const parts: string[] = [`# 回坑简报 · ${new Date().toLocaleDateString("zh-CN")}\n`];

  // 1. 上次写到哪：时间线最后一条"已写" + 标题页最后一行
  const timeline = await read("timeline");
  const { entries: tlEntries } = parseTimeline(timeline);
  const written = tlEntries.filter((e) => e.status === "已写");
  const last = written[written.length - 1];
  parts.push("## 上次写到哪\n");
  if (last) {
    parts.push(`- 最新章节：**${last.chapter}**（故事内 ${last.date}）：${last.events}`);
  }
  const titlePage = await read("titlePage");
  const tpLines = titlePage.split("\n").filter((l) => l.includes("[["));
  if (tpLines.length) {
    parts.push(`- 目录末行：${tpLines[tpLines.length - 1]}`);
  }
  if (!last && !tpLines.length) parts.push("- （时间线和标题页都还是空的）");

  // 2. 悬着的扣子
  const foreshadow = await read("foreshadow");
  const { entries: fsEntries } = parseForeshadow(foreshadow);
  const open = fsEntries.filter((e) => e.status === "未回收");
  parts.push(`\n## 悬着的扣子（${open.length}）\n`);
  parts.push(
    open.length
      ? open.map((e) => `- ${e.description}（埋于${e.chapter}${e.note ? `，${e.note}` : ""}）`).join("\n")
      : "- 无"
  );

  // 3. 未完成踩点
  const beats = await read("beats");
  const beatTables = beats
    ? beats.split(/^##\s+/m).slice(1).map((section) => {
        const name = section.split("\n")[0].trim();
        const table = findTableByFirstHeader(section, "情节点");
        const pending =
          table?.rows.filter((r) => (r.cells[1] ?? "") === "待踩") ?? [];
        return { name, pending };
      })
    : [];
  const pendingBeats = beatTables.filter((b) => b.pending.length > 0);
  parts.push(`\n## 待踩的情节点\n`);
  parts.push(
    pendingBeats.length
      ? pendingBeats
          .map((b) => `**${b.name}**\n${b.pending.map((r) => `- ${r.cells[0]}`).join("\n")}`)
          .join("\n\n")
      : "- 无"
  );

  // 4. 时间线计划的下一步
  const planned = tlEntries.filter((e) => e.status === "计划");
  parts.push(`\n## 时间线上计划的下一步\n`);
  parts.push(
    planned.length
      ? planned.map((e) => `- ${e.chapter}（${e.date}）：${e.events}`).join("\n")
      : "- 无计划行"
  );

  // 5. 待用的梗 + 灵感箱
  const ideas = await read("plotIdeas");
  const { entries: ideaEntries } = parsePlotIdeas(ideas);
  const pendingIdeas = ideaEntries.filter((e) => e.status === "待用");
  parts.push(`\n## 还没用的梗（${pendingIdeas.length}）\n`);
  parts.push(
    pendingIdeas.length ? pendingIdeas.map((e) => `- ${e.idea}`).join("\n") : "- 无"
  );

  const inbox = await read("inbox");
  const unprocessed = listUnprocessedInbox(inbox);
  parts.push(`\n## 灵感箱待处理（${unprocessed.length}）\n`);
  parts.push(
    unprocessed.length ? unprocessed.map((i) => `- ${i.text}`).join("\n") : "- 空"
  );

  return parts.join("\n");
}

export class BriefingModal extends Modal {
  constructor(
    private plugin: NovelTrackerPlugin,
    private project: ProjectConfig,
    private briefing: string
  ) {
    super(plugin.app);
  }

  onOpen() {
    this.modalEl.addClass("novel-tracker-review-modal");
    const pre = this.contentEl.createEl("div", { cls: "novel-tracker-briefing" });
    // 简单渲染：按行输出
    for (const line of this.briefing.split("\n")) {
      if (line.startsWith("# ")) pre.createEl("h2", { text: line.slice(2) });
      else if (line.startsWith("## ")) pre.createEl("h3", { text: line.slice(3) });
      else if (line.trim()) pre.createEl("div", { text: line });
    }

    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("存档到周边设定")
        .setCta()
        .onClick(async () => {
          const stamp = new Date().toISOString().slice(0, 10);
          const path = `${reportSaveDir(this.plugin.app, this.project)}/回坑简报_${stamp}.md`;
          const existing = this.plugin.app.vault.getFileByPath(path);
          if (existing) await this.plugin.app.vault.modify(existing, this.briefing);
          else await this.plugin.app.vault.create(path, this.briefing);
          new Notice(`已保存 ${path}`);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
