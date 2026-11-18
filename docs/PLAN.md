# dsh-notebook 规划

## 目标

模型每次会话都失忆，同样的坑反复踩。做一个插件，让模型拥有自己的经验本：

1. 开工前能看到「通用陷阱」和「本项目陷阱」
2. 收工后能自己把新坑写回去
3. 只在"开启项目"时生效，日常问答不生成文件
4. 有可视化管理界面，能看到两份本子

## 关键调研（决定架构的四条事实）

| 事实 | 出处 | 影响 |
|---|---|---|
| dsh 已有 `AGENTS.md` 加载器，处理去重、增量、压缩重建、转义、字节预算 | `@deepseek-ai/dsh-agent-instructions` README | **不重造注入器**，插件只负责写文件 |
| 桌面端是 Electron，内嵌 `dsh-web-app`，没有"设置页挂载点"钩子 | `~/.dsh/electron/`、`plugin-inventory` 类型无 page 字段 | 界面用 `webServer.register` 提供 HTTP 页面 |
| `webServer.register({kind, path, handler})` 返回 disposer | `dsh-host-webserver` 类型 | 路由要收集 disposer，随插件卸载撤销 |
| 加载器只认 `AGENTS.md` / `CLAUDE.md` | `instructionFileCandidates` 默认值 | 投影文件名必须补进候选项，否则注入不生效 |

## 架构决策

### D1 · 不写注入器，只写文件

插件不碰 `systemPrompt`。内容以受管区块写进 `agent.md` / `project_agent.md`，由现成加载器读取。

**代价**：依赖加载器的候选名配置，多一步手工。
**收益**：不必重新处理去重、增量、压缩后重建、转义——这些是加载器已经踩过的坑。

### D2 · 真身存 JSON，markdown 是投影

`$DSH_HOME/notebook/universal.json`（跨项目共用）+ `<项目>/.dsh-notebook/notebook.json`（项目独占）。

**理由**：UI 与后续工具都应操作结构，不该解析 markdown。渲染策略（放什么、放多少）可以随时改，改完重投影即可。

### D3 · 受管区块而非独占文件

只改 `<!-- dsh-notebook:begin -->` 到 `end` 之间。区块外一行不动。

**理由**：用户可能已经在 `agent.md` 里写了东西。独占会让插件变成破坏者。冒烟测试里专门有一条"区块外内容逐字保留"。

### D4 · 开关 = 区块存在与否

停用的时候不是"标记为停用"，而是直接把区块摘掉；纯投影文件直接删。

**理由**：这是"避免日常对话造成文件冗余"的唯一可靠实现。只要文件里还有内容，加载器就会注入。

### D5 · 注入面只放索引

候选条目只进"一句话 + 状态"的表格；`确立` 的条目才把症状/根因/识别/防御/边界带进上下文。

**理由**：经验本会变长，而上下文是稀缺的。当前 10 条候选 ≈ 39 行。

### D6 · 不给模型专用工具

模型本来就能读写文件。插件不注册 `notebook_read/write`。

**理由**：少一个工具就少一处要维护的 schema 和一处可能编造的参数。文件开头的"怎么用"就是协议。

### D7 · 到点提醒走 agent 自己的 inbox，不走 systemPrompt

订阅 `agent/pre-step`（waterfall：`await next()` 后原样返回 decision，只往 inbox 塞一条），
用 `agent.inbox.prepend("next-step", message)` 排队，消息来源标 `{ kind:"plugin", plugin:"dsh-notebook" }`。

**为什么不用 systemPrompt**：那是常驻注入，会把提醒变成噪音；inbox 是"这一步要处理的事项"，用完即走。
**为什么每条会话记住上次提醒的轮次**（`WeakMap<session, turn>`）：避免每步都重复提醒，也不必落盘。
**防重**：排之前先看 `inbox.nextStep` 里有没有自己的消息，有一条就不再排。

