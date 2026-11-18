/**
 * dsh-notebook: per-project experience notebook for the agent (cordis plugin).
 *
 * The plugin owns storage, enable switch and the management page. It does not
 * inject prompts: both projections are plain instruction files loaded by
 * dsh-agent-instructions.
 *
 * @module dsh-notebook
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearProjections,
  dshHome,
  projectJson,
  projectMd,
  readProject,
  readState,
  readUniversal,
  stripLegacy,
  syncProject,
  universalJson,
  universalMd,
  writeCadence,
  writeEnabled,
  writeJsonSync,
  writeProject,
  writeUniversal,
} from "./notebook.js";
import { listSessions, loadSession } from "./sessions.js";
import {
  asProject,
  createReminder,
  projectCandidates,
  projectFromCwd,
  projectFromSession,
  reminderText,
  shouldRemind,
  turnOf,
} from "./reminder.js";

export const name = "dsh-notebook";

const UI_FILE = fileURLToPath(new URL("../ui/index.html", import.meta.url));

/** Origin of the host web server, learned once `webServer` is available. */
let webOrigin = "";

/**
 * Which optional services actually came up.
 *
 * Reported by `/api/state` so that "the page works but `/notebook` says nothing"
 * is one request away from a diagnosis instead of a guess.
 */
const features = { web: false, command: false };

/** Resolve the project root of a request: explicit path, else the configured default. */
function projectOf(config, requested) {
  const candidate =
    String(requested ?? "").trim() || String(config?.defaultProject ?? "").trim();
  if (!candidate) return "";
  // A project is always an absolute path. Resolving a relative one would use the
  // host process cwd — the profile directory — and land somewhere nobody meant.
  if (!isAbsolute(candidate)) return "";
  const resolved = resolve(candidate);
  // A drive or filesystem root is not a project; writing projections there would
  // scatter agent.md across the disk.
  return dirname(resolved) === resolved ? "" : resolved;
}

