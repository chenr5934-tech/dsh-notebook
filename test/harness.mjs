/**
 * Local harness: run the plugin against a fake cordis context and a real HTTP server.
 *
 * Covers the routes, the projection writes, the command result shape and the
 * cadence hook — everything that normally needs a running dsh. What it cannot
 * cover is how dsh itself resolves and loads the bundle.
 *
 * @module dsh-notebook/test/harness
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../lib/index.js";

let failed = 0;
function assert(cond, label, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

/** A cordis context with just enough surface for this plugin. */
function fakeContext() {
  const routes = [];
  const handlers = {};
  const commands = [];
  const disposers = [];

  const ctx = {
    logger: { warn() {}, debug() {} },
    effect(fn) {
      try {
        disposers.push(fn());
      } catch {
        /* cleanup callbacks need no result */
      }
    },
    inject(deps, callback) {
      assert(Array.isArray(deps) && deps.includes("webServer"), "插件声明依赖 webServer");
      callback({
        webServer: {
          getOrigin() {
            return "http://127.0.0.1:43120";
          },
          register(route) {
            routes.push(route);
            return () => {
              const at = routes.indexOf(route);
              if (at !== -1) routes.splice(at, 1);
            };
          },
        },
      });
    },
    get(name) {
      if (name === "commands") {
        return {
          register(definition) {
            commands.push(definition);
            return () => {};
          },
        };
      }
      if (name === "webServer") {
        return {
          getOrigin() {
            return "http://127.0.0.1:43120";
          },
        };
      }
      return undefined;
    },
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  return { ctx, routes, handlers, commands, disposers };
}

/** Dispatch a request the way the host does: exact first, then the longest prefix. */
function dispatch(routes, request, response) {
  const path = new URL(request.url, "http://localhost").pathname;
  const exact = routes.find((route) => route.kind === "exact" && route.path === path);
  const prefixed = routes
    .filter((route) => route.kind !== "exact" && (path === route.path || path.startsWith(route.path + "/")))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const hit = exact ?? prefixed;
  if (!hit) {
    response.writeHead(404).end("no route");
    return;
  }
  Promise.resolve(hit.handler(request, response)).catch((error) => {
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error?.message ?? error));
  });
}

const home = await mkdtemp(join(tmpdir(), "nbh-home-"));
const project = await mkdtemp(join(tmpdir(), "nbh-proj-"));
let server;
let base = "";

