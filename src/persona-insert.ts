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
  const tableMatch = content.match(/^\|\s*MBTI\s*\|\s*([A-Za-z]{4})\s*\|/m);
  const listMatch = content.match(/^[-*]\s*MBTI\s*[:：]\s*([A-Za-z]{4})\b/m);
  const mbtiRaw = tableMatch?.[1] ?? listMatch?.[1];
  if (!mbtiRaw) {
    return void new Notice(
      "没找到已填写的 MBTI（支持格式：`| MBTI | INFP |` 或 `- MBTI：INFP`）"
    );
  }
  const mbti = mbtiRaw.toUpperCase();
  const stack = JUNG_STACKS[mbti];
  if (!stack) return void new Notice(`无法识别的 MBTI 类型：${mbti}`);

  const format: "table" | "list" = tableMatch ? "table" : "list";
  const recommended = MBTI_TO_ENNEAGRAM[mbti] ?? [];
  new EnneagramPickModal(plugin, file, mbti, stack, recommended, format).open();
}

class EnneagramPickModal extends SuggestModal<string> {
  constructor(
    private plugin: NovelTrackerPlugin,
    private file: TFile,
    private mbti: string,
    private stack: string[],
    private recommended: string[],
    private format: "table" | "list"
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
    const fields: [string, string][] = [
      ["荣格八维", jung],
      ["九型人格", type],
      ["九型简述", ENNEAGRAM_DESC[type]],
    ];

    let updated = content;
    const missing: string[] = [];
    for (const [label, value] of fields) {
      const tableRe = new RegExp(`^\\|\\s*${label}\\s*\\|.*\\|$`, "m");
      const listRe = new RegExp(`^([-*]\\s*${label}\\s*[:：]\\s*).*$`, "m");
      if (tableRe.test(updated)) {
        updated = updated.replace(tableRe, `| ${label} | ${value} |`);
      } else if (listRe.test(updated)) {
        updated = updated.replace(listRe, `$1${value}`);
      } else {
        missing.push(label);
      }
    }

    if (missing.length > 0) {
      // 缺行：紧跟在 MBTI 那一行之后插入，格式沿用 MBTI 本身的格式
      const mbtiLineRe =
        this.format === "table"
          ? /^\|\s*MBTI\s*\|.*\|$/m
          : /^[-*]\s*MBTI\s*[:：].*$/m;
      const newLines = missing.map((label) => {
        const value = fields.find(([l]) => l === label)![1];
        return this.format === "table" ? `| ${label} | ${value} |` : `- ${label}：${value}`;
      });
      updated = updated.replace(mbtiLineRe, (line) => `${line}\n${newLines.join("\n")}`);
    }

    await this.plugin.app.vault.modify(this.file, updated);

    const wrote = fields.map(([l]) => l).filter((l) => !missing.includes(l));
    const msg =
      missing.length === 0
        ? `已填入 ${this.mbti} 八维排序与 ${type} 简述`
        : `已写入：${wrote.join("、") || "（无，原表格行缺失）"}；新建了缺失的行：${missing.join("、")}`;
    new Notice(msg, 6000);
  }
}