/** True when `child` is `parent` itself or sits underneath it. */
function insideDir(child, parent) {
  if (!child || !parent) return false;
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Refuse a request that named no usable project instead of guessing one.
 *
 * Two failure modes are worth blocking here: the old fallback was
 * `process.cwd()`, which inside the host is the profile directory, and a client
 * can always pass that path explicitly. A notebook rooted inside `$DSH_HOME`
 * would drop `agent.md` into the profile itself, where the instruction loader
 * reads it.
 */
function needsProject(project, response, home) {
  if (project && insideDir(project, home)) {
    sendJson(response, 400, {
      ok: false,
      error: `project 落在 dsh 配置目录里（${project}），这不是一个项目`,
    });
    return true;
  }
  // A path that does not exist yet is a typo, not a project: accepting it makes
  // `mkdir -p` build a directory tree wherever the text pointed, and pointing at
  // a file makes every later write fail with ENOTDIR.
  if (project && !(existsSync(project) && statSync(project).isDirectory())) {
    sendJson(response, 400, {
      ok: false,
      error: `project 不是一个已存在的目录（${project}）`,
    });
    return true;
  }
  if (project) return false;
  sendJson(response, 400, {
    ok: false,
    error: "project required: pass ?project=<绝对路径>（或 POST body 里的 project）",
  });
  return true;
}

/** Settings the page can change at runtime, kept next to the universal notebook. */
function runtimeConfigFile(home) {
  return join(home, "notebook", "config.json");
}

function readRuntime(home) {
  try {
    const parsed = JSON.parse(readFileSync(runtimeConfigFile(home), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRuntime(home, patch) {
  const next = { ...readRuntime(home), ...patch };
  // Atomic: this file holds the cleanup list and the reminder bookkeeping, so a
  // truncated write would silently lose both.
  writeJsonSync(runtimeConfigFile(home), next);
  return next;
}

/**
 * Remember the turn a session was last reminded at, across plugin restarts.
 *
 * The in-memory map dies with the module, so a reinstall would remind the same
 * session again on its very next step. The runtime config keeps the last turn
 * per session id; old entries are trimmed so the file cannot grow forever.
 */
function rememberTurn(home, sessionId, turn) {
  if (!sessionId) return;
  const runtime = readRuntime(home);
  const turns = { ...(runtime.remindedTurns ?? {}), [sessionId]: turn };
  const ids = Object.keys(turns);
  if (ids.length > 200) {
    for (const id of ids.sort((a, b) => Number(turns[a]) - Number(turns[b])).slice(0, ids.length - 200)) {
      delete turns[id];
    }
  }
  writeRuntime(home, { remindedTurns: turns });
}

/**
 * Projects this plugin currently keeps a projection in.
 *
 * Needed because unloading the bundle has no other way to know what to clean up:
 * the blocks it planted in project roots would otherwise outlive it and keep
 * looking like something maintains them.
 */
function enabledProjects(home) {
  const list = readRuntime(home).enabledProjects;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === "string" && entry) : [];
}

/** Record (or drop) one project from the cleanup list. */
function rememberProject(home, project, on) {
  const known = new Set(enabledProjects(home));
  // Called on every step while a project is active — write only on a real change.
  if (known.has(project) === Boolean(on)) return;
  if (on) known.add(project);
  else known.delete(project);
  writeRuntime(home, { enabledProjects: [...known] });
}

/**
 * Remove every projection this plugin planted, for when it is being unloaded.
 *
 * The notebooks themselves stay: they are JSON in `$DSH_HOME` and the project's
 * `.dsh-notebook/`, and turning the plugin off was never meant to delete data.
 */
async function releaseProjections(home) {
  for (const project of enabledProjects(home)) {
    try {
      await clearProjections(project);
    } catch {
      /* a project that moved or vanished must not block unloading */
    }
  }
}

/**
 * The folder that holds projects: the bundle config wins, then whatever the page
 * saved at runtime. There is deliberately no cwd fallback — the host process
 * runs from the profile directory, and listing that is never what the user meant.
 */
function projectsRootOf(config, home) {
  const configured = String(config?.projectsRoot ?? "").trim();
  if (configured) return configured;
  const saved = home ? String(readRuntime(home).projectsRoot ?? "").trim() : "";
  return saved;
}

/** The host web origin, asked of the live service when it was not known at mount. */
function originOf(ctx) {
  if (webOrigin) return webOrigin;
  try {
    const web = ctx?.get?.("webServer");
    const origin = typeof web?.getOrigin === "function" ? web.getOrigin() : "";
    if (origin) webOrigin = String(origin).replace(/\/+$/, "");
  } catch {
    /* a host without an origin still serves the routes */
  }
  return webOrigin;
}

/** Send a JSON response. */
function sendJson(response, code, body) {
  const payload = JSON.stringify(body);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

/** Read a JSON request body under a size cap. */
async function readBody(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

/**
 * Whether a state-changing request may proceed.
 *
 * The routes listen on the host's own origin, which any page in the same browser
 * can reach. Without this, a random website could POST here and flip a project's
 * switch — or make the plugin write files into a directory of its choosing.
 *
 * A cross-origin POST always carries `Origin`, so an absent header is either a
 * same-origin navigation or a local script; the latter must name itself with the
 * explicit header, which a browser refuses to send cross-origin without a
 * preflight the host does not answer.
 */
function writeAllowed(request) {
  const origin = request.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }
  return request.headers["x-dsh-notebook"] === "1";
}

/** Answer 403 when a write request did not come from this page. */
function guardWrite(request, response) {
  if (writeAllowed(request)) return false;
  sendJson(response, 403, { ok: false, error: "cross-origin write refused" });
  return true;
}

/** Directories that are never projects, whatever the root happens to be. */
const NEVER_PROJECTS = new Set(["node_modules", "data", "dist", "build", "out"]);

/** List project folders under a root, with the notebook's own name when it has one. */
async function listProjects(projectsRoot, limit = 200) {
  if (!projectsRoot) return [];
  try {
    const items = await readdir(projectsRoot, { withFileTypes: true });
    const dirs = items
      .filter(
        (item) =>
          item.isDirectory() &&
          !item.name.startsWith(".") &&
          !NEVER_PROJECTS.has(item.name.toLowerCase()),
      )
      .slice(0, limit);
    return await Promise.all(
      dirs.map(async (item) => {
        const path = join(projectsRoot, item.name);
        const notebook = await readProject(path);
        return { name: item.name, path, label: (notebook.project ?? "").trim() || item.name };
      }),
    );
  } catch {
    return [];
  }
}

/** The self-review prompt the session model runs against its own notebook. */
function buildReviewPrompt(project, universal, projectNb) {
  const count = (nb) => (nb.entries ?? []).length;
  return [
    "自审查：检查经验本本身，不要改业务代码。",
    `项目：${project}`,
    `当前通用本 ${count(universal)} 条，项目本 ${count(projectNb)} 条。`,
    "",
    "逐项给结论：",
    "1. 重复——两条是否指向同一个识别信号？是则合并。",
    "2. 空洞——哪条说不出「如果它不在，我会犯什么错」？删掉。",
    "3. 误归——项目特有的规则是否混进了通用本？移回项目本。",
    "4. 缺失——本轮对话踩过的坑有没有漏记，尤其是文件该放哪。",
    "5. 结构——项目本的「项目结构」区块是否仍然准确，新文件有没有落进已声明的区块。",
    "",
    "先做减法：点名三条最该删的（过期／重复／说不清触发条件），连 id 一起列出来，再谈新增。",
    "删掉之后如果还有空位，最多补两条真正过了准入四问的；补不出来就一条都不加，空着比灌水强。",
    "",
    "输出一份改动清单（新增/修改/删除哪条、为什么），不要大段重写。",
    "改完写回 .dsh-notebook/notebook.json 与 $DSH_HOME/notebook/universal.json，再让插件同步一次。",
  ].join("\n");
}

/** Register the management page and its JSON API. */
function installWeb(ctx, config, home) {
  ctx.inject(["webServer"], (host) => {
    const web = host.webServer;
    features.web = true;
    // The port belongs to the host: ask it instead of assuming one.
    try {
      const origin = typeof web.getOrigin === "function" ? web.getOrigin() : "";
      if (origin) webOrigin = String(origin).replace(/\/+$/, "");
    } catch {
      /* an origin-less host still serves the routes */
    }

    const disposers = [];
    const track = (dispose) => {
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    };

    const route = (path, handler, kind = "prefix") =>
      track(
        web.register({
          kind,
          path,
          handler: async (request, response) => {
            try {
              await handler(request, response);
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        }),
      );

    route("/dsh-notebook/api/state", async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const root = projectsRootOf(config, home);
      const asked = projectOf(config, url.searchParams.get("project"));
      // A remembered-but-unusable path (the profile directory, say) falls back to
      // the picker instead of an error: a page stuck on 400 cannot be recovered
      // from without editing the address by hand.
      const invalid = asked && insideDir(asked, home) ? asked : "";
      const project = invalid ? "" : asked;
      const folders = await listProjects(root);
      const universal = await readUniversal(home);

      // No project chosen yet: answer with the picker, not an error.
      if (!project) {
        return sendJson(response, 200, {
          ok: true,
          project: "",
          invalid,
          origin: originOf(ctx),
          features: { ...features },
          enabled: false,
          state: { enabled: false, updateEvery: 3 },
          universal,
          projectNotebook: { project: "", entries: [] },
          folders,
          projectsRoot: root,
          paths: { universal: universalJson(home), project: "", universalMd: "", projectMd: "" },
        });
      }

      const [state, projectNb] = await Promise.all([readState(project), readProject(project)]);
      sendJson(response, 200, {
        ok: true,
        project,
        origin: originOf(ctx),
        features: { ...features },
        enabled: state.enabled,
        state,
        universal,
        projectNotebook: projectNb,
        folders,
        projectsRoot: root,
        paths: {
          universal: universalJson(home),
          project: projectJson(project),
          universalMd: universalMd(project),
          projectMd: projectMd(project),
        },      });
    });

    route("/dsh-notebook/api/sessions", async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const project = projectOf(config, url.searchParams.get("project"));
      if (needsProject(project, response, home)) return;
      const state = await readState(project);
      const sessions = await listSessions(home, project, {
        since: state.activatedAt,
        full: url.searchParams.get("full") === "1",
      });
      sendJson(response, 200, { ok: true, sessions, activatedAt: state.activatedAt });
    });

    route("/dsh-notebook/api/session", async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const project = projectOf(config, url.searchParams.get("project"));
      if (needsProject(project, response, home)) return;
      const id = url.searchParams.get("id") ?? "";
      if (!id.trim()) return sendJson(response, 400, { ok: false, error: "id required" });
      const session = await loadSession(home, project, id);
      if (!session) return sendJson(response, 404, { ok: false, error: "session not found" });
      sendJson(response, 200, { ok: true, session });
    });

    route("/dsh-notebook/api/settings", async (request, response) => {
      if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "POST only" });
      if (guardWrite(request, response)) return;
      const body = await readBody(request);
      const url = new URL(request.url, "http://localhost");
      if (typeof body.projectsRoot === "string") {
        writeRuntime(home, { projectsRoot: body.projectsRoot.trim() });
      }
      const project = projectOf(config, body.project || url.searchParams.get("project"));
      // Saving the projects root needs no project — that is how one gets chosen.
      if (!project) {
        return sendJson(response, 200, { ok: true, projectsRoot: projectsRootOf(config, home) });
      }
      if (needsProject(project, response, home)) return;
      const state = await writeCadence(project, body.updateEvery);
      sendJson(response, 200, { ok: true, state, projectsRoot: projectsRootOf(config, home) });
    });

    route("/dsh-notebook/api/review", async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const project = projectOf(config, url.searchParams.get("project"));
      if (needsProject(project, response, home)) return;
      const [universal, projectNb] = await Promise.all([readUniversal(home), readProject(project)]);
      sendJson(response, 200, {
        ok: true,
        prompt: buildReviewPrompt(project, universal, projectNb),
      });
    });

    route("/dsh-notebook/api/save", async (request, response) => {
      if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "POST only" });
      if (guardWrite(request, response)) return;
      const body = await readBody(request);
      const url = new URL(request.url, "http://localhost");
      const project = projectOf(config, body.project || url.searchParams.get("project"));
      if (body.scope === "universal") {
        // The universal projection lives inside EVERY project, so one save has to
        // refresh all of them. That is also why this branch needs no project of
        // its own: the universal notebook is editable before any is chosen.
        await writeUniversal(home, { entries: body.entries ?? [] });
        const sync = {};
        for (const target of enabledProjects(home)) {
          sync[target] = await syncProject(target, home).catch(() => "failed");
        }
        return sendJson(response, 200, { ok: true, scope: "universal", sync });
      }
      if (needsProject(project, response, home)) return;
      const current = await readProject(project);
      await writeProject(project, {
        // `||` and not `??`: an empty name from the page means "unchanged", not
        // "erase what the model wrote".
        project: body.name || current.project || "",
        entries: body.entries ?? current.entries ?? [],
      });
      const result = await syncProject(project, home);
      sendJson(response, 200, { ok: true, scope: "project", sync: result });
    });

    route("/dsh-notebook/api/toggle", async (request, response) => {
      if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "POST only" });
      if (guardWrite(request, response)) return;
      const body = await readBody(request);
      const url = new URL(request.url, "http://localhost");
      const project = projectOf(config, body.project || url.searchParams.get("project"));
      if (needsProject(project, response, home)) return;
      await writeEnabled(project, Boolean(body.enabled));
      rememberProject(home, project, Boolean(body.enabled));
      const result = await syncProject(project, home);
      sendJson(response, 200, { ok: true, enabled: Boolean(body.enabled), sync: result });
    });

    route("/dsh-notebook/api/sync", async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      const fromQuery = url.searchParams.get("project");
      let project = projectOf(config, fromQuery);
      if (request.method === "POST") {
        if (guardWrite(request, response)) return;
        const body = await readBody(request);
        // A bare POST (no body) must not fall through to the launch directory.
        project = projectOf(config, body.project || fromQuery);
      }
      if (needsProject(project, response, home)) return;
      const state = await readState(project);
      if (!state.enabled) {
        return sendJson(response, 200, { ok: true, enabled: false, project, sync: null });
      }
      const sync = await syncProject(project, home);
      sendJson(response, 200, { ok: true, enabled: true, project, sync });
    });

    const servePage = async (request, response) => {
      const html = await readFile(UI_FILE, "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Same-origin framing is how the sidebar panel hosts this page; anything
        // else framing it would be clickjacking.
        "x-frame-options": "SAMEORIGIN",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(html);
    };
    route("/dsh-notebook", servePage, "exact");
    route("/dsh-notebook/", servePage, "exact");

    ctx.effect?.(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* a route that already unmounted is fine */
        }
      }
      // Unloading this bundle must not leave orphaned blocks in project roots
      // that still look maintained. The notebooks are untouched, so a reinstall
      // rebuilds the projections from them.
      releaseProjections(home).catch(() => {
        /* cleanup is best effort; a locked file must not break unloading */
      });
    });
  });
}

