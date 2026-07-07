import { Notice } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { ProjectConfig, getTrackerFile, extractSection } from "./project";
import { createProvider } from "./llm";
import { modifyFile } from "./trackers";

/** 归纳读者反馈：读评论存档区 → LLM 归纳 → 更新归纳区 */
export async function summarizeFeedback(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig
): Promise<void> {
  const app = plugin.app;
  const file = getTrackerFile(app, project, "feedback");
  if (!file) return void new Notice("找不到读者反馈库");

  const content = await app.vault.read(file);
  const archive = extractSection(content, "评论存档");
  if (!archive || archive.trim() === "") {
    return void new Notice("评论存档区是空的，先把评论粘进去");
  }

  const bible = await app.vault.read(project.bibleFile);
  const notice = new Notice("归纳读者反馈中…", 0);
  try {
    const provider = createProvider(plugin.settings.llm);
    const reply = await provider.complete({
      system:
        "你是读者反馈分析师。归纳这批小说读者评论：\n" +
        "1. 读者真正吃的点是什么（情绪、关系、桥段类型），按热度排序\n" +
        "2. 哪些章节/情节被反复提到，说明什么\n" +
        "3. 有没有值得注意的困惑或不满\n" +
        "4. 结合项目档案里的「心头好梗」，指出读者偏好与作者偏好重合的甜区\n" +
        "输出精炼的 Markdown（用三级标题分区），不超过 500 字。",
      messages: [
        {
          role: "user",
          content: `# 项目档案节选\n${bible.slice(0, 2000)}\n\n# 读者评论存档\n${archive.slice(0, 8000)}`,
        },
      ],
    });

    await modifyFile(app, file, (c) => {
      const stamp = new Date().toISOString().slice(0, 10);
      const newSummary = `## 归纳区\n\n（最近归纳：${stamp}）\n\n${reply.trim()}\n`;
      // 替换整个归纳区小节
      const lines = c.split("\n");
      const start = lines.findIndex((l) => /^##\s*归纳区\s*$/.test(l.trim()));
      if (start === -1) return newSummary + "\n" + c;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) {
          end = i;
          break;
        }
      }
      return [...lines.slice(0, start), ...newSummary.split("\n"), ...lines.slice(end)].join("\n");
    });
    new Notice("归纳区已更新");
  } catch (e) {
    new Notice(`归纳失败: ${(e as Error).message}`, 8000);
  } finally {
    notice.hide();
  }
}
