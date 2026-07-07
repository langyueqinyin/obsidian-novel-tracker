import type { App, TFile } from "obsidian";

/**
 * 追踪文件的 Markdown 表格解析与回写。
 * 原则：容忍一切人工编辑——解析时只认表格结构，不假设行的来源；
 * 回写时只追加行或修改匹配到的单元格，绝不重排、绝不删除人工行。
 */

export interface ParsedTable {
  /** 表头单元格（trim 后） */
  header: string[];
  /** 表头所在行号（0-based） */
  headerLine: number;
  /** 数据行（不含分隔行） */
  rows: { line: number; cells: string[] }[];
  /** 表格最后一行的行号 */
  lastLine: number;
}

function parseCells(line: string): string[] {
  // "| a | b |" -> ["a", "b"]；容忍行尾没有 |
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|?\s*$/.test(line) && line.includes("|");
}

function isSeparatorLine(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/** 解析文档中所有表格 */
export function findTables(content: string): ParsedTable[] {
  const lines = content.split("\n");
  const tables: ParsedTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (
      isTableLine(lines[i]) &&
      i + 1 < lines.length &&
      isSeparatorLine(lines[i + 1])
    ) {
      const header = parseCells(lines[i]);
      const rows: ParsedTable["rows"] = [];
      let j = i + 2;
      while (j < lines.length && isTableLine(lines[j])) {
        if (!isSeparatorLine(lines[j])) {
          const cells = parseCells(lines[j]);
          // 跳过完全空白的占位行
          if (cells.some((c) => c !== "")) {
            rows.push({ line: j, cells });
          }
        }
        j++;
      }
      tables.push({ header, headerLine: i, rows, lastLine: j - 1 });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

/** 按表头首列名找表格（如 "扣子描述"、"章节"） */
export function findTableByFirstHeader(
  content: string,
  firstHeader: string
): ParsedTable | null {
  return (
    findTables(content).find((t) => t.header[0] === firstHeader) ?? null
  );
}

function makeRow(cells: (string | null | undefined)[]): string {
  return `| ${cells
    .map((c) => String(c ?? "").replace(/\|/g, "／").replace(/\n/g, " "))
    .join(" | ")} |`;
}

/** 在指定表格末尾追加行，返回新内容 */
export function appendRows(
  content: string,
  table: ParsedTable,
  newRows: string[][]
): string {
  const lines = content.split("\n");
  const inserted = newRows.map(makeRow);
  lines.splice(table.lastLine + 1, 0, ...inserted);
  return lines.join("\n");
}

/** 修改表格中某行的某列（按行号定位），返回新内容 */
export function updateCell(
  content: string,
  row: { line: number; cells: string[] },
  colIndex: number,
  value: string,
  headerLength: number
): string {
  const lines = content.split("\n");
  const cells = [...row.cells];
  while (cells.length < headerLength) cells.push("");
  cells[colIndex] = value;
  lines[row.line] = makeRow(cells);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 各追踪文件的领域操作                                                  */
/* ------------------------------------------------------------------ */

export interface ForeshadowEntry {
  description: string;
  chapter: string;
  status: string; // 未回收 / 已回收 / 弃用
  resolvedChapter: string;
  note: string;
}

export function parseForeshadow(content: string): {
  table: ParsedTable | null;
  entries: (ForeshadowEntry & { line: number })[];
} {
  const table = findTableByFirstHeader(content, "扣子描述");
  if (!table) return { table: null, entries: [] };
  return {
    table,
    entries: table.rows.map((r) => ({
      line: r.line,
      description: r.cells[0] ?? "",
      chapter: r.cells[1] ?? "",
      status: r.cells[2] ?? "",
      resolvedChapter: r.cells[3] ?? "",
      note: r.cells[4] ?? "",
    })),
  };
}

/** 追加新扣子 */
export function addForeshadow(
  content: string,
  items: { description: string; chapter: string; note?: string }[]
): string {
  const { table } = parseForeshadow(content);
  if (!table) return content;
  return appendRows(
    content,
    table,
    items.map((i) => [i.description, i.chapter, "未回收", "", i.note ?? ""])
  );
}

/** 把某条扣子标记为已回收（按描述模糊匹配，找不到返回 null） */
export function resolveForeshadow(
  content: string,
  description: string,
  resolvedChapter: string
): string | null {
  const { table, entries } = parseForeshadow(content);
  if (!table) return null;
  const target = entries.find(
    (e) =>
      e.status !== "已回收" &&
      (e.description.includes(description) || description.includes(e.description))
  );
  if (!target) return null;
  let updated = updateCell(
    content,
    { line: target.line, cells: [target.description, target.chapter, target.status, target.resolvedChapter, target.note] },
    2,
    "已回收",
    table.header.length
  );
  const { entries: after } = parseForeshadow(updated);
  const t2 = after.find((e) => e.line === target.line);
  if (t2) {
    updated = updateCell(
      updated,
      { line: t2.line, cells: [t2.description, t2.chapter, t2.status, t2.resolvedChapter, t2.note] },
      3,
      resolvedChapter,
      table.header.length
    );
  }
  return updated;
}

/* --- 时间线 --- */

export interface TimelineEntry {
  chapter: string;
  date: string;
  daysPassed: string;
  events: string;
  status: string; // 已写 / 计划
  line: number;
}

export function parseTimeline(content: string): {
  table: ParsedTable | null;
  entries: TimelineEntry[];
} {
  const table = findTableByFirstHeader(content, "章节");
  if (!table) return { table: null, entries: [] };
  return {
    table,
    entries: table.rows.map((r) => ({
      line: r.line,
      chapter: r.cells[0] ?? "",
      date: r.cells[1] ?? "",
      daysPassed: r.cells[2] ?? "",
      events: r.cells[3] ?? "",
      status: r.cells[4] ?? "",
    })),
  };
}

/**
 * track 后更新时间线：若该章已有"计划"行则翻转为"已写"（保留人工填的日期，把 AI 实测写进事件列备注），
 * 否则追加新行。返回 { content, planDeviation }。
 */
export function upsertTimeline(
  content: string,
  entry: { chapter: string; date: string; events: string }
): { content: string; planDeviation: string | null } {
  const { table, entries } = parseTimeline(content);
  if (!table) return { content, planDeviation: null };
  const existing = entries.find((e) => e.chapter === entry.chapter);
  if (existing) {
    let updated = content;
    let deviation: string | null = null;
    if (existing.status === "计划" || existing.status === "") {
      const row = {
        line: existing.line,
        cells: [existing.chapter, existing.date, existing.daysPassed, existing.events, existing.status],
      };
      updated = updateCell(updated, row, 4, "已写", table.header.length);
      if (existing.date && entry.date && existing.date !== entry.date) {
        deviation = `计划时间「${existing.date}」，实写「${entry.date}」`;
        const { entries: after } = parseTimeline(updated);
        const t = after.find((e) => e.line === existing.line);
        if (t) {
          updated = updateCell(
            updated,
            { line: t.line, cells: [t.chapter, t.date, t.daysPassed, t.events, t.status] },
            1,
            entry.date,
            table.header.length
          );
        }
      }
    }
    return { content: updated, planDeviation: deviation };
  }
  return {
    content: appendRows(content, table, [
      [entry.chapter, entry.date, "", entry.events, "已写"],
    ]),
    planDeviation: null,
  };
}

/* --- 情节梗清单 --- */

export function parsePlotIdeas(content: string) {
  const table = findTableByFirstHeader(content, "梗");
  if (!table) return { table: null, entries: [] as { line: number; idea: string; status: string; note: string }[] };
  return {
    table,
    entries: table.rows.map((r) => ({
      line: r.line,
      idea: r.cells[0] ?? "",
      status: r.cells[1] ?? "",
      note: r.cells[2] ?? "",
    })),
  };
}

export function markPlotIdeaUsed(
  content: string,
  ideaText: string,
  chapter: string
): string | null {
  const { table, entries } = parsePlotIdeas(content);
  if (!table) return null;
  const target = entries.find(
    (e) => e.idea.includes(ideaText) || ideaText.includes(e.idea.replace(/\[\[|\]\]/g, ""))
  );
  if (!target) return null;
  return updateCell(
    content,
    { line: target.line, cells: [target.idea, target.status, target.note] },
    1,
    `已用于${chapter}`,
    table.header.length
  );
}

export function addPlotIdea(content: string, idea: string, note = ""): string {
  const { table } = parsePlotIdeas(content);
  if (!table) return content;
  return appendRows(content, table, [[idea, "待用", note]]);
}

/* --- 出场记录 --- */

export function upsertAppearance(
  content: string,
  chapter: string,
  characters: string[]
): string {
  const table = findTableByFirstHeader(content, "章节");
  if (!table) return content;
  const existing = table.rows.find((r) => r.cells[0] === chapter);
  if (existing) {
    return updateCell(content, existing, 1, characters.join("、"), table.header.length);
  }
  return appendRows(content, table, [[chapter, characters.join("、")]]);
}

/* --- 知情差矩阵（按事实分节） --- */

/** 在矩阵中新增/更新某事实下某角色的知情状态 */
export function upsertKnowledge(
  content: string,
  fact: string,
  character: string,
  state: string,
  chapter: string
): string {
  const lines = content.split("\n");
  // 找 "## 事实：xxx" 小节
  const factHeadingIdx = lines.findIndex(
    (l) => /^##\s*事实[:：]/.test(l) && l.includes(fact)
  );
  if (factHeadingIdx === -1) {
    // 新事实：在文档末尾加小节
    const section = [
      "",
      `## 事实：${fact}`,
      "",
      "| 角色 | 知情状态 | 得知章节 | 备注 |",
      "|---|---|---|---|",
      `| ${character} | ${state} | ${chapter} |  |`,
    ];
    return content + "\n" + section.join("\n") + "\n";
  }
  // 已有事实：找该小节里的表格
  const sectionEnd = lines.findIndex(
    (l, i) => i > factHeadingIdx && /^##\s/.test(l)
  );
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const sectionText = lines.slice(factHeadingIdx, end).join("\n");
  const table = findTableByFirstHeader(sectionText, "角色");
  if (!table) {
    lines.splice(end, 0, "", "| 角色 | 知情状态 | 得知章节 | 备注 |", "|---|---|---|---|", `| ${character} | ${state} | ${chapter} |  |`);
    return lines.join("\n");
  }
  // 行号偏移：table 的行号是相对 sectionText 的
  const offset = factHeadingIdx;
  const existingRow = table.rows.find((r) => r.cells[0] === character);
  if (existingRow) {
    const abs = { line: existingRow.line + offset, cells: existingRow.cells };
    let updated = updateCell(content, abs, 1, state, table.header.length);
    updated = updateCell(
      updated,
      { line: abs.line, cells: parseCells(updated.split("\n")[abs.line]) },
      2,
      chapter,
      table.header.length
    );
    return updated;
  }
  lines.splice(table.lastLine + offset + 1, 0, `| ${character} | ${state} | ${chapter} |  |`);
  return lines.join("\n");
}

/* --- 踩点清单（按章分节） --- */

export interface BeatEntry {
  beat: string;
  status: string; // 待踩 / 已踩 / 滚入下章
  note: string;
  line: number;
}

/** 取某章（或"下一章"）小节里的踩点表 */
export function parseBeats(
  content: string,
  sectionName: string
): { entries: BeatEntry[]; sectionStart: number; offset: number; table: ParsedTable | null } {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^##\\s*${sectionName}\\s*$`).test(l.trim()));
  if (idx === -1) return { entries: [], sectionStart: -1, offset: 0, table: null };
  const sectionEnd = lines.findIndex((l, i) => i > idx && /^##\s/.test(l));
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const sectionText = lines.slice(idx, end).join("\n");
  const table = findTableByFirstHeader(sectionText, "情节点");
  if (!table) return { entries: [], sectionStart: idx, offset: idx, table: null };
  return {
    sectionStart: idx,
    offset: idx,
    table,
    entries: table.rows.map((r) => ({
      line: r.line + idx,
      beat: r.cells[0] ?? "",
      status: r.cells[1] ?? "",
      note: r.cells[2] ?? "",
    })),
  };
}

/** 更新踩点状态；漏踩的滚入指定的下一章小节（没有则创建） */
export function updateBeats(
  content: string,
  sectionName: string,
  hit: string[],
  missed: string[],
  nextSectionName: string
): string {
  let updated = content;
  const { entries, table, offset } = parseBeats(updated, sectionName);
  if (table) {
    for (const e of entries) {
      const isHit = hit.some((h) => e.beat.includes(h) || h.includes(e.beat));
      const isMissed = missed.some((m) => e.beat.includes(m) || m.includes(e.beat));
      if (!isHit && !isMissed) continue;
      const freshCells = parseCells(updated.split("\n")[e.line]);
      updated = updateCell(
        updated,
        { line: e.line, cells: freshCells },
        1,
        isHit ? "已踩" : "滚入下章",
        table.header.length
      );
    }
  }
  // 漏踩的追加进下一章小节
  if (missed.length > 0) {
    const next = parseBeats(updated, nextSectionName);
    if (next.table) {
      const lines = updated.split("\n");
      lines.splice(
        next.table.lastLine + next.offset + 1,
        0,
        ...missed.map((m) => `| ${m} | 待踩 | 自${sectionName}滚入 |`)
      );
      updated = lines.join("\n");
    } else {
      updated +=
        `\n\n## ${nextSectionName}\n\n| 情节点 | 状态 | 备注 |\n|---|---|---|\n` +
        missed.map((m) => `| ${m} | 待踩 | 自${sectionName}滚入 |`).join("\n") +
        "\n";
    }
  }
  return updated;
}

/* --- 灵感收集箱 --- */

const INBOX_DONE_PREFIX = "[已处理]";

export function appendInboxItem(content: string, text: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${stamp} ${text}`;
  return content.trimEnd() + "\n" + line + "\n";
}

export function listUnprocessedInbox(content: string): { line: number; text: string }[] {
  return content
    .split("\n")
    .map((l, i) => ({ line: i, text: l }))
    .filter(
      (x) =>
        /^\s*-\s+/.test(x.text) &&
        !x.text.includes(INBOX_DONE_PREFIX) &&
        x.text.replace(/^\s*-\s+/, "").trim() !== ""
    )
    .map((x) => ({ line: x.line, text: x.text.replace(/^\s*-\s+/, "").trim() }));
}

export function markInboxProcessed(content: string, lineNumbers: number[]): string {
  const lines = content.split("\n");
  for (const n of lineNumbers) {
    if (lines[n] !== undefined && /^\s*-\s+/.test(lines[n])) {
      lines[n] = lines[n].replace(/^(\s*-\s+)/, `$1${INBOX_DONE_PREFIX} `);
    }
  }
  return lines.join("\n");
}

/* --- 通用读写 --- */

export async function modifyFile(
  app: App,
  file: TFile,
  fn: (content: string) => string | Promise<string>
): Promise<void> {
  const content = await app.vault.read(file);
  const updated = await fn(content);
  if (updated !== content) await app.vault.modify(file, updated);
}
