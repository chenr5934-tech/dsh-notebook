/**
 * Smoke test: projection, idempotence, block safety, disable cleanup.
 *
 * @module dsh-notebook/test/smoke
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { clearSessionCache, listSessions } from "../lib/sessions.js";
import {
  BEGIN,
  END,
  readProject,
  readUniversal,
  renderProject,
  renderUniversal,
  syncProject,
  syncProjection,
  universalMd,
  projectMd,
  writeEnabled,
  writeUniversal,
  writeProject,
} from "../lib/notebook.js";

let failed = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const bad = (label, detail) => {
  failed += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

function assert(cond, label, detail) {
  if (cond) ok(label);
  else bad(label, detail);
}

const home = await mkdtemp(join(tmpdir(), "nb-home-"));
const project = await mkdtemp(join(tmpdir(), "nb-proj-"));

try {
  console.log("render");
  const uni = {
    entries: [
      { id: "P1", title: "跑得通不等于合契约", status: "established", symptom: "检查全绿但形状不对", root: "目标被表述成让检查通过", identify: "diff 里出现绕路", defend: "先写契约", boundary: "原型阶段不适用" },
    ],
  };
  const uniMd = renderUniversal(uni);
  assert(uniMd.includes("| P1 |") && uniMd.includes("**边界**"), "通用本渲染出索引与全文");

  const proj = { project: "示例项目 · demo", entries: [{ area: "risk", title: "别碰全局配置", text: "改错会起不来" }] };
  const projMd = renderProject(proj);
  assert(projMd.includes("## 高危区") && projMd.includes("别碰全局配置"), "项目本按区渲染");
  assert(projMd.startsWith("# 项目经验本：示例项目 · demo"), "项目名写进标题");
  assert(renderProject({ entries: [] }).includes("（未命名）"), "缺名时有占位而不留空");

  // Padding by repeating a title, or by writing only a heading, must not buy
  // context: a padded notebook is worse than a short one.
  const noisy = {
    project: "noise",
    entries: [
      { area: "risk", title: "同一条", text: "旧的说法", updatedAt: 1000 },
      { area: "risk", title: "同一条", text: "新的说法", updatedAt: 2000 },
      { area: "local", title: "只有标题", text: "   " },
    ],
  };
  const noisyMd = renderProject(noisy);
  assert(noisyMd.includes("新的说法") && !noisyMd.includes("旧的说法"), "同标题只留最新一条", noisyMd);
  assert(noisyMd.includes("只有标题，没有结论"), "空正文降级成一行提示");
  assert(
    !renderUniversal({ entries: [{ id: "P9", title: "空的", status: "established", text: "" }] }).includes(
      "### P9",
    ),
    "没有内容的 established 不进全文区",
  );

  // Every project entry carries the minute it last changed, so a long-lived file
  // still says which lines are stale.
  const stamped = renderProject({
    project: "示例项目 · demo",
    entries: [
      { area: "risk", title: "带时间的", text: "x", updatedAt: new Date("2026-03-09T07:05:00").getTime() },
      { area: "risk", title: "没时间的", text: "y" },
    ],
  });
  assert(
    stamped.includes("（2026-03-09 07:05）**带时间的**"),
    "条目带年月日与时分",
    stamped.split("\n").find((line) => line.includes("带时间的")),
  );
  assert(stamped.includes("（时间未知）**没时间的**"), "缺戳时写明时间未知而不是留空");

  console.log("时间戳");
  const stampProj = await mkdtemp(join(tmpdir(), "nb-stamp-"));
  const st1 = await writeProject(stampProj, {
    project: "戳",
    entries: [{ id: "S1", title: "原来的", text: "一字不变" }],
  });
  const kept = st1.entries[0].updatedAt;
  assert(typeof kept === "number" && kept > 0, "首次写入就盖戳", kept);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const st2 = await writeProject(stampProj, {
    project: "戳",
    entries: [{ id: "S1", title: "原来的", text: "一字不变" }],
  });
  assert(st2.entries[0].updatedAt === kept, "内容没变就不动时间（连点保存不刷全部）");
  const st3 = await writeProject(stampProj, {
    project: "戳",
    entries: [{ id: "S1", title: "原来的", text: "改了一个字" }],
  });
  assert(st3.entries[0].updatedAt > kept, "内容改了就刷新时间", st3.entries[0].updatedAt - kept);
  const st4 = await writeProject(stampProj, {
    project: "戳",
    entries: [...st3.entries, { id: "S2", title: "新来的", text: "x" }],
  });
  assert(st4.entries[0].updatedAt === st3.entries[0].updatedAt, "加新条目不影响旧条目的戳");
  assert(st4.entries[1].updatedAt >= st3.entries[0].updatedAt, "新条目有戳");

  // Entries written before ids existed must keep their stamp too, or a single
  // save re-dates the whole notebook and the timestamp means nothing.
  const st5 = await writeProject(stampProj, {
    project: "戳",
    entries: [{ area: "layout", title: "没有 id 的", text: "老条目" }],
  });
  const bareStamp = st5.entries[0].updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const st6 = await writeProject(stampProj, {
    project: "戳",
    entries: [{ area: "layout", title: "没有 id 的", text: "老条目" }],
  });
  assert(st6.entries[0].updatedAt === bareStamp, "没有 id 的条目重存也不刷时间", st6.entries[0].updatedAt - bareStamp);
  const st7 = await writeProject(stampProj, {
    project: "戳",
    entries: [{ area: "layout", title: "没有 id 的", text: "老条目改过" }],
  });
  assert(st7.entries[0].updatedAt > bareStamp, "没有 id 的条目内容改了会刷新");

  // Two blank cards are two cards being filled in, not a duplicate.
  const st8 = await writeProject(stampProj, {
    project: "戳",
    entries: [
      { area: "layout", title: "", text: "" },
      { area: "layout", title: "", text: "" },
      { area: "risk", title: "有标题", text: "有结论" },
    ],
  });
  const rendered = renderProject(st8);
  assert((rendered.match(/^- /gm) ?? []).length === 3, "两条空卡都渲染出来，不被当重复合并");
  await rm(stampProj, { recursive: true, force: true });

  console.log("sync");
  await writeUniversal(home, uni);
  await writeProject(project, proj);
  await writeEnabled(project, true);
  const first = await syncProject(project, home);
  assert(first.universal === "created" && first.project === "created", "首次同步创建两个投影", JSON.stringify(first));

  const a = await readFile(universalMd(project), "utf8");
  assert(a.includes(BEGIN) && a.includes(END), "投影带哨兵");
  assert(a.indexOf(BEGIN) < a.indexOf(END), "哨兵顺序正确");

  console.log("idempotence");
  const second = await syncProject(project, home);
  assert(second.universal === "unchanged" && second.project === "unchanged", "重复同步零改动", JSON.stringify(second));

  console.log("block safety");
  const path = universalMd(project);
  const withUser = "# 我自己写的东西\n\n这段不能被插件改动。\n\n" + (await readFile(path, "utf8"));
  await writeFile(path, withUser, "utf8");
  await syncProject(project, home);
  const after = await readFile(path, "utf8");
  assert(after.includes("这段不能被插件改动。"), "区块外内容逐字保留");
  assert(after.split(BEGIN).length === 2, "不产生重复区块");

  console.log("disable");
  const off = await syncProject(project, await (async () => {
    await writeEnabled(project, false);
    return home;
  })());
  assert(off.enabled === false, "关闭状态被识别");
  assert(!existsSync(projectMd(project)), "关闭后纯投影文件被删除");
  const keptPath = universalMd(project);
  if (existsSync(keptPath)) {
    const kept = await readFile(keptPath, "utf8");
    assert(!kept.includes(BEGIN), "有关用户内容时只摘掉区块");
    assert(kept.includes("这段不能被插件改动。"), "摘区块不伤用户内容");
  } else {
    ok("有关用户内容时只摘掉区块");
    ok("摘区块不伤用户内容");
  }

  console.log("resilience");
  await mkdir(join(project, ".dsh-notebook"), { recursive: true });
  await writeFile(join(project, ".dsh-notebook", "notebook.json"), "{ broken", "utf8");
  const salvaged = await readUniversal(home);
  assert(Array.isArray(salvaged.entries), "损坏的 JSON 回退到空本而不是抛错");

  // A broken file must be kept aside: falling back to an empty notebook and then
  // saving over it would lose the entries the user still had.
  const brokenRead = await readProject(project);
  assert(Array.isArray(brokenRead.entries), "损坏的项目本也能读出一个空结构");
  const keptBad = readdirSync(join(project, ".dsh-notebook")).filter((f) => f.includes(".corrupt-"));
  assert(keptBad.length === 1, "损坏的文件被改名留档，不直接覆盖", keptBad.join(","));

  const lone = join(home, "lone.md");
  await writeFile(lone, "user content only\n", "utf8");
  const r = await syncProjection(lone, null);
  assert(r === "unchanged", "无区块的文件在移除时不被动", r);

  console.log("sentinel containment");
  // An entry may legitimately quote the sentinel pair; verbatim it would give
  // the next sync a second closer to stop at, and the block would grow debris.
  const quoted = renderProject({
    kind: "project",
    project: "边界项目",
    entries: [
      { area: "invariant", title: "哨兵", text: `用 ${BEGIN} 与 ${END} 包住` },
    ],
  });
  assert(!quoted.includes(END), "渲染时就实体化正文里的哨兵");
  assert(quoted.includes("dsh-notebook:end"), "实体化后仍然可读");

  const trap = join(home, "trap.md");
  const trapBody = `条目正文\n${END}\n后面的废话`;
  await syncProjection(trap, trapBody);
  const reprised = await syncProjection(trap, trapBody);
  assert(reprised === "unchanged", "含闭合标记的正文第二次同步幂等", reprised);
  const trapped = await readFile(trap, "utf8");
  const closers = trapped.split(END).length - 1;
  assert(closers === 1, "投影里只保留一个闭合标记", String(closers));
  assert(trapped.includes("后面的废话"), "正文不丢");
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
}

console.log("会话归属");
{
  // A session is launched from a parent directory, so its cwd never equals the
  // project. Ownership then comes from the opening frames naming the path — and
  // those frames are raw JSONL, where every separator is doubled.
  const sHome = await mkdtemp(join(tmpdir(), "nb-sess-"));
  const parent = join(sHome, "work");
  const child = join(parent, "proj");
  await mkdir(child, { recursive: true });
  const group = join(sHome, "sessions", "--work--", "session-abc");
  await mkdir(group, { recursive: true });
  const frames = (cwd, mentions) =>
    zstdCompressSync(
      Buffer.from(
        [
          JSON.stringify({ type: "session", version: 4, id: "session-abc", createdAt: 1, cwd }),
          JSON.stringify({
            type: "user/message",
            data: { content: [{ type: "text", text: mentions }] },
          }),
          "",
        ].join("\n"),
      ),
    );
  const file = join(group, "session.v4.jsonl.zstd");

  await writeFile(file, Buffer.concat([frames(parent, `项目在 ${child} 下面`), frames(parent, "无关")]));
  assert((await listSessions(sHome, child)).length === 1, "开会话的目录是父级时，靠首帧提到的路径认领");

  clearSessionCache();
  await writeFile(file, frames(parent, "无关内容"));
  assert((await listSessions(sHome, child)).length === 0, "没提到项目就不算归属");

  clearSessionCache();
  await writeFile(file, frames(child, "无关内容"));
  assert((await listSessions(sHome, child)).length === 1, "cwd 就在项目里直接认领");

  // The title sits a few frames in; the list must carry it without reading the
  // whole file, because turn counts are the expensive part.
  const titled =
    "{" +
    JSON.stringify({ type: "session/title", data: { title: "认领一个项目" } }).slice(1);
  clearSessionCache();
  await writeFile(
    file,
    Buffer.concat([
      frames(child, "开头"),
      zstdCompressSync(Buffer.from(titled + "\n" + JSON.stringify({ type: "turn/start" }) + "\n")),
    ]),
  );
  const listed = await listSessions(sHome, child);
  assert(listed[0]?.title === "认领一个项目", "列表带到标题，不必读整个文件", listed[0]?.title);
  assert(listed[0]?.turns === 0, "轻量列表不给轮数（要全文件才算得准）");
  await rm(sHome, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