**验证到的契约**（来自 `@deepseek-ai/dsh-agent` 与 `dsh-llm` 的类型）：
- `Inbox.prepend(target: 'next-step' | 'next-turn', message: UserMessage)`
- `UserMessage = { id, role:'user', content: ContentBlock[], source: MessageSource }`（`source` 必填）
- 插件来源是 `{ kind:'plugin', plugin: string } & ContextFormed`，`form` 可取 `'instructions'`

**没有 import 任何 `@deepseek-ai/*`**：现有 dsh 插件（如 dsh-purge）也是零外部依赖，
`createUserMessage` 之类可以手写等价对象，避免解析路径随 npx 缓存变化而失效。

### D8 · 侧栏入口用 iframe 装同一份界面

侧栏「备忘录」一行（`sidebar.panellist`，`order 40`）与主面板（`main`，`key: 'notebook'`）
都由 `client.js` 注册；主面板里渲染的是同源 iframe，地址 `/dsh-notebook/?embed=1`。

**为什么不把界面改写成 React**：那份界面是手写的原生 JS（无构建、无依赖），改成 React 要么
引入第二套渲染、要么维护两份实现，两边必然漂移。iframe 让「面板」与「独立页」物理上就是同一份代码。

**为什么不复用已占的 id**：`sidebar.panellist` 的 id 重复会顶掉原有那一格（catalog 明说
`reusing a shipped id puts you in THAT cell and replaces it`），所以用全新的 `notebook`。

**`inject` 留空**：`main` 与 `sidebar.panellist` 都由 web-app 客户端在根作用域声明，
`ctx.slots.inject(name, cb)` 本身就会等声明就绪；`apply` 里的 `inject: ['slots']` 负责等
slots 这个服务。多写依赖包名反而会在包名不对时静默失效。

**`embed` 只做减法**：`?embed=1` 时隐藏重复的标题与版本标签、收紧页头页脚内边距，
其余一概不动 —— 面板里与独立页看到的是同一套控件。

### D9 · 项目根只认显式配置，绝不回退宿主 cwd

最初的 `projectsRootOf` 在配置为空时回退 `process.cwd()`。这在宿主里等于
`~/.dsh/profiles/desktop`：界面一打开就把 profile 下的 `data`、`node_modules` 当成候选项目，
选中后又被 `$DSH_HOME` 护栏拒掉，报出「project 落在 dsh 配置目录里」。

三条修正：

- **配置三档**：bundle 的 `projectsRoot` → 运行时 `$DSH_HOME/notebook/config.json` → 空。
  空就是空，不猜。界面里填一次即落盘，不必改包。
- **空项目不是错误**：`/api/state` 在没选项目时返回 200 与候选列表（`project: ""`），
  首屏才能显示选择器而不是报错；只有「给了项目但不可用」才 400。
- **相对路径直接判空**：`projectOf` 不再用 `resolve(process.cwd(), …)` 补全 ——
  那会把随手写的相对名解析进 profile。

顺带在列出候选时跳过 `node_modules`、`data`、`dist`、`build`、`out`：即便项目根指歪了，
也不会再把人往这些目录里带。

### D10 · 上手引导用非模态浮层，教程同时写进简介页

首次打开弹一张「三分钟上手」卡片。**不做模态**：没有遮罩、不锁交互，卡片浮在右下角，
底下的项目根、下拉、开关全都能直接点 —— 边看边做才叫上手，挡着操作就叫拦路。

记住与否交给读者：勾「以后不再提醒」才写入 `localStorage['dsh-notebook:tour'] = 'off'`，
不勾则下次照样弹。页脚留一个「使用说明」按钮，随时叫回来。

同一份教程写进 `locale/*.json` 的 `meta.description` —— 插件简介页显示的正是它。宿主对详情文档的规矩是
「只能有一张特性图」（`docs/DETAIL.md` 就是一行 `![…](preview.svg)`），用法文字必须落在 description 里，
写进详情文档反而不显示。

