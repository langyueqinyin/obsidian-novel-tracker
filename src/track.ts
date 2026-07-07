import { App, Notice, TFile } from "obsidian";
import type NovelTrackerPlugin from "./main";
import {
  ProjectConfig,
  projectPath,
  trackerPath,
  getTrackerFile,
  listCharacters,
  extractSection,
} from "./project";
import { createProvider, extractJson } from "./llm";
import {
  parseForeshadow,
  addForeshadow,
  resolveForeshadow,
  markPlotIdeaUsed,
  upsertTimeline,
  upsertKnowledge,
  updateBeats,
  upsertAppearance,
  parseBeats,
  parsePlotIdeas,
  findTableByFirstHeader,
  appendRows,
  modifyFile,
} from "./trackers";

/** LLM 返回的结构化 track 结果 */
export interface TrackResult {
  summary: string;
  newIntel: { owner: string; content: string; inference?: string }[];
  newSettings: { category: string; content: string }[];
  characterUpdates: { name: string; update: string }[];
  newTraces: { character: string; trace: string; type: string; source: string; permanent: string }[];
  newForeshadow: { description: string; note?: string }[];
  resolvedForeshadow: { description: string }[];
  usedPlotIdeas: { idea: string }[];
  storyTime: { date: string; events: string } | null;
  knowledgeUpdates: { fact: string; character: string; state: string }[];
  beatsHit: string[];
  beatsMissed: string[];
  newNPCs: { name: string; identity: string; relation: string; keyInfo: string }[];
  appearingCharacters: string[];
}

/** 从章节文件名推导标签：优先"第N章"，否则取文件名开头数字，都没有就用basename */
export function chapterLabel(file: TFile): string {
  const base = file.basename;
  const m1 = base.match(/第[0-9一二三四五六七八九十百]+章/);
  if (m1) return m1[0];
  const m2 = base.match(/^(\d+)/);
  if (m2) return `第${m2[1]}章`;
  return base;
}

export interface TrackContext {
  chapterText: string;
  label: string;
  bible: string;
  worldbookHard: string;
  foreshadowOpen: string;
  timeline: string;
  plotIdeasPending: string;
  beatsPlanned: string;
  characterCards: string;
}

