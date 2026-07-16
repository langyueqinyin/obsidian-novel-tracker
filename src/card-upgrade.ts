import { Notice } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { findTableByFirstHeader } from "./trackers";

/**
 * 「补全角色卡模板区块」：旧角色卡（插件之前建的）缺少插件依赖的结构时，
 * Track 提取到的痕迹/状态会静默丢失。此命令检测缺失区块并追加到文档末尾。
 */
export async function upgradeCharacterCard(plugin: NovelTrackerPlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) return void new Notice("请先打开要补结构的角色卡");

  const content = await plugin.app.vault.read(file);
  const additions: string[] = [];
  const added: string[] = [];

  // 1. 痕迹追踪表（Track 的新痕迹写入点）
  if (!findTableByFirstHeader(content, "痕迹")) {
    additions.push(
      `## 痕迹追踪表\n\n<!-- 身体伤痕、纹身、心理创伤、事件养成的特殊习惯。track 章节时 AI 会自动识别新增痕迹写进来。 -->\n\n| 痕迹 | 类型 | 来源 | 是否永久 | 备注 |\n|---|---|---|---|---|`
    );
    added.push("痕迹追踪表");
  }

  // 2. 状态快照（Track 的角色状态写入点）
  if (!/^#{1,6}\s*状态快照\s*$/m.test(content)) {
    additions.push(
      `## 状态快照\n\n<!-- 按章更新的当前状态。track 章节时 AI 会在此追加。 -->`
    );
    added.push("状态快照");
  }

  // 3. 人格模型（插入人格参考命令的落点；已有任意格式的 MBTI 行则不重复建）
  const hasMbti =
    /^\|\s*MBTI\s*\|/m.test(content) || /^[-*]\s*MBTI\s*[:：]/m.test(content);
  if (!hasMbti) {
    additions.push(
      `## 人格模型\n\n| 项目 | 内容 |\n|---|---|\n| MBTI |  |\n| 荣格八维 | （填入 MBTI 后运行「插入人格参考」命令自动生成） |\n| 九型人格 |  |\n| 九型简述 | （选定九型后自动生成） |`
    );
    added.push("人格模型");
  }

  if (additions.length === 0) {
    return void new Notice("这张卡的结构已经齐了，不需要补");
  }

  await plugin.app.vault.modify(
    file,
    content.trimEnd() + "\n\n" + additions.join("\n\n") + "\n"
  );
  new Notice(`已在文档末尾补上：${added.join("、")}（位置可以自己挪，插件按标题和表头找）`, 8000);
}
