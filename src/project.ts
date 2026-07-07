import { App, TFile, TFolder } from "obsidian";

/** 项目档案.md frontmatter 里的配置 */
export interface ProjectConfig {
  /** 项目根文件夹路径（vault 相对） */
  root: string;
  /** 正文文件夹（相对项目根），默认 "正文" */
  chaptersDir: string;
  /** 周边设定文件夹（相对项目根），默认 "周边设定" */
  settingsDir: string;
  /** 角色清单文件夹（相对项目根），默认 "角色清单" */
  charactersDir: string;
  /** 标题页路径（相对项目根），默认 settingsDir/标题页.md */
  titlePagePath: string;
  /** 项目档案文件本身 */
  bibleFile: TFile;
}

export const BIBLE_FILENAME = "项目档案.md";

/** 追踪文件名常量（都放在 settingsDir 下） */
export const TRACKER_FILES = {
  foreshadow: "伏笔登记簿.md",
  knowledge: "知情差矩阵.md",
  timeline: "故事内时间线.md",
  plotIdeas: "情节梗回收清单.md",
  inbox: "灵感收集箱.md",
  beats: "踩点清单.md",
  feedback: "读者反馈库.md",
  appearances: "出场记录.md",
  titlePage: "标题页.md",
} as const;

/** 从某个文件向上找所属项目（找到含 项目档案.md 的祖先文件夹） */
export function findProject(app: App, file: TFile): ProjectConfig | null {
  let folder: TFolder | null = file.parent;
  while (folder) {
    const biblePath = folder.isRoot()
      ? BIBLE_FILENAME
      : `${folder.path}/${BIBLE_FILENAME}`;
    const bible = app.vault.getFileByPath(biblePath);
    if (bible) {
      const fm = app.metadataCache.getFileCache(bible)?.frontmatter;
      if (fm && fm["novel-tracker"] === true) {
        const settingsDir = fm["settings-dir"] ?? "周边设定";
        return {
          root: folder.isRoot() ? "" : folder.path,
          chaptersDir: fm["chapters-dir"] ?? "正文",
          settingsDir,
          charactersDir: fm["characters-dir"] ?? "角色清单",
          titlePagePath: fm["title-page"] ?? `${settingsDir}/标题页.md`,
          bibleFile: bible,
        };
      }
    }
    folder = folder.parent;
  }
  return null;
}

/** 拼出项目内路径 */
export function projectPath(project: ProjectConfig, ...parts: string[]): string {
  return [project.root, ...parts].filter(Boolean).join("/");
}

export function trackerPath(
  project: ProjectConfig,
  key: keyof typeof TRACKER_FILES
): string {
  if (key === "titlePage") {
    return projectPath(project, project.titlePagePath);
  }
  return projectPath(project, project.settingsDir, TRACKER_FILES[key]);
}

/**
 * 找追踪文件：先按默认路径找，找不到就在设定文件夹下递归搜同名文件。
 * 这样用户可以把追踪文件自由移进子文件夹（如「写作台账」）。
 */
export function getTrackerFile(
  app: App,
  project: ProjectConfig,
  key: keyof typeof TRACKER_FILES
): TFile | null {
  const direct = app.vault.getFileByPath(trackerPath(project, key));
  if (direct) return direct;
  if (key === "titlePage") return null;
  const dir = app.vault.getFolderByPath(
    projectPath(project, project.settingsDir)
  );
  if (!dir) return null;
  const target = TRACKER_FILES[key];
  const stack: TFolder[] = [dir];
  while (stack.length) {
    const folder = stack.pop()!;
    for (const child of folder.children) {
      if (child instanceof TFolder) stack.push(child);
      else if (child instanceof TFile && child.name === target) return child;
    }
  }
  return null;
}

/** 报告类文件（校对报告/回坑简报/批量报告）的保存目录：优先「写作台账」子文件夹 */
export function reportSaveDir(app: App, project: ProjectConfig): string {
  const ledger = projectPath(project, project.settingsDir, "写作台账");
  return app.vault.getFolderByPath(ledger)
    ? ledger
    : projectPath(project, project.settingsDir);
}

/** 读取项目内某文件的全文，不存在返回 null */
export async function readProjectFile(
  app: App,
  path: string
): Promise<string | null> {
  const f = app.vault.getFileByPath(path);
  if (!f) return null;
  return app.vault.read(f);
}

/** 确保文件存在（不存在则用 initial 内容创建，含父文件夹） */
export async function ensureFile(
  app: App,
  path: string,
  initial: string
): Promise<TFile> {
  const existing = app.vault.getFileByPath(path);
  if (existing) return existing;
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !app.vault.getFolderByPath(dir)) {
    await app.vault.createFolder(dir).catch(() => {});
  }
  return app.vault.create(path, initial);
}

/** 列出正文文件夹里的所有章节文件（按名称排序） */
export function listChapters(app: App, project: ProjectConfig): TFile[] {
  const dir = app.vault.getFolderByPath(
    projectPath(project, project.chaptersDir)
  );
  if (!dir) return [];
  const files: TFile[] = [];
  for (const child of dir.children) {
    if (child instanceof TFile && child.extension === "md") files.push(child);
  }
  return files.sort((a, b) =>
    a.name.localeCompare(b.name, "zh-CN", { numeric: true })
  );
}

/** 列出角色卡文件 */
export function listCharacters(app: App, project: ProjectConfig): TFile[] {
  const dir = app.vault.getFolderByPath(
    projectPath(project, project.charactersDir)
  );
  if (!dir) return [];
  const files: TFile[] = [];
  for (const child of dir.children) {
    if (child instanceof TFile && child.extension === "md") files.push(child);
  }
  return files;
}

/** 提取文档中某标题下的内容块（到下一个同级或更高级标题为止） */
export function extractSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const re = new RegExp(`^(#{1,6})\\s*${escapeRegex(heading)}\\s*$`);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
