import { Notice, SuggestModal, TFile } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { JUNG_STACKS, MBTI_TO_ENNEAGRAM, ENNEAGRAM_DESC } from "./personality";

/**
 * 「插入人格参考」：读当前角色卡的 MBTI 字段，
 * 自动填入荣格八维排序，并按 MBTI 推荐九型候选供选择，选定后填入 100 字简述。
 */
export async function insertPersonaReference(plugin: NovelTrackerPlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) return void new Notice("请先打开角色卡");

  const content = await plugin.app.vault.read(file);
  const mbtiMatch = content.match(/^\|\s*MBTI\s*\|\s*([A-Za-z]{4})\s*\|/m);
  if (!mbtiMatch) {
    return void new Notice("没找到已填写的 MBTI 行（格式：| MBTI | INFP |）");
  }
  const mbti = mbtiMatch[1].toUpperCase();
  const stack = JUNG_STACKS[mbti];
  if (!stack) return void new Notice(`无法识别的 MBTI 类型：${mbti}`);

  const recommended = MBTI_TO_ENNEAGRAM[mbti] ?? [];
  new EnneagramPickModal(plugin, file, mbti, stack, recommended).open();
}

class EnneagramPickModal extends SuggestModal<string> {
  constructor(
    private plugin: NovelTrackerPlugin,
    private file: TFile,
    private mbti: string,
    private stack: string[],
    private recommended: string[]
  ) {
    super(plugin.app);
    this.setPlaceholder(`${mbti} 推荐：${recommended.join(" / ")}（也可选其他任意侧翼）`);
  }

  getSuggestions(query: string): string[] {
    const all = Object.keys(ENNEAGRAM_DESC);
    const ordered = [
      ...this.recommended,
      ...all.filter((t) => !this.recommended.includes(t)),
    ];
    return ordered.filter((t) => t.includes(query.trim()));
  }

  renderSuggestion(type: string, el: HTMLElement) {
    const isRec = this.recommended.includes(type);
    el.createEl("div", { text: isRec ? `${type}（${this.mbti} 常见匹配）` : type });
    el.createEl("small", {
      text: ENNEAGRAM_DESC[type].slice(0, 40) + "…",
      cls: "novel-tracker-suggest-desc",
    });
  }

  async onChooseSuggestion(type: string) {
    const content = await this.plugin.app.vault.read(this.file);
    const jung = `前四位：${this.stack.slice(0, 4).join(" → ")}；阴影位：${this.stack.slice(4).join(" ")}`;
    const updated = content
      .replace(/^\|\s*荣格八维\s*\|.*\|$/m, `| 荣格八维 | ${jung} |`)
      .replace(/^\|\s*九型人格\s*\|.*\|$/m, `| 九型人格 | ${type} |`)
      .replace(/^\|\s*九型简述\s*\|.*\|$/m, `| 九型简述 | ${ENNEAGRAM_DESC[type]} |`);
    await this.plugin.app.vault.modify(this.file, updated);
    new Notice(`已填入 ${this.mbti} 八维排序与 ${type} 简述`);
  }
}
