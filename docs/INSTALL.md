# 安装到 dsh-desktop

## 推荐路径：交给 dsh 自己装

```
plugin_manager  action=install_bundle  target=<本包绝对目录>
```

它会做三件事，正是下面手动步骤的全部内容：pnpm 把包链接进 profile 的 `node_modules`、在 profile `package.json` 里登记 `dependencies` 与 `dsh.profile.bundles`、把本包的 `cordis.patch.yml` 叠进层栈。

看返回值：`application: "applied"` 才算生效；`restart-required` 表示模块还没换到新代次，重启 dsh。`warnings` 非空要读一遍——覆盖（`overridden`）意味着更高层 patch 赢了，`agent-instructions` 的候选数组得由那一层补上。

装完重启 dsh，按文末四步验证。下面的手动流程是**备用方案**：只有在 `plugin_manager` 不可用、或需要离线/审计留痕时才走。

---

面向 Windows + 桌面端（Electron）。全部手动，约 5 分钟。**改动前先备份**，末尾有回滚。

---

## 0. 先备份

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json"      "$p\package.json.bak-notebook" -Force
Copy-Item "$p\cordis.patch.yml"  "$p\cordis.patch.yml.bak-notebook" -Force
```

---

## 1. 建立目录联结

dsh 从 **`~/.dsh/profiles/desktop/node_modules`** 解析插件包。本插件是源码目录，用联结（junction）挂进去——和 `dsh-purge` 的做法一样，它也是 `node_modules\dsh-purge -> ~/.dsh/plugin-src/dsh-purge`。

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-notebook" `
  -Target "<本包绝对目录>"  # 例如 D:\work\dsh-notebook
```

联结不需要管理员权限。如果提示"已存在"，先删掉旧链接（**只删链接，别删目标**）：

```powershell
[System.IO.Directory]::Delete("$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-notebook", $false)
```

验证：

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-notebook\lib\index.js"   # 应输出 True
```

---

## 2. 登记依赖与 bundle

编辑 **`~/.dsh/profiles/desktop/package.json`**，改两处。

**① `dependencies` 里加一行**（注意逗号和引号）：

```json
    "dsh-notebook": "file:<本包绝对目录>",
```

**② `dsh.profile.bundles` 数组里加一项**：

```json
      "dsh-notebook"
```

两处都要加。只加 bundles 不写 dependencies，下次 dsh 或 npm 整理依赖时可能把联结删掉；只写 dependencies 不写 bundles，包在但不会被加载。

> 编辑 JSON 时别用记事本，容易存成 UTF-16 带 BOM。用 VS Code，或 PowerShell 的 `Set-Content -Encoding utf8`。

---

## 3. 不需要手动改 `cordis.patch.yml`

插件的挂载声明在它自己的 `cordis.patch.yml` 里，进入 `bundles` 后 dsh 会把它作为一层配置自动叠上去。这一步是**反直觉的**，我最初也以为要手动合并——不用。

它会做两件事：
- 给 `agent-instructions` 补 `instructionFileCandidates`，让 `agent.md` / `project_agent.md` 被当成指令文件加载
- `insert` 本插件，带 `projectsRoot` 与 `port`

⚠️ **一处副作用**：它会**整体替换** `instructionFileCandidates` 数组。如果你的配置里已经自定义过这个值，会被覆盖。安装前确认一下：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml","$env:USERPROFILE\.dsh\cordis.patch.yml" -Pattern "instructionFileCandidates"
```

没有输出就说明你没改过，放心装。

---

## 4. 重启 dsh

插件的 `insert` **不会热生效**，必须完全退出再启动（托盘也要退）。

启动后看日志有没有 `dsh-notebook` 相关报错：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\logs" | Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 | Get-Content -Tail 80 | Select-String "notebook"
```

---

## 5. 验证（按顺序做，前一条不过就别看下一条）

**① 路由通不通**

端口由宿主决定，插件不假设。两种拿法：

- 在会话里发 `/notebook status`，输出里的「界面：」那行就是实测地址
- 或从 `~/.dsh/profiles/desktop/` 的运行日志里找 web 服务监听端口，再用 `http://127.0.0.1:<端口>/dsh-notebook/`

```
http://127.0.0.1:<端口>/dsh-notebook/
```

看到"会话历史 / 通用经验本 / 项目经验本"三栏就是通了。打不开说明插件没加载，或端口填错。

旁边还有一条自检：`http://127.0.0.1:<端口>/dsh-notebook/api/state?project=<项目绝对路径>` 应返回 `{"ok":true,...}`，里面的 `origin` 字段就是宿主自己报的 origin。

**② 开关能不能写盘**

页面上填项目路径 `<你的项目绝对路径>` → 载入 → 点开开关。然后：

```powershell
Get-ChildItem ".\agent.md",".\project_agent.md"          # 两个文件应出现
Get-Content ".\.dsh-notebook\state.json"                 # enabled 应为 true
```

**③ 模型读不读得到**

新开一个会话，问它："这个项目的经验本里，第一条不变量是什么？"

- 答得出 → 加载器认了新候选名，全链路通
- 答不出 → 见下面排查第 3 条

**④ 到点提醒会不会来（最后验）**

把更新频率改成"每轮"，然后随便聊两轮。第三轮开始时，模型应当自己提到要维护经验本。

> 提醒靠会话轮次计数，插件从会话事件里数 `turn/start`。如果模型毫无反应，说明 `agent.inbox` 那条没排上。

---

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面 404 | 插件没加载 | 查 `bundles` 是否加了、联结路径对不对；看日志报错。`/dsh-notebook/nope` 也返回 200 说明跑的是旧版 prefix 路由，重启换模块代次 |
| 端口连不上 | 猜错了端口 | 端口由宿主决定，跑 `/notebook status` 看它打印的实际 origin |
| 开关点了但没生成 md | 项目路径不对，或没权限写 | 用 `/notebook status` 看它认的路径是哪 |
| 模型读不到经验本 | 加载器没认新文件名 | 把插件 patch 里的 `instructionFileCandidates` 抄进 `~/.dsh/cordis.patch.yml` 的 `agent-instructions` 段（用户层优先级更高） |
| 提醒不来 | 项目没识别出来 | 确认会话第一条消息里写了项目绝对路径；或在插件 config 里设 `defaultProject` |
| dsh 起不来 | `package.json` JSON 写坏了 | 用备份覆盖回去 |

---

## 卸载 / 回滚

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json.bak-notebook"     "$p\package.json" -Force
Copy-Item "$p\cordis.patch.yml.bak-notebook" "$p\cordis.patch.yml" -Force
[System.IO.Directory]::Delete("$p\node_modules\dsh-notebook", $false)
```

再重启 dsh。项目目录里的 `agent.md` / `project_agent.md` 可以留着（它们只是普通 markdown），也可以删掉。

---

## 顺带：让插件先管起来

装好后建议第一件事是给已有项目起名字。界面左侧选项目 → 右侧填"项目名称" → 保存。

名字由模型按项目内容自取，会写进 `project_agent.md` 首行。目的是：十几年后你回来，或者换个新会话，一眼知道这份本子属于哪个项目、在干什么。