export async function gatherContext(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  chapter: TFile
): Promise<TrackContext> {
  const app = plugin.app;
  const read = async (path: string): Promise<string> => {
    const f = app.vault.getFileByPath(path);
    return f ? app.vault.read(f) : "";
  };
  const readTracker = async (key: Parameters<typeof getTrackerFile>[2]): Promise<string> => {
    const f = getTrackerFile(app, project, key);
    return f ? app.vault.read(f) : "";
  };

  const label = chapterLabel(chapter);
  const chapterText = await app.vault.read(chapter);
  const bible = await app.vault.read(project.bibleFile);

  const worldbook = await read(
    projectPath(project, project.settingsDir, "世界观手册.md")
  );
  const worldbookHard =
    extractSection(worldbook, "硬设定速查区") ?? worldbook.slice(0, 3000);

  const foreshadowContent = await readTracker("foreshadow");
  const { entries: fsEntries } = parseForeshadow(foreshadowContent);
  const foreshadowOpen = fsEntries
    .filter((e) => e.status === "未回收")
    .map((e) => `- ${e.description}（埋于${e.chapter}）`)
    .join("\n");

  const timeline = await readTracker("timeline");

  const plotIdeasContent = await readTracker("plotIdeas");
  const { entries: ideaEntries } = parsePlotIdeas(plotIdeasContent);
  const plotIdeasPending = ideaEntries
    .filter((e) => e.status === "待用")
    .map((e) => `- ${e.idea}`)
    .join("\n");

  const beatsContent = await readTracker("beats");
  let beatsSection = parseBeats(beatsContent, label);
  if (!beatsSection.table) beatsSection = parseBeats(beatsContent, "下一章");
  const beatsPlanned = beatsSection.entries
    .filter((e) => e.status === "待踩")
    .map((e) => `- ${e.beat}`)
    .join("\n");

  const cards: string[] = [];
  for (const cf of listCharacters(app, project)) {
    if (cf.basename.includes("模板")) continue;
    const content = await app.vault.read(cf);
    const traces = extractSection(content, "痕迹追踪表") ?? "";
    const snapshot = extractSection(content, "状态快照") ?? "";
    const lastSnapshot = snapshot.split(/^###\s/m).pop()?.slice(0, 500) ?? "";
    cards.push(`### ${cf.basename}\n痕迹：\n${traces}\n最近状态：\n${lastSnapshot}`);
  }

  return {
    chapterText,
    label,
    bible,
    worldbookHard,
    foreshadowOpen,
    timeline: timeline.slice(0, 3000),
    plotIdeasPending,
    beatsPlanned,
    characterCards: cards.join("\n\n"),
  };
}

const TRACK_SYSTEM = `你是长篇小说的剧情追踪助手。作者写完一章后，你对照项目档案（bible）、硬设定、追踪文件，从本章提取结构化信息。

规则：
- 项目档案里的「底层设定」「底层真相」是最高优先级事实基准
- 只提取本章新出现的信息，已在设定文档里的不要重复
- 「扣子/伏笔」指作者有意埋下、暗示后文的钩子：未解释的异常、意味深长的细节、被打断的话
- 新情报(newIntel)指角色获得的探案/剧情线索，owner 是获得情报的角色
- 知情差(knowledgeUpdates)：本章有角色得知了某个关键事实时记录，state 取值：知道/不知道/误以为
- 痕迹(newTraces)：本章给角色留下的持久印记，type 取值：身体/心理/习惯
- 梗概(summary)不超过30个字，风格参考"侦探识破了管家的谎言；神秘包裹再次出现"
- 严格输出 JSON，不要任何其他文字。所有数组字段没有内容时给空数组，storyTime 无法判断时给 null

输出 JSON 结构：
{
  "summary": "本章30字内梗概",
  "newIntel": [{"owner": "角色名", "content": "情报内容", "inference": "可推断出什么"}],
  "newSettings": [{"category": "地点/规则/势力/术语/其他", "content": "新设定内容"}],
  "characterUpdates": [{"name": "角色名", "update": "状态变化描述（处境/关系/心理）"}],
  "newTraces": [{"character": "角色名", "trace": "痕迹描述", "type": "身体/心理/习惯", "source": "本章事件", "permanent": "是/否/未知"}],
  "newForeshadow": [{"description": "新埋扣子描述", "note": "预期指向"}],
  "resolvedForeshadow": [{"description": "被回收的扣子（用未回收清单里的原描述）"}],
  "usedPlotIdeas": [{"idea": "待用清单里被本章用掉的梗"}],
  "storyTime": {"date": "本章故事内日期（尽量具体，如 2007-02-21 或 正月初五）", "events": "关键时间事件"},
  "knowledgeUpdates": [{"fact": "关键事实", "character": "角色名", "state": "知道/不知道/误以为"}],
  "beatsHit": ["踩到的计划情节点（用清单原文）"],
  "beatsMissed": ["计划了但本章没踩到的情节点"],
  "newNPCs": [{"name": "新NPC姓名", "identity": "身份", "relation": "与主角关系", "keyInfo": "关键信息"}],
  "appearingCharacters": ["本章出场的所有具名角色"]
}`;

export async function runTrack(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  chapter: TFile
): Promise<{ result: TrackResult; ctx: TrackContext }> {
  const ctx = await gatherContext(plugin, project, chapter);

  const user = `# 项目档案（bible，最高基准）
${ctx.bible.slice(0, 5000)}

# 世界观硬设定
${ctx.worldbookHard.slice(0, 5000)}

# 未回收的扣子
${ctx.foreshadowOpen || "（无）"}

# 故事内时间线（含计划）
${ctx.timeline}

# 待用的情节梗
${ctx.plotIdeasPending || "（无）"}

# 本章计划踩点
${ctx.beatsPlanned || "（无）"}

# 角色现状
${ctx.characterCards.slice(0, 6000)}

# 本章正文（${ctx.label}）
${ctx.chapterText}`;

  const provider = createProvider(plugin.settings.llm);
  const reply = await provider.complete({
    system: TRACK_SYSTEM,
    messages: [{ role: "user", content: user }],
    jsonMode: true,
  });
  const raw = extractJson(reply) as Record<string, unknown>;
  return { result: sanitizeTrackResult(raw), ctx };
}

/** 把值安全转成字符串：null/undefined → ""，其他非字符串 String() 化 */
function s(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/**
 * 清洗模型返回的 JSON：模型经常在未知字段上返回 null，
 * 直接使用会在写表格时抛 "Cannot read properties of null"。
 * 全部字段强制转字符串，缺关键字段的条目丢弃。
 */
export function sanitizeTrackResult(raw: Record<string, unknown>): TrackResult {
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(s).filter(Boolean) : [];

  const st = raw.storyTime as Record<string, unknown> | null | undefined;
  const storyTime =
    st && typeof st === "object" && (s(st.date) || s(st.events))
      ? { date: s(st.date), events: s(st.events) }
      : null;

  return {
    summary: s(raw.summary),
    newIntel: arr(raw.newIntel)
      .map((i) => ({ owner: s(i.owner), content: s(i.content), inference: s(i.inference) }))
      .filter((i) => i.content),
    newSettings: arr(raw.newSettings)
      .map((i) => ({ category: s(i.category) || "其他", content: s(i.content) }))
      .filter((i) => i.content),
    characterUpdates: arr(raw.characterUpdates)
      .map((i) => ({ name: s(i.name), update: s(i.update) }))
      .filter((i) => i.name && i.update),
    newTraces: arr(raw.newTraces)
      .map((i) => ({
        character: s(i.character),
        trace: s(i.trace),
        type: s(i.type) || "未知",
        source: s(i.source),
        permanent: s(i.permanent) || "未知",
      }))
      .filter((i) => i.character && i.trace),
    newForeshadow: arr(raw.newForeshadow)
      .map((i) => ({ description: s(i.description), note: s(i.note) }))
      .filter((i) => i.description),
    resolvedForeshadow: arr(raw.resolvedForeshadow)
      .map((i) => ({ description: s(i.description) }))
      .filter((i) => i.description),
    usedPlotIdeas: arr(raw.usedPlotIdeas)
      .map((i) => ({ idea: s(i.idea) }))
      .filter((i) => i.idea),
    storyTime,
    knowledgeUpdates: arr(raw.knowledgeUpdates)
      .map((i) => ({ fact: s(i.fact), character: s(i.character), state: s(i.state) }))
      .filter((i) => i.fact && i.character && i.state),
    beatsHit: strArr(raw.beatsHit),
    beatsMissed: strArr(raw.beatsMissed),
    newNPCs: arr(raw.newNPCs)
      .map((i) => ({
        name: s(i.name),
        identity: s(i.identity),
        relation: s(i.relation),
        keyInfo: s(i.keyInfo),
      }))
      .filter((i) => i.name),
    appearingCharacters: strArr(raw.appearingCharacters),
  };
}

/* ------------------------------------------------------------------ */
/* 应用：把用户审阅通过的条目写进各文档                                    */
/* ------------------------------------------------------------------ */

export interface ApplySelection {
  summary: boolean;
  newIntel: boolean[];
  newSettings: boolean[];
  characterUpdates: boolean[];
  newTraces: boolean[];
  newForeshadow: boolean[];
  resolvedForeshadow: boolean[];
  usedPlotIdeas: boolean[];
  storyTime: boolean;
  knowledgeUpdates: boolean[];
  beats: boolean;
  newNPCs: boolean[];
  appearances: boolean;
}

function pick<T>(items: T[], mask: boolean[]): T[] {
  return items.filter((_, i) => mask[i]);
}

export async function applyTrackResult(
  plugin: NovelTrackerPlugin,
  project: ProjectConfig,
  chapter: TFile,
  result: TrackResult,
  sel: ApplySelection
): Promise<string[]> {
  const app = plugin.app;
  const label = chapterLabel(chapter);
  const log: string[] = [];
  const getFile = (path: string) => app.vault.getFileByPath(path);
  const tracker = (key: Parameters<typeof getTrackerFile>[2]) =>
    getTrackerFile(app, project, key);

  // 1. 梗概 -> 标题页
  if (sel.summary && result.summary) {
    const titlePage = tracker("titlePage");
    if (titlePage) {
      await modifyFile(app, titlePage, (c) => {
        const link = `[[${chapter.basename}]]`;
        const line = `${link} ${result.summary}`;
        const lines = c.split("\n");
        const idx = lines.findIndex((l) => l.includes(link));
        if (idx !== -1) lines[idx] = line;
        else lines.push(line);
        return lines.join("\n");
      });
      log.push("梗概已更新到标题页");
    }
  }

  // 2. 新情报 -> 项目里名字含「情报追踪」的文档（如没有则并入知情差）
  const intel = pick(result.newIntel, sel.newIntel);
  if (intel.length > 0) {
    const settingsFolder = app.vault.getFolderByPath(
      projectPath(project, project.settingsDir)
    );
    const intelFile = settingsFolder?.children.find(
      (f): f is TFile => f instanceof TFile && f.name.includes("情报追踪")
    );
    if (intelFile) {
      await modifyFile(app, intelFile, (c) => {
        const blocks = intel.map(
          (i) =>
            `\n### 情报｜${i.content.slice(0, 20)}\n**来源章节**：${label}\n**持有人**：${i.owner}\n**内容**：${i.content}\n**推断**：${i.inference ?? ""}\n`
        );
        return c.trimEnd() + "\n" + blocks.join("");
      });
      log.push(`${intel.length} 条新情报已写入情报追踪`);
    }
  }

  // 3. 新设定 -> 世界观手册「待归档新设定」小节
  const settings = pick(result.newSettings, sel.newSettings);
  if (settings.length > 0) {
    const wb = getFile(projectPath(project, project.settingsDir, "世界观手册.md"));
    if (wb) {
      await modifyFile(app, wb, (c) => {
        const bullets = settings
          .map((s) => `- 【${s.category}】${s.content}（${label}）`)
          .join("\n");
        if (c.includes("## 待归档新设定")) {
          return c.replace(/## 待归档新设定\n/, `## 待归档新设定\n${bullets}\n`);
        }
        return c.trimEnd() + `\n\n## 待归档新设定\n${bullets}\n`;
      });
      log.push(`${settings.length} 条新设定进入待归档区`);
    }
  }

  // 4. 新 NPC -> 世界观手册 NPC 表
  const npcs = pick(result.newNPCs, sel.newNPCs);
  if (npcs.length > 0) {
    const wb = getFile(projectPath(project, project.settingsDir, "世界观手册.md"));
    if (wb) {
      await modifyFile(app, wb, (c) => {
        const table = findTableByFirstHeader(c, "姓名");
        if (!table) return c;
        return appendRows(
          c,
          table,
          npcs.map((n) => [n.name, n.identity, n.relation, label, n.keyInfo, ""])
        );
      });
      log.push(`${npcs.length} 个新 NPC 已登记`);
    }
  }

  // 5. 角色状态快照 + 痕迹
  const updates = pick(result.characterUpdates, sel.characterUpdates);
  const traces = pick(result.newTraces, sel.newTraces);
  const charFiles = listCharacters(app, project);
  const findCard = (name: string) =>
    charFiles.find((f) => f.basename.includes(name) || name.includes(f.basename.replace(/【.*】/, "")));

  for (const u of updates) {
    const card = findCard(u.name);
    if (!card) continue;
    await modifyFile(app, card, (c) => {
      const heading = `### ${label}`;
      if (c.includes("## 状态快照")) {
        if (c.includes(heading)) {
          return c.replace(heading, `${heading}\n- ${u.update}`);
        }
        return c.trimEnd() + `\n\n${heading}\n- ${u.update}\n`;
      }
      return c.trimEnd() + `\n\n## 状态快照\n\n${heading}\n- ${u.update}\n`;
    });
  }
  if (updates.length) log.push(`${updates.length} 条角色状态已写入快照`);

  for (const t of traces) {
    const card = findCard(t.character);
    if (!card) continue;
    await modifyFile(app, card, (c) => {
      const table = findTableByFirstHeader(c, "痕迹");
      if (!table) return c;
      return appendRows(c, table, [[t.trace, t.type, t.source || label, t.permanent, ""]]);
    });
  }
  if (traces.length) log.push(`${traces.length} 条新痕迹已入表`);

  // 6. 伏笔
  const newFs = pick(result.newForeshadow, sel.newForeshadow);
  const resolvedFs = pick(result.resolvedForeshadow, sel.resolvedForeshadow);
  const fsFile = tracker("foreshadow");
  if (fsFile && (newFs.length || resolvedFs.length)) {
    await modifyFile(app, fsFile, (c) => {
      let updated = c;
      if (newFs.length) {
        updated = addForeshadow(
          updated,
          newFs.map((f) => ({ description: f.description, chapter: label, note: f.note }))
        );
      }
      for (const r of resolvedFs) {
        updated = resolveForeshadow(updated, r.description, label) ?? updated;
      }
      return updated;
    });
    if (newFs.length) log.push(`${newFs.length} 个新扣子已登记`);
    if (resolvedFs.length) log.push(`${resolvedFs.length} 个扣子标记回收`);
  }

  // 7. 情节梗
  const used = pick(result.usedPlotIdeas, sel.usedPlotIdeas);
  if (used.length) {
    const piFile = tracker("plotIdeas");
    if (piFile) {
      await modifyFile(app, piFile, (c) => {
        let updated = c;
        for (const u of used) {
          updated = markPlotIdeaUsed(updated, u.idea, label) ?? updated;
        }
        return updated;
      });
      log.push(`${used.length} 个梗标记已用`);
    }
  }

  // 8. 时间线
  if (sel.storyTime && result.storyTime) {
    const tlFile = tracker("timeline");
    if (tlFile) {
      let deviation: string | null = null;
      await modifyFile(app, tlFile, (c) => {
        const r = upsertTimeline(c, {
          chapter: label,
          date: result.storyTime!.date,
          events: result.storyTime!.events,
        });
        deviation = r.planDeviation;
        return r.content;
      });
      log.push(deviation ? `时间线已更新（偏差：${deviation}）` : "时间线已更新");
    }
  }

  // 9. 知情差
  const kn = pick(result.knowledgeUpdates, sel.knowledgeUpdates);
  if (kn.length) {
    const knFile = tracker("knowledge");
    if (knFile) {
      await modifyFile(app, knFile, (c) => {
        let updated = c;
        for (const k of kn) {
          updated = upsertKnowledge(updated, k.fact, k.character, k.state, label);
        }
        return updated;
      });
      log.push(`${kn.length} 条知情差已更新`);
    }
  }

  // 10. 踩点核对
  if (sel.beats && (result.beatsHit.length || result.beatsMissed.length)) {
    const bFile = tracker("beats");
    if (bFile) {
      await modifyFile(app, bFile, (c) => {
        const section = parseBeats(c, label).table ? label : "下一章";
        const nextLabel = nextChapterLabel(label);
        let updated = updateBeats(c, section, result.beatsHit, result.beatsMissed, nextLabel);
        if (section === "下一章") {
          updated = updated.replace(/^##\s*下一章\s*$/m, `## ${label}`);
        }
        return updated;
      });
      log.push(`踩点核对：${result.beatsHit.length} 踩到 / ${result.beatsMissed.length} 滚入下章`);
    }
  }

  // 11. 出场记录
  if (sel.appearances && result.appearingCharacters.length) {
    const aFile = tracker("appearances");
    if (aFile) {
      await modifyFile(app, aFile, (c) =>
        upsertAppearance(c, label, result.appearingCharacters)
      );
      log.push("出场记录已更新");
    }
  }

  return log;
}

function nextChapterLabel(label: string): string {
  const m = label.match(/第(\d+)章/);
  if (m) return `第${parseInt(m[1], 10) + 1}章`;
  return "下一章";
}
