/**
 * Notebook storage: paths, JSON truth, markdown projection, managed-block sync.
 *
 * @module dsh-notebook/notebook
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const BEGIN = "<!-- dsh-notebook:begin -->";
export const END = "<!-- dsh-notebook:end -->";

/**
 * Keep entry text from closing the block it lives in.
 *
 * An entry that quotes the sentinel pair is legitimate content ("managed blocks
 * need BEGIN/END around them"), but writing it into a projection verbatim gives
 * `applyBlock` a second END to stop at, and every later sync leaves the rest of
 * the block behind as growing debris. The entity form reads the same and never
 * matches the sentinel.
 */
function defuse(text) {
  return String(text ?? "")
    .split(BEGIN)
    .join("&lt;!-- dsh-notebook:begin --&gt;")
    .split(END)
    .join("&lt;!-- dsh-notebook:end --&gt;");
}

const EMPTY_UNIVERSAL = { version: 1, kind: "universal", entries: [] };
const EMPTY_PROJECT = { version: 1, kind: "project", project: "", entries: [] };

/** Longest field the projection will print before truncating. */
const LIMITS = { title: 200, name: 120, text: 4000, field: 1000 };

/** Collapse a value to one line: a newline would break the list item it lives in. */
function oneLine(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

/** Cut a field to the length the projection is willing to spend. */
function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…（超出 ${text.length - max} 字，已截断）` : text;
}

/** A markdown table cell: an unescaped pipe splits the row into extra columns. */
function cell(value) {
  return oneLine(clip(value, LIMITS.title)).replace(/\|/g, "\\|");
}

/** A bolded inline title: an inner `**` would close the emphasis early. */
function bold(value) {
  return oneLine(clip(value, LIMITS.title)).replace(/\*/g, "\\*");
}

/**
 * Coerce a stored notebook into the shape the renderers assume.
 *
 * The truth files are plain JSON under the user's project root, so they can
 * arrive as anything: an object where an array belongs, a string where an entry
 * belongs, a field renamed by hand. Every one of those used to take the whole
 * page down (a non-array blew up `backfillDays`) or, worse, get spread back over
 * the file on the next save. Entries that are not objects are dropped here and
 * counted, so the reader can say how many it could not use instead of failing.
 */
function normalizeNotebook(raw, fallback) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(source.entries) ? source.entries : [];
  const kept = [];
  let dropped = 0;
  for (const item of list) {
    if (item && typeof item === "object" && !Array.isArray(item)) kept.push(item);
    else dropped += 1;
  }
  const next = { ...fallback, ...source, entries: kept };
  if (!Array.isArray(source.entries) && source.entries !== undefined) dropped = -1;
  return { value: next, dropped };
}

/** Everything that counts as an entry's content, ignoring when it was stamped. */
function entrySignature(entry) {
  const { updatedAt, ...rest } = entry ?? {};
  return JSON.stringify(rest);
}

/**
 * Stamp entries with the moment they last changed.
 *
 * An entry whose content is unchanged keeps its old stamp, so re-saving an
 * untouched card does not pretend the lesson was re-learned today. Anything new
 * or edited gets `now`.
 *
 * Entries written before ids existed — and new cards the page has not assigned
 * one to yet — are matched by a hash of their content instead. Without that,
 * every save would re-stamp the whole notebook and the timestamp would carry no
 * information at all.
 */
export function stampEntries(previous = [], incoming = [], now = Date.now()) {
  const keyOf = (entry) => entry?.id || `sig:${entrySignature(entry)}`;
  const before = new Map();
  for (const entry of previous ?? []) {
    before.set(keyOf(entry), entry);
  }
  return (incoming ?? []).map((entry) => {
    const old = before.get(keyOf(entry));
    const unchanged = old && entrySignature(old) === entrySignature(entry);
    const stamp = unchanged && typeof old.updatedAt === "number" ? old.updatedAt : now;
    return { ...entry, updatedAt: stamp };
  });
}

/** Local `YYYY-MM-DD HH:mm`, or empty when a stamp is missing. */
export function formatWhen(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Fill in a day for entries written before stamps existed.
 *
 * The file's own mtime is the honest answer — it is when that notebook last
 * changed — and it stays in memory, so reading never rewrites the truth file.
 */
async function backfillDays(value, path) {
  const entries = value?.entries ?? [];
  if (!Array.isArray(entries) || !entries.some((entry) => !entry?.updatedAt)) return value;
  let fallback = 0;
  try {
    fallback = (await stat(path)).mtimeMs;
  } catch {
    return value;
  }
  return {
    ...value,
    entries: entries.map((entry) =>
      entry?.updatedAt ? entry : { ...entry, updatedAt: fallback },
    ),
  };
}

/** Resolve the dsh home directory. */
export function dshHome(override) {
  if (override) return resolve(override);
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
  return join(homedir(), ".dsh");
}

/** Root directory holding cross-project state. */
export function notebookRoot(home) {
  return join(home, "notebook");
}

/** Truth file for the universal notebook, shared by every project. */
export function universalJson(home) {
  return join(notebookRoot(home), "universal.json");
}

/** Per-project directory for its truth file and enable flag. */
export function projectDir(projectRoot) {
  return join(projectRoot, ".dsh-notebook");
}

/** Truth file for one project's notebook. */
export function projectJson(projectRoot) {
  return join(projectDir(projectRoot), "notebook.json");
}

/** Enable flag for one project. */
export function projectState(projectRoot) {
  return join(projectDir(projectRoot), "state.json");
}

/** Projection of the universal notebook, inside the project. */
export const UNIVERSAL_MD = "dsh-notebook.md";

/** Projection of the project's own notebook. */
export const PROJECT_MD = "dsh-notebook-project.md";

/**
 * Names this plugin used before 0.6. Pieces of those may still sit in a project
 * root; they are stripped on the next sync so the block never appears twice.
 *
 * `agent.md` and `project_agent.md` are generic enough that other tools claim
 * them, which is exactly why the current names carry the plugin name.
 */
export const LEGACY_MD = ["agent.md", "project_agent.md"];

/** Projection of the universal notebook, inside the project. */
export function universalMd(projectRoot) {
  return join(projectRoot, UNIVERSAL_MD);
}

/** Projection of the project's own notebook. */
export function projectMd(projectRoot) {
  return join(projectRoot, PROJECT_MD);
}

/** Read JSON with a fallback instead of throwing on absence or corruption. */
export async function readJson(path, fallback) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Move the unreadable file aside instead of silently pretending it was
    // empty: the next save would otherwise overwrite whatever the user had.
    try {
      await rename(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      /* if the rename fails the original stays put, which is still better */
    }
    return structuredClone(fallback);
  }
}

/**
 * Write JSON atomically: a full temp file first, then a rename over the target.
 *
 * A notebook is long-lived data; a half-written file (killed process, full disk)
 * would parse as corrupt and cost the whole notebook.
 */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, body, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Atomically write JSON with synchronous calls.
 *
 * The asynchronous `writeJson` cannot serve callers that already sit inside a
 * synchronous host hook, but those same callers hold state that must not be
 * truncated by a crash: a half-written config costs the cleanup list and the
 * reminder bookkeeping. Same temp-then-rename dance, no await.
 */
export function writeJsonSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, body, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the tmp file is already gone */
    }
    throw error;
  }
}

/** Read the universal notebook. */
export async function readUniversal(home) {
  const path = universalJson(home);
  const { value, dropped } = normalizeNotebook(await readJson(path, EMPTY_UNIVERSAL), EMPTY_UNIVERSAL);
  const filled = await backfillDays(value, path);
  return { ...filled, droppedEntries: dropped };
}

/** Write the universal notebook. */
export async function writeUniversal(home, value) {
  const path = universalJson(home);
  const previous = normalizeNotebook(await readJson(path, EMPTY_UNIVERSAL), EMPTY_UNIVERSAL).value;
  const entries = Array.isArray(value.entries) ? value.entries : previous.entries;
  const next = {
    ...EMPTY_UNIVERSAL,
    ...value,
    version: 1,
    kind: "universal",
    entries: stampEntries(previous.entries, entries),
  };
  await writeJson(path, next);
  return next;
}

/** Read one project's notebook. */
export async function readProject(projectRoot) {
  const path = projectJson(projectRoot);
  const { value, dropped } = normalizeNotebook(await readJson(path, EMPTY_PROJECT), EMPTY_PROJECT);
  const filled = await backfillDays(value, path);
  return { ...filled, droppedEntries: dropped };
}

/** Write one project's notebook. */
export async function writeProject(projectRoot, value) {
  const path = projectJson(projectRoot);
  const previous = normalizeNotebook(await readJson(path, EMPTY_PROJECT), EMPTY_PROJECT).value;
  const entries = Array.isArray(value.entries) ? value.entries : previous.entries;
  const next = {
    ...EMPTY_PROJECT,
    ...value,
    version: 1,
    kind: "project",
    entries: stampEntries(previous.entries, entries),
  };
  await writeJson(path, next);
  return next;
}

/** Read one project's enable flag, plus its update cadence and activation time. */
export async function readEnabled(projectRoot) {
  const state = await readJson(projectState(projectRoot), { enabled: false });
  return state.enabled === true;
}

/** Read the full project state, with defaults for anything absent. */
export async function readState(projectRoot) {
  const state = await readJson(projectState(projectRoot), {});
  return {
    enabled: state.enabled === true,
    activatedAt: Number(state.activatedAt) || 0,
    updateEvery: Number(state.updateEvery) || 3,
  };
}

/** Write one project's enable flag, stamping the activation time on enable. */
export async function writeEnabled(projectRoot, enabled) {
  const state = await readState(projectRoot);
  const next = {
    ...state,
    enabled: Boolean(enabled),
    activatedAt: enabled ? state.activatedAt || Date.now() : state.activatedAt,
  };
  await writeJson(projectState(projectRoot), next);
  return next;
}

/** Update the cadence (turns between notebook updates) of one project. */
export async function writeCadence(projectRoot, updateEvery) {
  const state = await readState(projectRoot);
  const next = { ...state, updateEvery: Math.max(1, Number(updateEvery) || 3) };
  await writeJson(projectState(projectRoot), next);
  return next;
}

const UNIVERSAL_HEAD = `# 通用经验本

> 由 dsh-notebook 生成。跨项目成立的失败模式在这里；本项目特有的约束见 \`dsh-notebook-project.md\`。
> 措辞是「我见过这个坑」，不是「你必须」。

## 五个处境

一切经验都来自执行者的处境。归不上去的不是经验，是偏好。

1. 上下文有限，只能看见局部
2. 无法自我验证，只能判断「看起来对不对」
3. 目标容易被表述成「让检查通过」而不是「让行为正确」
4. 生成而非检索，所以会流畅地编造
5. 只响应眼前的信号，不响应远处的约束

## 索引
`;

const UNIVERSAL_TAIL = `
## 怎么用

- 开工前扫索引；命中某条再按需读全文，不要整份读进来
- 收工前踩了新坑：先过五道筛（去名词 / 换栈 / 换人 / 归因 / 非常识），过了才加
- 取舍不按条数，按这一问：如果它不在，我会犯这个错吗？答不出就删
`;

const PROJECT_NOTE = `> 由 dsh-notebook 生成。**只写这个项目的真相**：不变量、判定手段、高危区、本地约定。
> 不写教训——教训属于 \`dsh-notebook.md\`。`;

const PROJECT_FOOT = `
---

> 本文件是投影，直接编辑会在下次同步时被覆盖。
> 改条目请编辑 \`.dsh-notebook/notebook.json\`，或打开管理界面。`;

const PROJECT_SECTIONS = {
  layout: "项目结构（模型划分的区块）",
  invariant: "不变量（改了就错）",
  check: "怎么判断「对」",
  risk: "高危区",
  local: "本地约定（出了本项目不成立）",
};

const STATUS_MARK = { candidate: "候选", established: "确立", retired: "退役" };

/**
 * Keep only the newest entry for each title inside a group.
 *
 * Padding by repetition is the cheapest way for someone to look productive, so
 * the renderer refuses to spend context on the older copies.
 */
function dedupeGroup(group) {
  const newest = new Map();
  for (const entry of group) {
    const key = String(entry.title ?? "").trim();
    // Two blank cards are two cards the user is still filling in, not a
    // duplicate to collapse — collapsing them silently eats one on save.
    if (!key) continue;
    const previous = newest.get(key);
    if (!previous || (Number(entry.updatedAt) || 0) > (Number(previous.updatedAt) || 0)) {
      newest.set(key, entry);
    }
  }
  return group.filter((entry) => {
    const key = String(entry.title ?? "").trim();
    return !key || newest.get(key) === entry;
  });
}

/** An entry that carries a title but no conclusion. */
function isBlank(entry) {
  return !String(entry.text ?? "").trim();
}

/** Render one universal entry as markdown. */
function renderUniversalEntry(entry) {
  const field = (value) => defuse(clip(value, LIMITS.field));
  const lines = [`### ${entry.id} · ${bold(entry.title)}`, ""];
  if (entry.symptom) lines.push(`- **症状**：${field(entry.symptom)}`);
  if (entry.root) lines.push(`- **根因**：${field(entry.root)}`);
  if (entry.identify) lines.push(`- **识别**：${field(entry.identify)}`);
  if (entry.defend) lines.push(`- **防御**：${field(entry.defend)}`);
  if (entry.boundary) lines.push(`- **边界**：${field(entry.boundary)}`);
  lines.push(`- **状态**：${STATUS_MARK[entry.status] ?? "候选"}`);
  return lines.join("\n");
}

/** Render the universal notebook body, which goes inside the managed block. */
export function renderUniversal(nb) {
  const entries = nb.entries ?? [];
  const rows = entries.map(
    (e) => `| ${cell(e.id)} | ${cell(e.title)} | ${STATUS_MARK[e.status] ?? "候选"} |`,
  );
  const table = ["| # | 一句话 | 状态 |", "|---|---|---|", ...rows].join("\n");
  // Only established entries carry their full text into context; candidates stay index-only.
  const detail = entries
    .filter((e) => e.status === "established")
    .filter((e) => !isBlank(e) || e.symptom || e.root || e.identify || e.defend)
    .map(renderUniversalEntry)
    .join("\n\n");
  return [UNIVERSAL_HEAD, entries.length ? table : "（暂无条目）", "", detail, UNIVERSAL_TAIL].join("\n");
}

/** Render the project notebook body, which goes inside the managed block. */
export function renderProject(nb) {
  const entries = nb.entries ?? [];
  const label = bold(clip((nb.project ?? "").trim(), LIMITS.name)) || "（未命名）";
  const parts = [`# 项目经验本：${label}\n\n${PROJECT_NOTE}`];
  const known = new Set(Object.keys(PROJECT_SECTIONS));
  const areaOf = (entry) => {
    const area = String(entry.area ?? "invariant").trim().toLowerCase();
    return known.has(area) ? area : "local";
  };
  for (const [area, heading] of Object.entries(PROJECT_SECTIONS)) {
    const group = dedupeGroup(entries.filter((e) => areaOf(e) === area));
    if (!group.length) continue;
    parts.push(`\n## ${heading}\n`);
    for (const entry of group) {
      const when = formatWhen(entry.updatedAt);
      const body = isBlank(entry)
        ? "*（只有标题，没有结论 —— 补上或删掉）*"
        : defuse(clip(entry.text, LIMITS.text));
      // An entry whose stored area is not one of the five still has to appear:
      // silently dropping it is how a typo in the JSON eats a lesson. A missing
      // area is not a typo, so it earns no annotation.
      const rawArea = oneLine(entry.area);
      const stray = rawArea && rawArea.toLowerCase() !== areaOf(entry) ? `（原分区：${rawArea}）` : "";
      parts.push(`- （${when || "时间未知"}）**${bold(entry.title)}**${stray}：${body}`);
    }
  }
  if (!entries.length) parts.push("\n（暂无条目）\n");
  parts.push(PROJECT_FOOT);
  return parts.join("\n");
}

/**
 * Remove sentinel markers that cannot be paired.
 *
 * A file where someone deleted the opener (or pasted an extra marker while
 * quoting it) left `applyBlock` cutting from the first BEGIN to the first END
 * across unrelated text, or appending a block that produced two closers. Both
 * are recoverable: an unpaired closer is debris, an unpaired opener likewise.
 */
function healBlock(text) {
  let out = text;
  for (let guard = 0; guard < 20; guard += 1) {
    const begin = out.indexOf(BEGIN);
    const end = out.indexOf(END);
    if (end !== -1 && (begin === -1 || begin > end)) {
      out = out.slice(0, end) + out.slice(end + END.length);
      continue;
    }
    if (begin !== -1 && out.indexOf(END, begin + BEGIN.length) === -1) {
      out = out.slice(0, begin) + out.slice(begin + BEGIN.length);
      continue;
    }
    break;
  }
  return out;
}

/** Replace the managed block inside `text`, or append it. `null` means unchanged. */
function applyBlock(text, body) {
  const healed = healBlock(text);
  // Defence in depth: renderers already defuse entry text, but a body carrying a
  // stray closer would make the NEXT sync stop inside the block.
  const block = `${BEGIN}\n${defuse(body).trim()}\n${END}`;
  const begin = healed.indexOf(BEGIN);
  const end = healed.indexOf(END);
  let next;
  if (begin !== -1 && end > begin) {
    next = healed.slice(0, begin) + block + healed.slice(end + END.length);
  } else {
    const base = healed.replace(/\s+$/, "");
    next = base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  // A second copied block is debris from an earlier paste; the first one wins.
  for (let guard = 0; guard < 20; guard += 1) {
    const stray = next.indexOf(BEGIN, next.indexOf(END) + END.length);
    if (stray === -1) break;
    const strayEnd = next.indexOf(END, stray);
    if (strayEnd === -1) {
      next = next.slice(0, stray).replace(/\s+$/, "");
      break;
    }
    next = next.slice(0, stray) + next.slice(strayEnd + END.length);
  }
  return next === healed ? null : next;
}

/** Drop the managed block, keeping every byte outside it. `null` means unchanged. */
function stripBlock(text) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end <= begin) return null;
  const tail = text.slice(end + END.length).replace(/^\s*\n/, "");
  const head = text.slice(0, begin).replace(/\s+$/, "");
  const next = head ? `${head}\n${tail ? `\n${tail}` : ""}` : tail;
  return next === text ? null : next;
}

