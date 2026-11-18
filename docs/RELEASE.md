# 发布与打包

面向"给别人用"的准备。下面每条都不是猜的，来源是本机已上架的两个插件（`dsh-pet`、`dsh-ops`）的包清单，以及 `dsh-pet` 的 `_comment` 里对商城契约的说明。

---

## 一、manifest 的硬性要求

### 必需：声明自己是 bundle

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

**这一项缺了，dsh 不会加载插件**——包在 `node_modules` 里、在 `bundles` 列表里，都不会被当成本插件。这是我们最早漏掉的一项。

### 必需：patch 文件可被宿主读到

```json
"exports": {
  ".": "./lib/index.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json"
}
```

### 建议：宿主版本下限

```json
"engines": {
  "node": ">=22.12.0",
  "dsh": ">=0.2.0-rc.1"
}
```

`dsh-pet` 用 `node: >=22.12.0`，`dsh-ops` 还额外写了 `dsh: ">=0.2.0-rc.2 <0.2.2-0"`。写区间比写单点更稳。

### 可选：兼容性声明（上商城才需要）

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "compatibility": {
    "dshReleases": { "0.2.1-rc.2": "compatible" }
  }
}
```

`dsh-pet` 的注释写明：**商城要求最新三个 dsh 版本里至少有一个 `compatible`**，只写宽泛范围不算证据。所以每次 dsh 升版，这里要跟着动。

---

## 二、`cordis.patch.yml` 的规则

| 规则 | 说明 |
|---|---|
| `id` 必须等于包名 | `dsh-pet` 的注释：商城预检按 `entryIds` 比对，裸名（如 `notebook`）会和其它插件的行冲突，判为"缺少 entry ID" |
| `id:` 那一行**不能写行尾注释** | 预检用正则抓该行的值并要求其后直接换行；写了注释会抓不到，整份被判 `SUBMISSION_ENTRY_MISSING` |
| 不要重复 insert 自己 | 已经以 bundle 身份加载后再 insert 一次会 `already queued` |
| 需要改别的插件配置时才写 `- id:` | 例如本插件给 `agent-instructions` 补候选名 |

---

## 三、`files` 白名单：什么进包，什么不进

当前白名单：

```
lib/  ui/  docs/{PLAN,INSTALL,RELEASE}.md  cordis.patch.yml  README.md  LICENSE
```

**明确不进包**：

| 路径 | 原因 |
|---|---|
| `test/` | 开发用，且需要 node 的测试环境；不占体积 |
| `scripts/seed.mjs` | 作者本地播种脚本，路径写死 |
| `.dsh-notebook/` | 作者自己的状态，含绝对路径 |
| `dsh-notebook.md` / `dsh-notebook-project.md` | 作者项目的投影；若进包，会给用户塞一份无关的经验本 |

`prepack` 挂了 `check` + `test`，`npm publish` 前会自动跑；挂了就别想发出去。

---

## 四、发布前自检

```bash
npm run check          # 四个模块语法
npm test               # 冒烟 + 频率逻辑
npm pack --dry-run     # 看真正会进包的文件清单
```

`npm pack --dry-run` 是唯一可靠的验证方式——`files` 写错时，只有这一步会告诉你。

发布：

```bash
npm version patch      # 或 minor / major
npm publish --access public
```

> 包里没有 `repository` / `homepage` 字段。上架前补上你自己的仓库地址，商城和 npm 页面都靠它。
> 也没有 `icon`。若要显示图标，放一张 ≤256 KiB 的 svg/png/jpg/webp 到包内，加 `"icon": "assets/icon.png"`；文件 realpath 必须留在包目录内（链接到外面会被拒）。

---

## 五、别人怎么装（三种）

**① 本地目录**（开发期，推荐）

```jsonc
// profiles/desktop/package.json
"dependencies": { "dsh-notebook": "file:D:/path/to/dsh-notebook" },
"dsh": { "profile": { "bundles": [ /* …, */ "dsh-notebook" ] } }
```

再建 junction 到 `profiles/desktop/node_modules/dsh-notebook`。

**② npm 包**

```jsonc
"dependencies": { "dsh-notebook": "^0.6.3" },
"dsh": { "profile": { "bundles": [ /* …, */ "dsh-notebook" ] } }
```

**③ tarball / git**

```jsonc
"dsh-notebook": "https://github.com/<you>/dsh-notebook/releases/latest/download/dsh-notebook.tgz"
"dsh-notebook": "github:<you>/dsh-notebook#v0.6.3"
```

三种都要做同一件事：**加入 `bundles`**。只装依赖不入 bundles，等于装了个不加载的包。

---

## 六、别人装之前要知道的事

1. **`instructionFileCandidates` 会被整体替换**。装之前若自己改过，需在用户层 patch 里写全。加进去的是 `dsh-notebook.md` 与 `dsh-notebook-project.md` 两个固定名——加载器只做精确文件名匹配，做不出"每个项目一个名字"。
2. **会在项目根生成两个 md**。`dsh-notebook.md` 与 `dsh-notebook-project.md`，只在该项目"开启"后出现，关闭即清除。
3. **`projectsRoot` 默认为空**，此时界面的项目下拉也是空的，需要自己填一个项目根（回车即存进 `$DSH_HOME/notebook/config.json`）。插件不会拿 dsh 的启动目录凑数——那个目录是 profile 本身，列出来全是 `node_modules` 之类。
4. **卸载会摘掉投影**：`remove_bundle` 或停用后，项目根那两个 md 里的受管区块会被移除，`.dsh-notebook/` 里的真身保留；重装或重新启用时按真身重建。
5. **旧版本留下的 `agent.md` / `project_agent.md` 会被自动清掉区块**。0.5.x 及更早用那两个通用名，升级后 `syncProject` 会先把旧区块摘掉再写新文件。整个文件只有本插件区块时直接删除，混着别人的字就只摘区块。
