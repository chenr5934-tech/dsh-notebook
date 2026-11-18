/**
 * Session history reader: locate, decode and summarize the harness session logs.
 *
 * Session files are append-only zstd frames of JSONL, grouped by the directory the
 * harness was launched from — not by project — so the project filter reads `cwd`
 * from each session header.
 *
 * @module dsh-notebook/sessions
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FILE = "session.v4.jsonl.zstd";

/** Encode one code point the way the harness names workspace folders. */
function encodeChar(ch) {
  if (ch === ":" || ch === "\\" || ch === "/") return ch === ":" ? "" : "-";
  const code = ch.charCodeAt(0);
  return code > 127 ? "~" + code.toString(16).toUpperCase().padStart(4, "0") : ch;
}

/** Workspace folder name for one launch directory. */
export function workspaceDirName(cwd) {
  return "--" + [...cwd].map(encodeChar).join("") + "--";
}

/** Split a multi-frame zstd buffer and decompress every frame. */
function frameTexts(buffer) {
  const starts = [];
  let at = 0;
  while ((at = buffer.indexOf(MAGIC, at)) !== -1) {
    starts.push(at);
    at += MAGIC.length;
  }
  if (!starts.length) return [];
  const out = [];
  for (let i = 0; i < starts.length; i += 1) {
    const slice = buffer.subarray(starts[i], starts[i + 1] ?? buffer.length);
    try {
      out.push(zstdDecompressSync(slice).toString("utf8"));
    } catch {
      /* a torn trailing frame is expected on a live session */
    }
  }
  return out;
}

/** Parse JSONL, dropping incomplete or malformed lines. */
function parseLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* the last line of a live session may be partial */
    }
  }
  return events;
}

/** Flatten a message content array into plain text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Fully read one session into a summary plus its turns. */
export async function readSession(path) {
  const buffer = await readFile(path);
  const events = frameTexts(buffer).flatMap(parseLines);
  const header = events.find((e) => e.type === "session") ?? {};
  const title = events.filter((e) => e.type === "session/title").at(-1)?.data?.title ?? "";
  const turns = events.filter((e) => e.type === "turn/start").length;
  const messages = [];
  for (const event of events) {
    if (event.type === "user/message") {
      const text = textOf(event.data?.content);
      if (text) messages.push({ role: "user", time: event.time ?? 0, text });
    } else if (event.type === "assistant/message") {
      const text = textOf(event.data?.message?.content);
      if (text) messages.push({ role: "assistant", time: event.time ?? 0, text });
    }
  }
  return {
    id: header.id ?? "",
    cwd: header.cwd ?? "",
    createdAt: header.createdAt ?? 0,
    title,
    turns,
    messages,
  };
}

/** True when `child` is the same directory as `parent` or inside it. */
function inside(child, parent) {
  const a = String(child).replace(/[\\/]+$/, "").toLowerCase();
  const b = String(parent).replace(/[\\/]+$/, "").toLowerCase();
  return a === b || a.startsWith(b + "\\") || a.startsWith(b + "/");
}

/** Normalize a path for substring matching across separators. */
function flat(path) {
  // Frame text is raw JSONL, so every separator inside a path is doubled there:
  // "D:\\work\\proj" must collapse to "d:/work/proj", not "d://work//proj".
  return String(path).replace(/\\+/g, "/").toLowerCase();
}

// Titles land a few frames in, and one frame can be megabytes, so the probe is
// bounded by both: enough frames to reach the title, few enough bytes to stay cheap.
const PROBE_FRAMES = 32;
const PROBE_BYTES = 512 * 1024;

/** Read the head of a session file without pulling megabytes into memory. */
async function headOf(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PROBE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Decode the opening frames: header event, latest title, and the text probes. */
function probe(buffer) {
  if (!buffer || buffer.indexOf(MAGIC) === -1) return null;
  const texts = frameTexts(buffer).slice(0, PROBE_FRAMES);
  if (!texts.length) return null;
  const events = texts.flatMap(parseLines);
  const header = events.find((event) => event.type === "session");
  if (!header) return null;
  return {
    header,
    title: events.filter((event) => event.type === "session/title").at(-1)?.data?.title ?? "",
    texts,
  };
}

/**
 * Whether a session belongs to the project. Sessions are launched from a parent
 * directory, so the cwd rarely is the project: the opening messages usually name it.
 */
function mentionsProject(texts, projectRoot) {
  const needle = flat(projectRoot);
  return texts.some((text) => flat(text).includes(needle));
}

/**
 * List the sessions of one project, newest first.
 * @returns {Promise<Array<{id:string,path:string,title:string,updatedAt:number,turns:number}>>}
 */
export async function listSessions(home, projectRoot, { since = 0, full = false } = {}) {
  const root = join(home, "sessions");
  if (!existsSync(root)) return [];
  let groups = [];
  try {
    groups = await readdir(root);
  } catch {
    return [];
  }

  const candidates = [];
  for (const group of groups) {
    const groupDir = join(root, group);
    let ids = [];
    try {
      ids = await readdir(groupDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const path = join(groupDir, id, FILE);
      if (!existsSync(path)) continue;
      candidates.push({ id, path, group, groupDir });
    }
  }

  const matched = [];
  for (const item of candidates) {
    const info = await stat(item.path).catch(() => null);
    if (!info) continue;
    if (since && info.mtimeMs < since) continue;
    const head = probe(await headOf(item.path));
    if (!head) continue;
    const owned = inside(head.header.cwd, projectRoot) || mentionsProject(head.texts, projectRoot);
    if (!owned) continue;
    matched.push({
      id: head.header.id ?? item.id,
      path: item.path,
      cwd: head.header.cwd ?? "",
      createdAt: head.header.createdAt ?? info.birthtimeMs ?? 0,
      updatedAt: info.mtimeMs,
      // A title lives in the opening frames, so the list carries it for free.
      title: head.title,
      // The turn count needs the whole file; it is filled only when asked for.
      turns: 0,
    });
  }

  matched.sort((a, b) => b.updatedAt - a.updatedAt);

  if (full) {
    for (const item of matched) {
      try {
        const full_ = await readSession(item.path);
        item.title = full_.title;
        item.turns = full_.turns;
        item.lastUser = [...full_.messages].reverse().find((m) => m.role === "user")?.text ?? "";
      } catch {
        /* an unreadable session stays listed with its path and time */
      }
    }
  }

  return matched;
}

/** Load one session by id, restricted to the project's own sessions. */
export async function loadSession(home, projectRoot, id) {
  const listed = await listSessions(home, projectRoot);
  const hit = listed.find((item) => item.id === id || item.path.includes(id));
  if (!hit) return null;
  return readSession(hit.path);
}