/**
 * Sync one projection file to `body`; `body === null` removes the managed block.
 * @returns {Promise<"created"|"updated"|"removed"|"unchanged"|"deleted">}
 */
export async function syncProjection(path, body) {
  const exists = existsSync(path);
  const current = exists ? await readFile(path, "utf8") : "";
  const hasBlock = current.includes(BEGIN);

  if (body === null) {
    if (!exists) return "unchanged";
    if (!hasBlock) return "unchanged";
    const stripped = stripBlock(current);
    if (stripped === null) return "unchanged";
    if (stripped.trim() === "") {
      await rm(path, { force: true });
      return "deleted";
    }
    await writeFile(path, stripped, "utf8");
    return "removed";
  }

  const next = applyBlock(current, body);
  if (next === null) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return exists ? "updated" : "created";
}

/**
 * Strip every projection this plugin may have planted in one project, current
 * names and legacy ones alike. The notebooks themselves stay untouched.
 */
export async function clearProjections(projectRoot) {
  const touched = [];
  for (const path of [
    universalMd(projectRoot),
    projectMd(projectRoot),
    ...LEGACY_MD.map((name) => join(projectRoot, name)),
  ]) {
    const outcome = await syncProjection(path, null);
    if (outcome !== "unchanged") touched.push(outcome);
  }
  return touched;
}

