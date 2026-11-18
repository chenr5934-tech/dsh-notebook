/**
 * Cadence logic: turn counting, due-ness, project resolution, message shape.
 *
 * @module dsh-notebook/test/reminder
 */

import { PROJECT_MD, UNIVERSAL_MD } from "../lib/notebook.js";
import { createReminder, projectCandidates, projectFromCwd, projectFromSession, reminderText, shouldRemind, turnOf } from "../lib/reminder.js";

let failed = 0;
function assert(cond, label, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}


console.log("路径紧跟正文")
const glue = { eventsSnapshot: [{ type: "user/message", data: { content: [{ type: "text", text: "D:\\dsh工作区\\PROJECTS-项目\\dsh-notebook请你完善这个项目" }] } }] };
const glued = projectCandidates(glue, "D:\\dsh工作区\\PROJECTS-项目");
assert(glued.includes("D:\\dsh工作区\\PROJECTS-项目\\dsh-notebook"), "路径后紧跟正文时取 ASCII 前缀作目录名", glued.join(" | "));
console.log("sessionEvents")
const snap = { eventsSnapshot: [{ type: "turn/start" }, { type: "turn/start" }] };
assert(turnOf(snap) === 2, "真实 Session 只有 eventsSnapshot 时也数得出轮数", turnOf(snap));
assert(turnOf({ log: [{ type: "turn/start" }] }) === 1, "log 数组也能数");
assert(turnOf({ events: [{ type: "turn/start" }] }) === 1, "events 数组仍优先");
console.log("turnOf");
assert(turnOf({ events: { 1: { type: "turn/start" }, 2: { type: "step/start" }, 3: { type: "turn/start" } } }) === 2, "对象形式的 events 计轮正确");
assert(turnOf({ events: [{ type: "turn/start" }, { type: "turn/start" }] }) === 2, "数组形式的 events 计轮正确");
assert(turnOf({}) === 0 && turnOf(null) === 0, "缺事件时返回 0 而不是抛错");

console.log("shouldRemind");
assert(shouldRemind({ turn: 3, lastTurn: 0, every: 3 }) === true, "首次到达频率即提醒");
assert(shouldRemind({ turn: 2, lastTurn: 0, every: 3 }) === false, "未到频率不提醒");
assert(shouldRemind({ turn: 5, lastTurn: 3, every: 3 }) === false, "间隔不足不提醒");
assert(shouldRemind({ turn: 6, lastTurn: 3, every: 3 }) === true, "间隔够了提醒");
assert(shouldRemind({ turn: 2, lastTurn: 1, every: 1 }) === true, "每轮模式下一轮一次");
assert(shouldRemind({ turn: 0, lastTurn: 0, every: 1 }) === false, "轮次未知时不提醒");
assert(shouldRemind({ turn: 5, lastTurn: 0, every: 0 }) === true, "频率非法时回退为 3");

console.log("projectFromCwd");
const root = "D:\\dsh工作区\\PROJECTS-项目";
assert(projectFromCwd("D:\\dsh工作区\\PROJECTS-项目\\dsh-notebook", root) === "D:\\dsh工作区\\PROJECTS-项目\\dsh-notebook", "项目根目录本身");
assert(projectFromCwd("D:\\dsh工作区\\PROJECTS-项目\\dsh-notebook\\lib", root) === "D:\\dsh工作区\\PROJECTS-项目\\dsh-notebook", "项目子目录归到项目");
assert(projectFromCwd("D:\\dsh工作区", root) === "", "工作区根不归任何项目");
assert(projectFromCwd("", root) === "" && projectFromCwd("D:\\x", "") === "", "缺参时返回空");

console.log("projectFromSession");
const root2 = "D:\\dsh工作区\\PROJECTS-项目";
const session = {
  events: [
    { type: "user/message", data: { content: [{ type: "text", text: "【项目根目录】D:\\dsh工作区\\PROJECTS-项目\\大肥鱼刀子漫画\n【性质】连载" }] } },
  ],
};
assert(
  projectFromSession(session, root2) === "D:\\dsh工作区\\PROJECTS-项目\\大肥鱼刀子漫画",
  "从首条消息里认出项目并保留原大小写",
  projectFromSession(session, root2),
);
assert(
  projectFromSession({ events: [{ type: "user/message", data: { content: [{ type: "text", text: "随便聊聊" }] } }] }, root2) === "",
  "没提到路径时返回空",
);
assert(projectFromSession({}, root2) === "" && projectFromSession(session, "") === "", "缺参时返回空");
assert(
  projectFromSession({ events: [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "D:\\dsh工作区\\PROJECTS-项目\\x" }] } } }] }, root2) === "",
  "只看用户消息，不看助手消息",
);

console.log("message");
const msg = createReminder("hello");
assert(
  msg.role === "user" && msg.source.kind === "plugin:dsh-notebook" && msg.source.plugin === "dsh-notebook",
  "消息来源是 producer-owned 的 plugin:<包名>，V4 会话格式才收",
  JSON.stringify(msg.source),
);
assert(msg.source.kind !== "plugin", "不要退回被 V4 拒收的裸 plugin kind");
assert(msg.content[0].type === "text" && msg.content[0].text === "hello", "内容为单个文本块");
assert(typeof msg.id === "string" && msg.id.startsWith("dsh-notebook-reminder-"), "消息带稳定前缀的 id");

const text = reminderText({ project: "D:\\p", turn: 6, every: 3 });
assert(text.includes("第 6 轮") && text.includes("每 3 轮") && text.includes("D:\\p"), "提醒文本含轮次与项目");
assert(text.startsWith("<system-reminder>") && text.trimEnd().endsWith("</system-reminder>"), "提醒用 system-reminder 包裹");

// The reminder is the only place the admission rules reach the model, so each
// gate must survive edits: a nudge that just says "update your notes" invites
// padding, and a padded notebook is worse than a short one.
for (const gate of ["可复现", "非显然", "有代价", "可执行"]) {
  assert(text.includes(gate), `准入闸「${gate}」写进提醒`);
}
assert(text.includes("废话") && text.includes("流水账"), "提醒点名了不该写的形状");
assert(text.includes("candidate") && text.includes("不占上下文"), "提醒说明 candidate 只进索引、不进上下文");
assert(!text.includes("先减后加"), "条目不多时不催删");

// The projection names appear in the reminder, so a rename that misses this file
// sends the model to write into a file nobody reads. Bind it to the constants.
assert(text.includes(UNIVERSAL_MD) && text.includes(PROJECT_MD), "提醒里的投影名与实际文件名一致");
assert(!text.includes("agent.md"), "提醒不再出现旧投影名");

// Past the comfort limit the reminder switches job: stop adding, start cutting.
const crowded = reminderText({ project: "D:\\p", turn: 9, every: 3, projectCount: 41 });
assert(crowded.includes("先减后加") && crowded.includes("三条最该删"), "条目过载时改口径为删减");
assert(crowded.includes("现有") && crowded.includes("41"), "提醒带上当前条目数");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