两处内容一致，但**不共用代码**：页面里是 HTML，简介页是纯文本，硬抽一层模板反而多一处漂移源。

### D11 · 每条经验带上「哪天几点写的」

`project_agent.md` 的每条前面标 `（2026-11-18 10:37）`。时间放行首而不是行尾：几十条并排时，
左边缘能一眼扫出哪几条最旧，行尾会参差不齐。精确到分钟 —— 同一天连着写好几条时，
只到日期就分不出先后，而「这几条是同一轮改的吗」恰恰是最常问的。

时间的来源分三种：

- 新条目或内容改过的条目 → 保存那一刻。
- 内容一字未改的条目 → 保留旧戳。否则每点一次「保存并同步」，所有条目都变成现在，
  时间就再也不能说明什么。判断靠**去掉 `updatedAt` 后的整条 JSON 签名**，不靠前端传值。
- 早于时间戳功能就存在的条目 → 取 `notebook.json` 的 mtime，且**只在内存里补**，不写回真身。
  文件最后改动的时间，就是这些条目最后一次被确认的时间。

缺戳的条目渲染成 `（时间未知）`，不留空括号 —— 空括号会被读成「零」。

### D12 · 会话归属靠「首帧提到的路径」，分隔符要折叠

会话是按**启动目录**分组的，不是按项目：在 `D:\dsh工作区` 这一层开会话，`cwd` 就永远是工作区根。
所以归属判定有两条路：`cwd` 落在项目里，或者会话开头几帧的文本里出现过项目路径。

后一条曾经完全失效。帧文本是**原始 JSONL**，没解 JSON，所以路径里的每个反斜杠都是转义后的
两个字符 `\\`；`flat()` 只做单字符替换，`D:\\work\\proj` 变成 `d://work//proj`，
和 needle 的 `d:/work/proj` 永远对不上。表现是：从父目录开的会话，一个都进不了列表。

修法是把连续分隔符折叠成一个：`replace(/\\+/g, "/")`。不能用 `decodeURIComponent` 之类
去解转义 —— 帧里还有别的地方带反斜杠，解了会误伤。

### D13 · 标题随列表一起给，轮数不给

标题（`session/title`）落在第 4～7 帧，靠前；轮数要数遍全文件的 `turn/start`。
所以列表只读文件头：`open` + 一次 `read` 取前 512 KiB，最多解 32 帧，
头事件、标题、路径探测都从这几帧里出。103 个会话约 1.4 秒，且不再把 8 MB 的会话整读进内存。

轮数在轻量列表里恒为 0，界面照实省略「N 轮」而不写「0 轮」——0 会被读成「这对话是空的」，
实际只是没数。点开详情走 `readSession` 全量解析，那时才有准数。

### D14 · 运行时 Session 走适配层，不直接点 `events`

`agent.session` 是活的 `Session`，字段是 `log`、`eventsSnapshot`、`header`、`derived` 这一套，
**没有 `events`**。早期代码按 `session.events` 读，循环一次都不进，提醒永远不入队也不报错——
从外面看就是"插件装了但什么都没发生"。

现在统一走 `sessionEvents(session)`：`events` → `eventsSnapshot` → `log` 依次尝试，
数组、可迭代、`entries()`、普通对象四种形状都能摊平。`turnOf` 与 `projectCandidates` 都用它。

排查手段：`DSH_NOTEBOOK_TRACE=1` 时 pre-step 每次判定都往 `$DSH_HOME/notebook/cadence.log` 写一行，
沉默能被区分成"没调用"和"跳过了，原因是 X"。

### D15 · 会话消息的 `source.kind` 必须是 producer-owned

V4 会话格式在写入前就校验：`kind` 非空且不能等于裸 `"plugin"`，否则抛
`SessionFormatError: format v4 message requires a producer-owned source kind`，整轮中断。
而坏数据不会落盘，所以事后在会话文件里翻不到任何痕迹。