/**
 * Register the `/notebook` command.
 * @returns {() => void} disposer, empty when the host has no command service.
 */
function installCommand(ctx, config, home) {
  if (typeof ctx.inject !== "function") return;
  // Wait for the service instead of sampling it once: a plugin is mounted before
  // every service it does not declare is necessarily up, and a missing
  // `commands` here would silently drop the whole command surface.
  ctx.inject(["commands"], (host) => registerCommand(host?.commands, ctx, config, home));
}

/** Wire the command definition once the command service has appeared. */
function registerCommand(commands, ctx, config, home) {
  if (!commands?.register) return;
  features.command = true;

  const run = async (action, project, rest) => {
    if (action === "on" || action === "off") {
      await writeEnabled(project, action === "on");
      rememberProject(home, project, action === "on");
      const result = await syncProject(project, home);
      return `经验本已${action === "on" ? "开启" : "关闭"}：${project}\n投影结果：${JSON.stringify(result)}`;
    }
    if (action === "every") {
      const state = await writeCadence(project, rest[0] ?? 3);
      return `更新频率：每 ${state.updateEvery} 轮`;
    }
    if (action === "review") {
      const [universal, projectNb] = await Promise.all([readUniversal(home), readProject(project)]);
      return buildReviewPrompt(project, universal, projectNb);
    }
    if (action === "sync") {
      const result = await syncProject(project, home);
      return `已同步：${project}\n${JSON.stringify(result)}`;
    }
    const state = await readState(project);
    const result = await syncProject(project, home);
    const origin = originOf(ctx);
    return [
      `项目：${project}`,
      `状态：${state.enabled ? "已开启" : "未开启"}`,
      `频率：每 ${state.updateEvery} 轮更新一次`,
      `投影：${JSON.stringify(result)}`,
      `界面：${origin ? `${origin}/dsh-notebook/?project=${encodeURIComponent(project)}` : "（宿主未暴露 origin，请从 dsh 首页进入）"}`,
      "",
      "提示：若投影文件未被模型读到，需在 cordis.patch.yml 的 agent-instructions 里补：",
      '  instructionFileCandidates: ["AGENTS.md", "CLAUDE.md", "dsh-notebook.md", "dsh-notebook-project.md"]',
    ].join("\n");
  };

  let dispose;
  try {
    dispose = commands.register({
      name: "notebook",
      description: "经验本：status | on | off | sync | every <n> | review",
      input: { hint: "status | on | off | sync | every <n> | review" },
      handler: async (invocation) => {
        try {
          const raw = String(invocation?.rawInput ?? "").trim();
          const parts = raw ? raw.split(/\s+/) : [];
          const action = (parts[0] || "status").toLowerCase();
          let projectArg = "";
          const rest = [];
          for (const token of parts.slice(1)) {
            // A token carrying a separator names a project; anything else is an argument.
            if (!projectArg && /[\\/]/.test(token)) projectArg = token;
            else rest.push(token);
          }
          const project =
            projectOf(config, projectArg) || projectFor(invocation?.agent?.session, config, home);
          if (!project) {
            return {
              kind: "error",
              text: "没认出项目：带上绝对路径，例如 /notebook status D:\\工作区\\PROJECTS-项目\\某项目",
            };
          }
          if (insideDir(project, home)) {
            return { kind: "error", text: `${project} 在 dsh 配置目录里，不是项目目录` };
          }
          return { kind: "success", text: await run(action, project, rest) };
        } catch (error) {
          return { kind: "error", text: `经验本操作失败：${String(error?.message ?? error)}` };
        }
      },
    });
  } catch {
    /* a host that rejects this definition: the web page still works */
    return;
  }
  // The disposer has to ride on an effect, otherwise an unloaded plugin leaves a
  // command wired to functions that no longer exist.
  ctx.effect?.(() => () => {
    try {
      dispose?.();
    } catch {
      /* already unregistered */
    }
  });
}

