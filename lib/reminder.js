/**
 * Cadence reminder: decide when to nudge the model to update its notebook, and
 * build the message that carries the nudge.
 *
 * @module dsh-notebook/reminder
 */

import { isAbsolute, join, resolve } from "node:path";

/**
 * The session's event list, whatever shape the runtime exposes it in.
 *
 * A live `Session` is not a plain `{ events }` object: it publishes the log as
 * `eventsSnapshot` and a `log` reader, so reading `session.events` alone finds
 * nothing and every caller silently degrades to "no events".
 */
export function sessionEvents(session) {
  if (!session) return [];
  const flatten = (value) => {
    if (!value) return null;
    if (Array.isArray(value)) return value;
    if (typeof value[Symbol.iterator] === "function" && typeof value !== "string") {
      try {
        return [...value];
      } catch {
        return null;
      }
    }
    if (typeof value.entries === "function") {
      try {
        return [...value.entries()];
      } catch {
        /* fall through to a plain key walk */
      }
    }
    return typeof value === "object" ? Object.values(value) : null;
  };
  return flatten(session.events) ?? flatten(session.eventsSnapshot) ?? flatten(session.log) ?? [];
}

/** Count the turns a session has started, from its own event log. */
export function turnOf(session) {
  let turns = 0;
  for (const event of sessionEvents(session)) {
    if (event?.type === "turn/start") turns += 1;
  }
  return turns;
}

/** Whether a reminder is due at `turn`, given the last reminded turn and the cadence. */
export function shouldRemind({ turn, lastTurn, every }) {
  const cadence = Math.max(1, Number(every) || 3);
  if (!turn || turn <= 0) return false;
  if (!lastTurn) return turn >= cadence;
  return turn - lastTurn >= cadence;
}

/** The project directory a cwd belongs to, given the folder that holds projects. */
export function projectFromCwd(cwd, projectsRoot) {
  if (!cwd || !projectsRoot) return "";
  const root = resolve(projectsRoot).replace(/[\\/]+$/, "").toLowerCase();
  const here = String(cwd).replace(/[\\/]+$/, "");
  if (!here.toLowerCase().startsWith(root)) return "";
  const rest = here.slice(root.length).replace(/^[\\/]+/, "");
  if (!rest) return "";
  const first = rest.split(/[\\/]+/)[0];
  return join(resolve(projectsRoot), first);
}

/** One message's text, flattened to forward slashes. */
function messageText(event) {
  const content = event?.data?.content;
  const text = Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
    : String(content ?? "");
  return text.replace(/\\/g, "/");
}

/**
 * A path segment's plausible folder names, most specific last.
 *
 * Prose often runs straight into the path (`...\dsh-notebook请你完善这个项目`),
 * so the raw segment carries the sentence as well. The leading ASCII run is the
 * folder name in that case; the raw segment stays as a fallback for folders whose
 * names really are not ASCII.
 */
function nameVariants(depth) {
  const perSegment = depth.map((segment) => {
    const full = (segment.match(/^[^\s/]+/) ?? [""])[0];
    if (!full) return [];
    const ascii = (full.match(/^[\x20-\x7e]+/) ?? [""])[0].replace(/[.,;:!?)\]}"']+$/, "");
    const out = [];
    if (ascii.length >= 2 && ascii !== full) out.push(ascii);
    out.push(full);
    return out;
  });
  // One variant per segment, in the order the segments appear.
  return perSegment.reduce(
    (acc, names) => acc.flatMap((prefix) => names.map((name) => [...prefix, name])),
    [[]],
  );
}

/**
 * Project paths the session's opening messages name, shallowest first.
 *
 * A projects root usually holds one container folder per kind of work, so the
 * project itself can sit one or two segments below it. Returning both lets the
 * caller pick the one that exists on disk instead of assuming the depth.
 */