正确写法是 `plugin:<包名>`——V3 迁移里的 `producerKind()` 对未登记插件正是这么产出的。
`plugin` 字段保留，供插件自己去重时认领（`message.source.plugin === "dsh-notebook"`）。

### D16 · 项目认定优先「开关开着的那一个」

同一段开场白里往往有好几个路径（项目、外发包、文档目录），只挑"最深的且存在"会挑错，
挑到没有 `state.json` 的目录就得到 `enabled: false`，提醒静默不发。

`resolveActiveProject()` 按 `fromCwd` → 候选列表的顺序扫，**第一个 `enabled` 的候选直接胜出**；
都不开才退回第一个存在的。路径后紧跟正文（`...\dsh-notebook请你完善这个项目`）时，
段名取 ASCII 前缀作变体，交给 `existsSync` 裁决。

### D17 · 防灌水：宁可少写，也不让废话占上下文

经验本最大的失效方式不是漏记，而是被流水账撑死——写到 60 条以后没人（模型也一样）会读完，
那时它和不存在的区别只剩"占着注入预算"。分三层挡，不指望模型自觉：

1. **准入闸（软）**：提醒文本里给四问——可复现（能说出触发条件）、非显然（不看就会踩）、
   有代价（真报过错／白跑过）、可执行（能落成「下次遇到 X 就做 Y」），外加反例黑名单
   （流水账、一次性状态、没验证的猜测、普适正确的空话、已在 AGENTS.md 里的）。
   四问全过才写，卡住任何一问就不写。
2. **结构闸（硬）**：渲染层不给废话留位置——同标题的只留 `updatedAt` 最新那条，
   只有标题没结论的降级成一行 `（只有标题，没有结论）`，`established` 但四段全空的
   不进全文区（只在索引表出现）。重复和空洞因此**没有收益**。
3. **数量闸（硬）**：项目本到 40 条时，提醒改口径为「本轮不要新增，先挑三条最该删的」。
   自审查 prompt 同样先做减法：点名三条最该删的（连 id），删完有空位才补，补不出来就不补。

关键取舍：不设"必须写几条"的下限。空着比灌水强。

### D18 · 写接口只认同源

路由挂在宿主自己的 origin 上，浏览器里任何一个页面都能请求到它。原来没有这层校验：
用 `curl -X POST -H 'Origin: http://evil.example'` 打 `/api/toggle`，实测 **200 且真的落了盘**——
也就是说随便一个网页都能翻掉某个项目的开关，或者让插件往它指定的目录写 `agent.md`。

现在写操作（`toggle` / `save` / `settings` / `sync` 的 POST）都要过一道 `guardWrite`：

- 带 `Origin` 的请求，比对 `Origin` 的 host 与 `Host` 是否一致；不一致直接 403。
- 不带 `Origin` 的请求，必须带 `x-dsh-notebook: 1`——浏览器跨站设置自定义头会触发
  preflight，而宿主不答 preflight，所以这条路脚本能用、恶意页面用不了。

界面里的 `api()` 统一附加这个头，因此正常使用无感。页面响应同时补了
`x-frame-options: SAMEORIGIN`（侧栏 iframe 是同源，别的站点框架它就是点击劫持）、
`x-content-type-options: nosniff`、`referrer-policy: no-referrer`。