/**
 * The first project path the session hints at that exists on disk.
 *
 * Candidates come shallowest first, and the shallow one often exists too — it is
 * the container folder, not a project. Deeper wins, because that is the one the
 * message actually named.
 */
function pickProject(session, root) {
  const candidates = projectCandidates(session, root);
  const depth = (path) => path.split(/[\\/]+/).filter(Boolean).length;
  const live = candidates.filter((path) => existsSync(path)).sort((a, b) => depth(b) - depth(a));
  return live[0] ?? candidates[0] ?? "";
}

/**
 * Project for one session: the cwd's own project, a path the session mentioned,
 * or the configured default. Returns "" when nothing identifies a project.
 */
function projectFor(session, config, home) {
  const root = projectsRootOf(config, home);
  return (
    projectFromCwd(session?.header?.cwd ?? "", root) ||
    pickProject(session, root) ||
    asProject(config?.defaultProject) ||
    ""
  );
}

/**
 * The project the cadence hook should maintain, with its own switch state.
 *
 * A session's opening messages name several paths — the project, its packaged
 * sibling, a doc folder. Picking the deepest existing one is arbitrary; the
 * project that matters is the one whose switch was turned on, so an enabled
 * candidate wins over a merely existing one.
 *
 * The candidates come from scanning the session's own event log, so recomputing
 * them on every step costs more as the conversation grows. A session does not
 * change projects mid-run, so the answer is cached against the session object —
 * but a cached project that has since been switched off must be re-resolved,
 * otherwise turning the notebook off and on mid-session silences it for good.
 */