try {
  const { ctx, routes, handlers, commands, disposers } = fakeContext();

  console.log("apply");
  plugin.apply(ctx, {
    dshHome: home,
    projectsRoot: join(project, ".."),
    defaultProject: project,
    syncOnStart: false,
  });
  assert(routes.length >= 1, "注册了路由", routes.length);
  assert(typeof handlers["agent/pre-step"] === "function", "订阅了 agent/pre-step");
  assert(commands.length === 1, "注册了一条命令", commands.length);
  assert(disposers.length === 1 && typeof disposers[0] === "function", "注册了清理函数");

  server = createServer((req, res) => dispatch(routes, req, res));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log("页面");
  const page = await fetch(base + "/dsh-notebook/");
  const html = await page.text();
  assert(page.status === 200, "GET /dsh-notebook/ 返回 200", page.status);
  assert(html.includes("会话历史") && html.includes("通用经验本") && html.includes("项目经验本"), "页面含三块主体");
  assert(html.includes('id="tour"') && html.includes('id="tourNever"'), "页面带上手引导卡");
  assert(html.includes('id="help"'), "页脚有使用说明入口");
  assert((await fetch(base + "/dsh-notebook")).status === 200, "无尾斜杠也可访问");
  assert((await fetch(base + "/dsh-notebook/nope")).status === 404, "未知子路径不落进页面");

  console.log("状态接口");
  const state = await (await fetch(`${base}/dsh-notebook/api/state?project=${encodeURIComponent(project)}`)).json();
  assert(state.ok && state.project === project, "返回项目路径", state.project);
  assert(state.enabled === false, "初次为未开启");
  assert(state.state.updateEvery === 3, "默认频率 3 轮", state.state.updateEvery);
  assert(state.origin === "http://127.0.0.1:43120", "返回宿主 origin", state.origin);

  console.log("开启与投影");
  const on = await (await fetch(base + "/dsh-notebook/api/toggle", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-notebook": "1" },
    body: JSON.stringify({ project, enabled: true }),
  })).json();
  assert(on.ok && on.enabled === true, "开关打开");
  assert(existsSync(join(project, "agent.md")) && existsSync(join(project, "project_agent.md")), "两份投影已生成");
  const uni = await readFile(join(project, "agent.md"), "utf8");
  assert(uni.includes("dsh-notebook:begin"), "投影带受管区块");

  console.log("保存与频率");
  const save = await (await fetch(base + "/dsh-notebook/api/save", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-notebook": "1" },
    body: JSON.stringify({
      project,
      scope: "project",
      name: "本地测试项目",
      entries: [{ area: "layout", title: "入口", text: "lib/index.js" }],
    }),
  })).json();
  assert(save.ok, "保存成功", JSON.stringify(save));
  const prjMd = await readFile(join(project, "project_agent.md"), "utf8");
  assert(prjMd.includes("本地测试项目"), "项目名写进投影");
  assert(prjMd.includes("## 项目结构"), "结构区块已渲染");

  const freq = await (await fetch(base + "/dsh-notebook/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-notebook": "1" },
    body: JSON.stringify({ project, updateEvery: 1 }),
  })).json();
  assert(freq.ok && freq.state.updateEvery === 1, "频率改为每轮");

  console.log("手动同步");
  const sync = await (await fetch(`${base}/dsh-notebook/api/sync?project=${encodeURIComponent(project)}`)).json();
  assert(sync.ok && sync.enabled === true && sync.sync?.universal === "unchanged", "同步幂等", JSON.stringify(sync.sync));
  assert(sync.project === project, "同步落到请求里的项目", sync.project);
  // A bare POST has no body: it must keep the query's project, not fall back to
  // the process cwd (which inside the host is the profile directory).
  const barePost = await (await fetch(`${base}/dsh-notebook/api/sync?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "x-dsh-notebook": "1" },
  })).json();
  assert(barePost.ok && barePost.project === project, "空 POST 仍用 query 里的项目", barePost.project);

  // The routes are reachable from any page in this browser, so a write must
  // prove it came from the page itself.
  const forged = await fetch(`${base}/dsh-notebook/api/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ project }),
  });
  assert(forged.status === 403, "跨站写被拒", `status=${forged.status}`);
  const headless = await fetch(`${base}/dsh-notebook/api/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project }),
  });
  assert(headless.status === 403, "没有同源标记的写被拒", `status=${headless.status}`);
  // Saving is idempotent with an unchanged payload, so this checks the guard
  // without disturbing the switch the reminder cases depend on.
  const sameOrigin = await fetch(`${base}/dsh-notebook/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      project,
      scope: "project",
      name: "本地测试项目",
      entries: [{ area: "layout", title: "入口", text: "lib/index.js" }],
    }),
  });
  assert(sameOrigin.status === 200, "同源写放行", `status=${sameOrigin.status}`);
  // With no project in the request, the configured default decides — never the
  // process cwd, which inside the host is the profile directory.
  const nameless = await (await fetch(`${base}/dsh-notebook/api/sync`)).json();
  assert(nameless.project === project, "没带项目时落到 defaultProject 而不是 cwd", nameless.project);
  // A notebook rooted in $DSH_HOME would drop agent.md into the profile itself,
  // so the read refuses it — but as a fallback to the picker, not a stuck error.
  const insideHome = await (await fetch(`${base}/dsh-notebook/api/state?project=${encodeURIComponent(home)}`)).json();
  assert(insideHome.ok === true, "配置目录不直接报错，退回选择器");
  assert(insideHome.project === "", "配置目录的项目被清空");
  assert(insideHome.invalid === home, "回传被拒的路径，界面才能提示", insideHome.invalid);
  const writeHome = await fetch(`${base}/dsh-notebook/api/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-notebook": "1" },
    body: JSON.stringify({ project: home, enabled: true }),
  });
  assert(writeHome.status === 400, "写入仍拒绝配置目录", String(writeHome.status));

  console.log("审查与坏请求");
  const review = await (await fetch(`${base}/dsh-notebook/api/review?project=${encodeURIComponent(project)}`)).json();
  assert(review.ok && review.prompt.includes("自审查"), "生成审查提示");
  assert(review.prompt.split("\n").length > 5, "审查提示是多行文本");
  const missing = await (await fetch(`${base}/dsh-notebook/api/session?project=${encodeURIComponent(project)}&id=nope`)).json();
  assert(missing.ok === false, "未知会话返回 ok:false");

  console.log("命令");
  const result = await commands[0].handler({ rawInput: "status", agent: null });
  assert(result?.kind === "success", "命令返回 CommandResult", JSON.stringify(result?.kind));
  assert(typeof result.text === "string" && result.text.includes("项目："), "命令文本带项目路径");
  assert(result.text.split("\n").length > 3, "命令文本保留换行");
  const every = await commands[0].handler({ rawInput: "every 5", agent: null });
  assert(every.text.includes("每 5 轮"), "every 改频率", every.text);
  const bad = await commands[0].handler({ rawInput: "review", agent: null });
  assert(bad.kind === "success" && bad.text.includes("自审查"), "review 走成功分支");

  console.log("到点提醒");
  // The command test above moved the cadence to 5; bring it back to every turn.
  await commands[0].handler({ rawInput: "every 1", agent: null });
  const session = {
    header: { cwd: project },
    events: {
      1: { type: "turn/start" },
      2: { type: "user/message", data: { content: [{ type: "text", text: `项目在 ${project}` }] } },
    },
  };
  // The host keeps UserMessages in nextStep; the recorded target is test-local.
  const inbox = {
    nextStep: [],
    sent: [],
    prepend(target, message) {
      this.sent.push({ target, message });
      this.nextStep.push(message);
    },
  };
  const agent = { session, sent: inbox.sent, inbox };
  const decision = { kind: "enter", messages: [] };
  const out = await handlers["agent/pre-step"]({ agent, messages: [], turn: 1, step: 1, signal: {} }, async () => decision);
  assert(out === decision, "原样返回 decision，不改动下游");
  assert(agent.sent.length === 1, "排入一条提醒", agent.sent.length);
  const queued = agent.sent[0];
  assert(queued?.target === "next-step", "目标为 next-step");
  assert(queued?.message?.source?.plugin === "dsh-notebook", "来源标记正确");
  assert(queued?.message?.content?.[0]?.text?.includes("第 1 轮"), "提醒带轮次", queued?.message?.content?.[0]?.text?.slice(0, 40));

  const out2 = await handlers["agent/pre-step"]({ agent, messages: [], turn: 4, step: 1, signal: {} }, async () => decision);
  assert(out2 === decision && agent.inbox.nextStep.length === 1, "已有一条时不再重复排队");

  console.log("关闭清理");
  await fetch(base + "/dsh-notebook/api/toggle", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dsh-notebook": "1" },
    body: JSON.stringify({ project, enabled: false }),
  });
  assert(!existsSync(join(project, "project_agent.md")), "关闭后投影被清除");
  assert(existsSync(join(project, ".dsh-notebook", "notebook.json")), "真身保留，重开可恢复");

  // A second instance with no default project: this is the first run of someone
  // who just installed the bundle, so the page must load without an error even
  // though nothing is chosen yet.
  console.log("空项目的首屏");
  const home2 = await mkdtemp(join(tmpdir(), "nbh-home2-"));
  const root2 = await mkdtemp(join(tmpdir(), "nbh-root2-"));
  await mkdir(join(root2, "node_modules"), { recursive: true });
  await mkdir(join(root2, "proj-a"), { recursive: true });
  const inst = fakeContext();
  plugin.apply(inst.ctx, {
    dshHome: home2,
    projectsRoot: root2,
    defaultProject: "",
    syncOnStart: false,
  });
  const srv = createServer((req, res) => dispatch(inst.routes, req, res));
  await new Promise((done) => srv.listen(0, "127.0.0.1", done));
  const bare = `http://127.0.0.1:${srv.address().port}`;
  try {
    const empty = await (await fetch(`${bare}/dsh-notebook/api/state`)).json();
    assert(empty.ok === true, "没选项目也返回 200，不是报错", JSON.stringify(empty.error));
    assert(empty.project === "", "project 为空");
    assert(empty.projectsRoot === root2, "回传项目根", empty.projectsRoot);
    assert(
      empty.folders.length === 1 && empty.folders[0].name === "proj-a",
      "node_modules 不被当成项目",
      JSON.stringify(empty.folders.map((f) => f.name)),
    );
    assert(empty.paths.universalMd === "", "没项目时不给投影路径");
    const saved = await (
      await fetch(`${bare}/dsh-notebook/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-notebook": "1" },
        body: JSON.stringify({ projectsRoot: root2 }),
      })
    ).json();
    assert(saved.ok === true && saved.projectsRoot === root2, "保存项目根不需要项目", JSON.stringify(saved));
    const again = await (await fetch(`${bare}/dsh-notebook/api/state`)).json();
    assert(again.projectsRoot === root2, "项目根已生效", again.projectsRoot);
  } finally {
    await new Promise((done) => srv.close(done));
    await rm(home2, { recursive: true, force: true });
    await rm(root2, { recursive: true, force: true });
  }
// A reinstall swaps the module generation, so an in-memory "last reminded" map
// resets. The turn has to be remembered outside the module or every reinstall
// nudges the same session again on its very next step.
console.log("重装后不重复提醒");
{
  const home3 = await mkdtemp(join(tmpdir(), "nbh-home3-"));
  const root3 = await mkdtemp(join(tmpdir(), "nbh-root3-"));
  const proj3 = join(root3, "demo");
  await mkdir(join(proj3, ".dsh-notebook"), { recursive: true });
  await writeFile(join(proj3, ".dsh-notebook", "state.json"), JSON.stringify({ enabled: true, updateEvery: 3 }));
  try {
    const stepAt = async (turn) => {
      const inst = fakeContext();
      plugin.apply(inst.ctx, {
        dshHome: home3,
        projectsRoot: root3,
        defaultProject: proj3,
        syncOnStart: false,
      });
      const sent = [];
      const agent = {
        session: { id: "session-reinstall", header: { cwd: proj3 }, eventsSnapshot: [] },
        inbox: {
          nextStep: [],
          prepend(target, message) {
            sent.push(message);
          },
        },
      };
      await inst.handlers["agent/pre-step"]({ agent, messages: [], turn, step: 1, signal: {} }, async () => ({
        kind: "enter",
        messages: [],
      }));
      return sent.length;
    };
    const first = await stepAt(3);
    const afterReinstall = await stepAt(4);
    assert(first === 1, "第 3 轮排入一条提醒", first);
    assert(afterReinstall === 0, "重装后第 4 轮不再重复提醒", afterReinstall);
    const runtime = JSON.parse(await readFile(join(home3, "notebook", "config.json"), "utf8"));
    assert(
      runtime.remindedTurns?.["session-reinstall"] === 3,
      "上次提醒的轮次落在 runtime config",
      JSON.stringify(runtime.remindedTurns),
    );
  } finally {
    await rm(home3, { recursive: true, force: true });
    await rm(root3, { recursive: true, force: true });
  }
}

} finally {
  if (server) await new Promise((done) => server.close(done));
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);