/**
 * Seed the notebooks for this project and project them into agent.md / project_agent.md.
 *
 * @module dsh-notebook/scripts/seed
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { dshHome, syncProject, writeEnabled, writeProject, writeUniversal } from "../lib/notebook.js";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = dshHome();

const universal = {
  entries: [
    { id: "P1", title: "交出了「跑得通」而不是「合契约」", status: "candidate", symptom: "检查全绿，但代码形状与该模块原有约定不一致", root: "目标被隐式表述成「让检查通过」，而检查覆盖不到契约", identify: "diff 里出现绕路的形状：吞异常、加特判、注释断言、把失败分支变静默", defend: "动手前先写下该区域的契约，哪怕只有一句", boundary: "一次性脚本与探索原型可先跑通，但必须标注「不承担契约」" },
    { id: "P2", title: "让检查失效，而不是让行为正确", status: "candidate", symptom: "测试全绿，但把实现改成恒真，它依然是绿的", root: "生成测试时模仿的是测试的形状，不是能失败的性质", identify: "把被测物弄坏，这个检查会红吗", defend: "新检查要在一个构造的坏变体上演示一次失败", boundary: "快照类测试天性就是变了就红，但它们保护不了逻辑错误" },
    { id: "P3", title: "对但浪费", status: "candidate", symptom: "功能正确，但耗时、内存或 IO 明显上升", root: "代价不是默认的优化维度，除非被显式要求", identify: "循环内分配、重复计算、该释放的引用被留住、跨边界同步", defend: "审查单列一栏代价，逐项问：必要吗、能早放吗、能提到循环外吗", boundary: "冷路径不适用，但要说明为什么它是冷路径" },
    { id: "P4", title: "只修一处，不改同类", status: "candidate", symptom: "修了被指出的那一处，另外三处同样的写法还在", root: "上下文里只有被指出的那一处，而问题往往是一类", identify: "改完只搜到一处时，先怀疑搜索词不对", defend: "改完做同类扫描，把结果写进报告", boundary: "跨模块风险不同时可分批，但要列清单" },
    { id: "P5", title: "把「我说完成了」当成「完成了」", status: "candidate", symptom: "报告已完成，实际有检查没跑、假设没验证", root: "倾向于给出令人满意的回答", identify: "报告里出现应该、大概、理论上", defend: "报告固定三栏：跑了什么、结果如何、什么没跑及原因", boundary: "无" },
    { id: "P6", title: "自信地编造接口", status: "candidate", symptom: "调用了不存在的参数、字段或出处", root: "生成而非检索，流畅度与正确性无关", identify: "任何外部世界的事实，未被实际执行或查到出处前都不可信", defend: "以跑通或查到出处为准；不能验证的标注未验证", boundary: "无" },
    { id: "P7", title: "顺手扩大范围", status: "candidate", symptom: "任务只要求修 A，diff 里还有格式重排与无关改动", root: "把个人偏好混进任务目标", identify: "diff 规模远超任务规模", defend: "提交前问：这些改动里哪些不是任务要求的", boundary: "紧邻的明显笔误可顺手修，但要说" },
    { id: "P8", title: "过度抽象", status: "candidate", symptom: "为一个用例造了一套注册表或基类", root: "训练分布里好代码的样子包含大量抽象", identify: "新抽象的当前使用者数量小于 2", defend: "第二次重复出现才抽象", boundary: "已知有 N 个实现时可提前抽象，但要把 N 列出来" },
    { id: "P9", title: "文档与代码分叉", status: "candidate", symptom: "行为改了，文档里的数字与实测不符", root: "改代码时只加载了代码的上下文", identify: "diff 改了行为却没碰任何文档", defend: "文档里的可验证事实要能被脚本检查", boundary: "纯叙述性文档不适用" },
    { id: "P10", title: "一次巨型改动", status: "candidate", symptom: "一个 diff 动了二十几个文件，无法逐行审", root: "倾向于一次做完，而审阅带宽有限", identify: "diff 规模超过一次能认真读完的量", defend: "按可独立验证的单元分批", boundary: "机械性全局重命名可以大，但要声明纯机械" },
  ],
};

const projectNb = {
  project: "经验本插件 · dsh-notebook",
  entries: [
    { area: "layout", title: "入口与外壳", text: "`lib/index.js`：cordis 入口、HTTP 路由、/notebook 命令、启动同步。改路由或命令只动这里。" },
    { area: "layout", title: "数据与投影", text: "`lib/notebook.js`：路径解析、JSON 真身、markdown 渲染、受管区块同步。改渲染只动这里。" },
    { area: "layout", title: "会话读取", text: "`lib/sessions.js`：zstd 多帧解码、按 cwd 与首条消息匹配项目、轮次统计。" },
    { area: "layout", title: "到点提醒", text: "`lib/reminder.js`：轮次判断、项目归属推断、提醒消息构造。注入走 `agent.inbox.prepend('next-step', …)`，来源标 `kind:'plugin'`。" },
    { area: "layout", title: "界面", text: "`ui/index.html`：单文件，无构建。左会话、右双栏。" },
    { area: "layout", title: "落盘位置", text: "真身在 `<项目>/.dsh-notebook/`（含 state.json 开关与频率）与 `$DSH_HOME/notebook/universal.json`；投影为项目根的 `agent.md` / `project_agent.md`。新文件不要放项目根，除这两个投影。" },
    { area: "layout", title: "文档", text: "`docs/INSTALL.md` 是装到 dsh-desktop 的唯一权威步骤（联结 + 两处 package.json 登记 + 重启 + 四步验证）；`docs/PLAN.md` 记决策与验证清单；`README.md` 记用法。新决策进 PLAN，不要散落。" },
    { area: "layout", title: "打包与上架", text: "`docs/RELEASE.md`：manifest 硬性要求、files 白名单、发布自检、三种安装方式。改 package.json 前先看它。" },
    { area: "local", title: "必须是 bundle", text: "package.json 里缺 `dsh.bundle.patch` 时，dsh 不会加载本插件——包在、在 bundles 列表里也没用。" },
    { area: "local", title: "id 约定", text: "cordis.patch.yml 的 `id` 必须等于包名，且 `id:` 那一行不能写行尾注释（商城预检用正则抓该行）。" },
    { area: "local", title: "零宿主依赖", text: "不 import 任何 `@deepseek-ai/*`（dsh-purge 同样零依赖），故无 peerDependencies；消息对象手写。" },
    { area: "risk", title: "投影 md 不能进包", text: "`agent.md` / `project_agent.md` / `.dsh-notebook/` 是作者自己的状态，已从 files 白名单排除。" },
    { area: "local", title: "cordis.patch.yml 不用手动合并", text: "进入 `dsh.profile.bundles` 后，插件自带的 patch 作为一层配置自动叠加；重复 insert 会 already queued。" },
    { area: "risk", title: "instructionFileCandidates 会被整体替换", text: "插件 patch 覆盖该数组，会盖掉用户自定义值；装前用 Select-String 确认没改过。" },
    { area: "invariant", title: "不重造指令注入", text: "笔记内容以受管区块写进文件，由 dsh-agent-instructions 加载，插件不往 systemPrompt 塞笔记。**例外**：到点提醒是一条独立消息，走 agent.inbox 排队，来源标 kind:'plugin'，不含笔记正文。" },
    { area: "invariant", title: "真身与投影分离", text: "$DSH_HOME/notebook/** 下的 JSON 是真身，markdown 只是投影，可随时重建。" },
    { area: "invariant", title: "受管区块必须带哨兵", text: "<!-- dsh-notebook:begin --> 与 end 之间才归插件，区块外一字不碰。" },
    { area: "invariant", title: "关闭即清空", text: "停用时移除区块；纯投影文件直接删除，不产生任何注入。" },
    { area: "invariant", title: "注入面只放索引", text: "候选条目只进表格，确立条目才带全文进上下文。" },
    { area: "check", title: "语法", text: "node --check lib/*.js" },
    { area: "check", title: "同步幂等", text: "对同一份内容连跑两次 sync，第二次必须全 unchanged（test/smoke.mjs）" },
    { area: "check", title: "区块安全", text: "文件里有用户手写内容时，sync 与停用后该内容逐字不变" },
    { area: "check", title: "频率纯逻辑", text: "轮次判断、项目归属推断、消息形状（test/reminder.mjs，18 条断言）" },
    { area: "check", title: "提醒真正入队（未验证）", text: "需在 dsh 内跑过 3 轮，确认 agent.inbox.nextStep 里出现 source.plugin==='dsh-notebook' 的消息且模型执行了维护。" },
    { area: "check", title: "端到端（未验证）", text: "需在 dsh 内重启后打开 /dsh-notebook/ 页面，新增条目并确认模型能读到。" },
    { area: "risk", title: "$DSH_HOME/AGENTS.md", text: "用户手写的全局指令，插件默认不碰；通用本以项目内 agent.md 投影，不写全局文件。" },
    { area: "risk", title: "cordis.patch.yml", text: "改错会阻止 dsh 启动；insert 后必须重启才生效。" },
    { area: "risk", title: "loader 候选名是全局配置", text: "instructionFileCandidates 影响所有会话，改它要连带写全默认项。" },
    { area: "local", title: "无构建步骤", text: "纯 ESM 加手写 HTML，不引入 bundler。" },
    { area: "local", title: "界面走独立路由", text: "webServer.register 提供页面与 JSON API，不写 React 客户端模块。" },
    { area: "local", title: "路径用 node:path", text: "不写死分隔符。" },
  ],
};

await writeUniversal(home, universal);
await writeProject(project, projectNb);
await writeEnabled(project, true);
const result = await syncProject(project, home);

console.log("project:", project);
console.log("home   :", home);
console.log("sync   :", JSON.stringify(result));