顺带把 `projectOf` 收紧：盘根（`D:\`、`/`）不算项目，否则投影会散到磁盘根目录。

## 目录
```
dsh-notebook/
├── lib/notebook.js     路径、JSON 真身、渲染、受管区块同步
├── lib/index.js        插件：路由、命令、启动同步（零外部依赖）
├── client.js           浏览器侧：侧栏一行 + 主面板（iframe 装 ui/index.html）
├── ui/index.html       管理界面（原生 JS，无构建）
├── test/smoke.mjs      冒烟测试
├── scripts/seed.mjs    为本项目播种并重建投影
├── agent.md            投影：通用经验本
├── project_agent.md    投影：项目经验本
├── cordis.patch.yml    挂载补丁
└── README.md
```

## 验证清单

**已验证**（`npm test`，全部通过）

- [x] 通用本渲染出索引与全文（确立条目才带全文）
- [x] 项目本按区渲染
- [x] 首次同步创建两个投影，带正确顺序的哨兵
- [x] 重复同步零改动（幂等）
- [x] 区块外用户内容逐字保留，不产生重复区块
- [x] 停用后纯投影文件被删除；有用户内容时只摘区块、不伤内容
- [x] 损坏 JSON 回退为空本而非抛错
- [x] 无区块的文件在移除时不动
- [x] `node --check` 通过（4 个模块）
- [x] 频率纯逻辑：轮次计数、到点判断、项目归属推断、消息形状（`test/reminder.mjs`，18 条断言）
- [x] 会话读取：159 个会话中按项目匹配出 3 个，标题、轮次、消息可解出

**已在 dsh 进程内验证**（`plugin_manager install_bundle` 之后，运行中的 desktop profile）

- [x] 插件被 cordis 加载：`/dsh-notebook/` 返回 200、`/dsh-notebook/nope` 返回 404（证明走 exact 页面路由而非旧 prefix）
- [x] JSON API 直连：`api/state` 返回项目路径、`enabled: true`、`origin: http://127.0.0.1:<宿主端口>`；`api/sync` 幂等返回 `unchanged/unchanged`；`api/review` 输出多行提示
- [x] 宿主 origin 从 `webServer.getOrigin()` 取到，配置里的 `port` 已删
- [x] `/notebook` 命令注册为 `CommandDefinition`，handler 返回 `{kind:'success', text}`（harness 覆盖）
- [x] 到点提醒的判定与入队形状（harness 以真实 payload 形状驱动：`payload.turn`、`agent.inbox.prepend('next-step', …)`、防重）
- [x] 提醒真的进了会话：第 13 轮在真实会话里收到 `<system-reminder>` 包裹的维护提示，消息被 V4 格式接受
- [x] `source.kind` 用 `plugin:dsh-notebook`；裸 `plugin` 会被 V4 拒收（`test/reminder.mjs` 已断言）
- [x] 运行时 `Session` 只有 `eventsSnapshot` 也能数轮次、认项目（`test/reminder.mjs` 三条断言）

**仍需人工确认**（只能在真实会话里看）

- [x] 模型收到提醒后确实去维护经验本：本轮收到提醒后写了 2 条通用本、2 条项目本，投影 `updated` 后复测 `unchanged`
- [ ] 加载器确实读到 `agent.md` / `project_agent.md`：开一个新会话，问"你的经验本里有什么"
- [ ] 停用后模型的上下文里确实看不到这两份本子
- [ ] 界面在桌面端浏览器里打开、编辑、保存的完整手测

## 风险

| 风险 | 处理 |
|---|---|
| 改 `cordis.patch.yml` 导致 dsh 起不来 | 交给 `plugin_manager install_bundle`，不手改；先备份 |
| `instructionFileCandidates` 覆盖掉默认值 | 显式写全 `AGENTS.md`、`CLAUDE.md`；用户层若也写，以用户层为准 |
| 路由端口假设错 | 端口一律问 `webServer.getOrigin()`，`config.port` 已删 |
| 误删用户文件 | 只在文件含本插件哨兵时才删除；否则只摘区块 |

## 下一步

1. 在 dsh 内重启实测，跑完"未验证"清单
2. 若加载器不认新候选名 → 改用受管区块写进 `AGENTS.md`（保留 D3/D4，只是换落点）
3. 加"条目命中统计"：模型每次引用某条时记一次，长期不命中的自动降级到候选
4. 跨项目复用：通用本真身已全局，下一步做"从多个项目本归纳候选 → 晋升通用"