/**
 * Strip this plugin's block out of a file it no longer owns.
 *
 * Older versions wrote `agent.md` / `project_agent.md`. Those names are generic
 * enough that the file may carry someone else's content, so only the managed
 * block goes — the file itself is removed only when nothing but the block was
 * ever in it.
 */
export async function stripLegacy(projectRoot) {
  const results = [];
  for (const name of LEGACY_MD) {
    const path = join(projectRoot, name);
    const outcome = await syncProjection(path, null);
    if (outcome !== "unchanged") results.push(`${name}:${outcome}`);
  }
  return results;
}

/**
 * Re-project both notebooks of one project. Disabled projects drop both blocks.
 * @returns {Promise<{enabled:boolean, universal:string, project:string}>}
 */
export async function syncProject(projectRoot, home) {
  // A remembered project whose folder is gone must not be recreated: creating it
  // would leave an empty ghost directory that then looks like a real project.
  if (!existsSync(projectRoot)) {
    return { enabled: false, universal: "unchanged", project: "unchanged", missing: true };
  }
  // Legacy names are cleared first: leaving them would show the same content
  // twice, once under a name nothing reads any more.
  await stripLegacy(projectRoot);
  const enabled = await readEnabled(projectRoot);
  if (!enabled) {
    return {
      enabled: false,
      universal: await syncProjection(universalMd(projectRoot), null),
      project: await syncProjection(projectMd(projectRoot), null),
    };
  }
  const universal = await readUniversal(home);
  const project = await readProject(projectRoot);
  return {
    enabled: true,
    universal: await syncProjection(universalMd(projectRoot), renderUniversal(universal)),
    project: await syncProjection(projectMd(projectRoot), renderProject(project)),
  };
}