export function projectCandidates(session, projectsRoot, limit = 6) {
  if (!session || !projectsRoot) return [];
  const list = sessionEvents(session);
  const base = resolve(projectsRoot);
  const root = base.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const seen = new Set();
  const out = [];
  let read = 0;

  for (const event of list) {
    if (event?.type !== "user/message") continue;
    if (read >= limit) break;
    read += 1;
    const text = messageText(event);
    const hay = text.toLowerCase();
    let at = hay.indexOf(root + "/");
    while (at !== -1) {
      // Recover the original casing from the untouched text, not the lowered copy.
      // A segment ends at whitespace: prose usually follows a path with a space.
      const tail = text.slice(at + root.length + 1);
      const parts = tail
        .split("/")
        .slice(0, 2)
        .map((segment) => (segment.match(/^[^\s/]+/) ?? [""])[0])
        .filter(Boolean);
      for (const depth of [1, 2]) {
        if (parts.length < depth) continue;
        for (const combo of nameVariants(parts.slice(0, depth))) {
          const path = join(base, ...combo);
          if (seen.has(path)) continue;
          seen.add(path);
          out.push(path);
        }
      }
      at = hay.indexOf(root + "/", at + 1);
    }
  }
  return out;
}

/** The deepest project path the session's opening messages name. */
export function projectFromSession(session, projectsRoot, limit = 6) {
  const list = projectCandidates(session, projectsRoot, limit);
  let deepest = "";
  for (const path of list) {
    if (!deepest || path.split(/[\\/]/).length > deepest.split(/[\\/]/).length) deepest = path;
  }
  return deepest;
}

/** The reminder text: what to update, and what to check before writing. */
export function reminderText({ project, turn, every, universalCount = 0, projectCount = 0 } = {}) {
  const lines = [
    "<system-reminder>",
    `经验本到点提醒：本会话第 ${turn} 轮，更新频率为每 ${every} 轮。`,
    `项目：${project}`,
    `现有 ${universalCount} 条通用、${projectCount} 条本项目。`,
    "收工前做一次经验本维护，不要改业务代码。",
    "",
    "【准入四问】四问全过才写，任一问卡住就不写——写不进去不是损失，写进废话才是。",
    "1. 可复现：能说出在哪一步、什么输入下会撞上它。说不出触发条件的是感觉，不是经验。",
    "2. 非显然：不看这条我就会踩。文档里写着、代码注释里写着、任何一次都成立的口头约定，都不算。",
    "3. 有代价：当时确实报了错／白跑一趟／改坏过东西。只是「更优雅」的不收。",
    "4. 可执行：能落成一句「下次遇到 X 就做 Y」。落不成动作的，别写。",
    "",
    "【对照】下面这些是废话，一条都别加：",
    "- 「我改了 lib/index.js」——这是流水账，下次看 git log 就行",
    "- 「当前端口是 49771」「这次先不打 tgz」——一次性状态",
    "- 「可能是缓存问题」——没验证的猜测，会把人带偏",
    "- 「要注意代码质量」——正确但无用，任何项目都成立",
    "- 已经在 AGENTS.md 或代码注释里写着的",
    "",
    "【写法】标题是症状或约束，正文写根因和对策，一句话一条。",
    "含完整结论的标 established；还含糊的标 candidate——candidate 只在索引里出现，不占上下文。",
    "同类重复的先合并成一条，不要并排摆着。",
    "",
    "【落在哪】",
    "- 跨项目的失败模式 → agent.md（通用本）",
    "- 这个项目的真相：不变量／判定手段／高危区／本地约定 → project_agent.md",
    "- 新文件是否落在「项目结构」已声明的区块里？没有就补一条",
    "- 改的是 .dsh-notebook/notebook.json 与 $DSH_HOME/notebook/universal.json，不要直接改投影",
  ];
  if (projectCount >= 40) {
    lines.push(
      "",
      `【先减后加】项目本已经 ${projectCount} 条，这个数量下没人会读完，等于没写。`,
      "本轮不要新增：先挑出三条最该删的（过期／重复／说不清触发条件），删掉腾出位置。",
    );
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

/** Build a plugin-sourced user message carrying one reminder. */
export function createReminder(text, { id } = {}) {
  return {
    id: id ?? `dsh-notebook-reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: [{ type: "text", text }],
    // V4 session format refuses the bare "plugin" kind; a producer-owned kind is
    // `plugin:<package>`, which is exactly what the V3 lift produces.
    source: { kind: "plugin:dsh-notebook", plugin: "dsh-notebook", form: "instructions" },
  };
}

/** Resolve an absolute project path, or "" when the input cannot name one. */
export function asProject(value) {
  if (!value) return "";
  return isAbsolute(value) ? resolve(value) : "";
}