const sessionProjects = new WeakMap();

async function resolveActiveProject(session, config, home) {
  if (session && typeof session === "object") {
    const known = sessionProjects.get(session);
    if (known) {
      const state = await readState(known);
      // A project closed mid-session must not pin the reminder off forever.
      if (state.enabled) return { project: known, state };
      sessionProjects.delete(session);
    }
  }

  const root = projectsRootOf(config, home);
  // The working directory outranks paths merely mentioned in the prose: a
  // session sitting inside project A that happens to mention B must not write
  // its lessons into B's notebook.
  const fromCwd = projectFromCwd(session?.header?.cwd ?? "", root);
  const ordered = fromCwd
    ? [fromCwd]
    : [...new Set(projectCandidates(session, root))].filter(Boolean);

  let fallback = "";
  for (const path of new Set(ordered)) {
    if (!existsSync(path) || insideDir(path, home)) continue;
    const state = await readState(path);
    if (state.enabled) {
      if (session && typeof session === "object") sessionProjects.set(session, path);
      return { project: path, state };
    }
    if (!fallback) fallback = path;
  }

  const project = fallback || asProject(config?.defaultProject) || "";
  if (!project) return { project: "", state: { enabled: false, activatedAt: 0, updateEvery: 3 } };
  return { project, state: await readState(project) };
}

