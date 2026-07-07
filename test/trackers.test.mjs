// 追踪文件解析层测试：node test/trackers.test.mjs
// 测试数据为虚构示例故事（侦探林澈 / 厨子老康 / 姐姐林虹），与任何真实作品无关。
// 先 esbuild 编译 trackers.ts 为临时模块再导入
import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";
import assert from "assert";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, ".trackers.compiled.mjs");
await build({
  entryPoints: [path.join(dir, "../src/trackers.ts")],
  bundle: true,
  format: "esm",
  outfile: out,
  external: ["obsidian"],
});
const T = await import(out + "?t=" + Date.now());

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

/* --- 伏笔登记簿：模板 + 人工编辑行混合 --- */
const foreshadow = `# 伏笔登记簿

| 扣子描述 | 埋设章节 | 状态 | 回收章节 | 备注 |
|---|---|---|---|---|
| 旧货商放话不再收店里的货 | 第33章 | 未回收 |  |  |
| 手动加的一条，格式还少一列 | 第30章 | 未回收 |
`;

test("解析伏笔（含人工的缺列行）", () => {
  const { entries } = T.parseForeshadow(foreshadow);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].description, "手动加的一条，格式还少一列");
});

test("追加新扣子不动人工行", () => {
  const updated = T.addForeshadow(foreshadow, [
    { description: "码头仓库的秘密", chapter: "第34章" },
  ]);
  assert.ok(updated.includes("| 码头仓库的秘密 | 第34章 | 未回收 |  |  |"));
  assert.ok(updated.includes("手动加的一条"));
});

test("回收扣子（模糊匹配）", () => {
  const updated = T.resolveForeshadow(foreshadow, "旧货商放话", "第35章");
  assert.ok(updated.includes("已回收"));
  assert.ok(updated.includes("第35章"));
});

/* --- 时间线：计划行翻转 --- */
const timeline = `# 故事内时间线

| 章节 | 故事内日期 | 经过天数 | 关键时间事件 | 状态 |
|---|---|---|---|---|
| 第33章 | 2007-02-20 | 1 | 店里盘点 | 已写 |
| 第34章 | 2007-02-21 | 1 | 夜探码头仓库（计划） | 计划 |
| 第35章 | 2007-02-23 | 2 | 故人来访 | 计划 |
`;

test("计划行翻转为已写", () => {
  const { content, planDeviation } = T.upsertTimeline(timeline, {
    chapter: "第34章",
    date: "2007-02-21",
    events: "夜探码头仓库",
  });
  const { entries } = T.parseTimeline(content);
  assert.equal(entries.find((e) => e.chapter === "第34章").status, "已写");
  assert.equal(planDeviation, null);
  // 其他计划行不动
  assert.equal(entries.find((e) => e.chapter === "第35章").status, "计划");
});

test("实写日期偏离计划时报偏差", () => {
  const { content, planDeviation } = T.upsertTimeline(timeline, {
    chapter: "第34章",
    date: "2007-02-22",
    events: "夜探码头仓库",
  });
  assert.ok(planDeviation.includes("2007-02-21"));
  assert.ok(planDeviation.includes("2007-02-22"));
  const { entries } = T.parseTimeline(content);
  assert.equal(entries.find((e) => e.chapter === "第34章").date, "2007-02-22");
});

test("表格写入容忍 null 字段（回归：模型 JSON 里的 null 导致整章写入失败）", () => {
  const { content } = T.upsertTimeline(timeline, {
    chapter: "第37章",
    date: null,
    events: null,
  });
  assert.ok(content.includes("| 第37章 |  |  |  | 已写 |"));
});

test("新章节直接追加", () => {
  const { content } = T.upsertTimeline(timeline, {
    chapter: "第36章",
    date: "2007-02-25",
    events: "结案",
  });
  assert.ok(content.includes("| 第36章 | 2007-02-25 |  | 结案 | 已写 |"));
});

/* --- 知情差矩阵 --- */
const knowledge = `# 知情差矩阵

## 事实：老康断指的来历

| 角色 | 知情状态 | 得知章节 | 备注 |
|---|---|---|---|
| 老康 | 知道 | 前史 |  |
| 林澈 | 不知道 |  |  |
`;

test("更新已有角色的知情状态", () => {
  const updated = T.upsertKnowledge(knowledge, "老康断指的来历", "林澈", "知道", "第35章");
  assert.ok(/\|\s*林澈\s*\|\s*知道\s*\|\s*第35章/.test(updated));
  assert.ok(/\|\s*老康\s*\|\s*知道\s*\|\s*前史/.test(updated));
});

test("新事实创建新小节", () => {
  const updated = T.upsertKnowledge(knowledge, "码头仓库是走私窝点", "林澈", "知道", "第34章");
  assert.ok(updated.includes("## 事实：码头仓库是走私窝点"));
  assert.ok(updated.includes("| 林澈 | 知道 | 第34章 |"));
});

test("已有事实追加新角色", () => {
  const updated = T.upsertKnowledge(knowledge, "老康断指的来历", "林虹", "不知道", "");
  const lines = updated.split("\n");
  const factIdx = lines.findIndex((l) => l.includes("老康断指的来历"));
  const newRowIdx = lines.findIndex((l) => l.includes("林虹"));
  assert.ok(newRowIdx > factIdx);
});

/* --- 踩点清单 --- */
const beats = `# 踩点清单

## 第34章

| 情节点 | 状态 | 备注 |
|---|---|---|
| 林澈夜探码头仓库 | 待踩 |  |
| 林虹讲当年的事 | 待踩 |  |
| 二道贩子交代背景 | 待踩 |  |
`;

test("踩点核对：命中+漏踩滚入下章", () => {
  const updated = T.updateBeats(
    beats,
    "第34章",
    ["林澈夜探码头仓库", "林虹讲当年的事"],
    ["二道贩子交代背景"],
    "第35章"
  );
  assert.ok(/夜探码头仓库\s*\|\s*已踩/.test(updated));
  assert.ok(/二道贩子交代背景\s*\|\s*滚入下章/.test(updated));
  assert.ok(updated.includes("## 第35章"));
  assert.ok(/## 第35章[\s\S]*二道贩子交代背景\s*\|\s*待踩\s*\|\s*自第34章滚入/.test(updated));
});

/* --- 灵感收集箱 --- */
test("灵感速记与归档", () => {
  let inbox = "# 灵感收集箱\n";
  inbox = T.appendInboxItem(inbox, "厨子接到电话时的沉默");
  inbox = T.appendInboxItem(inbox, "小孩在院子里数石子");
  const items = T.listUnprocessedInbox(inbox);
  assert.equal(items.length, 2);
  const done = T.markInboxProcessed(inbox, [items[0].line]);
  assert.equal(T.listUnprocessedInbox(done).length, 1);
  assert.ok(done.includes("[已处理]"));
});

/* --- 出场记录 --- */
test("出场记录 upsert", () => {
  const app = `# 出场记录

| 章节 | 出场角色 |
|---|---|
| 第33章 | 老康、林虹 |
`;
  let updated = T.upsertAppearance(app, "第34章", ["林澈", "老康"]);
  assert.ok(updated.includes("| 第34章 | 林澈、老康 |"));
  updated = T.upsertAppearance(updated, "第33章", ["老康", "林虹", "邻居"]);
  assert.ok(updated.includes("| 第33章 | 老康、林虹、邻居 |"));
});

console.log(`\n${passed} 项测试${process.exitCode ? "（有失败）" : "全部通过"}`);