/** Queue a cadence reminder on the agent's own inbox when one is due. */
function installCadence(ctx, config, home) {
  if (typeof ctx.on !== "function") return;
  const lastReminded = new WeakMap();

  // Opt-in breadcrumb: silence is ambiguous between "not called" and "skipped".
  // Set DSH_NOTEBOOK_TRACE=1 in the dsh process to record every decision.
  const trace = (line) => {
    if (!process.env.DSH_NOTEBOOK_TRACE) return;
    try {
      mkdirSync(join(home, "notebook"), { recursive: true });
      appendFileSync(join(home, "notebook", "cadence.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* diagnostics must never break the hook */
    }
  };

  ctx.on("agent/pre-step", async (payload, next) => {
    trace(`enter turn=${payload?.turn} step=${payload?.step}`);
    const decision = await next();
    try {
      const agent = payload?.agent;
      const session = agent?.session;
      const { project, state } = await resolveActiveProject(session, config, home);
      if (!project || insideDir(project, home)) {
        const root = projectsRootOf(config, home);
        const cands = JSON.stringify(projectCandidates(session, root).slice(0, 3));
        trace(`skip project=${JSON.stringify(project)} root=${JSON.stringify(root)} cands=${cands}`);
        return decision;
      }

      if (!state.enabled) {
        trace(`skip disabled project=${JSON.stringify(project)}`);
        return decision;
      }

      // Self-heal the cleanup list: a project enabled before this bookkeeping
      // existed, or restored from an older config, must still be released on
      // unload instead of leaving its block behind.
      rememberProject(home, project, true);

      // payload.turn is the harness's own counter; the log is the fallback.
      const turn = Number(payload?.turn) > 0 ? Number(payload.turn) : turnOf(session);
      const sessionId = session?.id ?? "";
      const remembered = Number(readRuntime(home).remindedTurns?.[sessionId]) || 0;
      const lastTurn = Math.max(lastReminded.get(session) ?? 0, remembered);
      if (!shouldRemind({ turn, lastTurn, every: state.updateEvery })) {
        trace(`skip cadence turn=${turn} last=${lastTurn} every=${state.updateEvery}`);
        return decision;
      }

      // Never stack: one pending reminder of our own is enough.
      const pending = agent?.inbox?.nextStep ?? [];
      if (pending.some((message) => message?.source?.plugin === "dsh-notebook")) {
        trace("skip already pending");
        return decision;
      }

      // Keep the projections current before asking the model to maintain them.
      await syncProject(project, home).catch(() => {});

      const [universal, projectNb] = await Promise.all([readUniversal(home), readProject(project)]).catch(
        () => [{ entries: [] }, { entries: [] }],
      );
      agent.inbox.prepend(
        "next-step",
        createReminder(
          reminderText({
            project,
            turn,
            every: state.updateEvery,
            universalCount: (universal.entries ?? []).length,
            projectCount: (projectNb.entries ?? []).length,
          }),
        ),
      );
      lastReminded.set(session, turn);
      rememberTurn(home, sessionId, turn);
      trace(`queued turn=${turn} project=${project}`);
    } catch (error) {
      trace(`error ${error?.message ?? error}`);
      ctx.logger?.warn?.("dsh-notebook: reminder failed: %o", error);
    }
    return decision;
  });
}

/** Cordis entry: wire the web page, the command, the cadence hook, and re-project on start. */
export function apply(ctx, config = {}) {
  const home = dshHome(config.dshHome);

  installWeb(ctx, config, home);
  installCommand(ctx, config, home);
  installCadence(ctx, config, home);

  // Rebuild every projection this plugin is responsible for. The cleanup hook
  // strips them on unload — and possibly on a plain quit — so mount has to put
  // them back from the notebooks, which are the truth.
  if (config.syncOnStart !== false) {
    const project = asProject(config.defaultProject);
    const targets = new Set(enabledProjects(home));
    if (project) targets.add(project);
    for (const target of targets) {
      syncProject(target, home).catch(() => {
        /* a missing project folder must not block startup */
      });
    }
  }
}

const plugin = { name, apply };

export default plugin;
