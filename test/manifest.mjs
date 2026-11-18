/**
 * Manifest check: the bundle contract dsh enforces when it renders the plugin
 * card and when it mounts the patch. Text-only, no dsh required.
 *
 * @module dsh-notebook/test/manifest
 */

import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

let failed = 0;
function assert(cond, label, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const rel = (value) => String(value ?? "").replace(/^\.\//, "");

console.log("bundle 声明");
assert(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch 指向 cordis.patch.yml", pkg.dsh?.bundle?.patch);
assert(existsSync(join(root, "cordis.patch.yml")), "patch 文件存在");
const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
assert(patch.includes("dsh-notebook"), "patch 里有插件 insert 声明");
assert(patch.includes("instructionFileCandidates"), "patch 里补了指令候选");

console.log("exports");
assert(pkg.exports?.["."] === "./lib/index.js", "主入口导出");
assert(pkg.exports?.["./cordis.patch.yml"], "导出 patch");
assert(pkg.exports?.["./locale/*.json"], "导出 locale 通配", pkg.exports?.["./locale/*.json"]);
assert(pkg.exports?.["./icon"], "导出图标", pkg.exports?.["./icon"]);
assert(pkg.icon, "package.json 顶层 icon", pkg.icon);

console.log("图标");
const iconPath = join(root, rel(pkg.icon));
assert(existsSync(iconPath), "图标文件存在", pkg.icon);
if (existsSync(iconPath)) {
  const size = statSync(iconPath).size;
  assert(size > 0 && size <= 256 * 1024, "图标不超过 256KiB", size);
  const svg = await readFile(iconPath, "utf8");
  assert(svg.includes("<svg"), "图标是 SVG");
  assert(!/<script|foreignObject/i.test(svg), "图标不含脚本或外链对象");
}

console.log("locale");
for (const lang of ["en", "zh"]) {
  const path = join(root, "locale", `${lang}.json`);
  assert(existsSync(path), `locale/${lang}.json 存在`);
  if (!existsSync(path)) continue;
  const data = JSON.parse(await readFile(path, "utf8"));
  const title = data.meta?.title;
  const description = data.meta?.description;
  assert(typeof title === "string" && title.length > 0, `${lang} meta.title 非空`, title);
  // Only a latin title has a case to get wrong.
  if (/^[a-z]/.test(title ?? "")) assert(false, `${lang} meta.title 句首大写`, title);
  else console.log(`  ok   ${lang} meta.title 大小写规则（中文/首字母大写）`);
  assert(typeof description === "string" && description.length >= 40, `${lang} meta.description 足够具体`, description?.length);
  for (const word of ["json", "md"]) {
    assert(String(description).includes(word), `${lang} description 说明写了什么数据（${word}）`);
  }
  // The plugin page is where the manual lives: the detail document is one image,
  // so usage has to be spelled out in the description itself.
  for (const word of ["notebook", "agent.md"]) {
    assert(String(description).toLowerCase().includes(word), `${lang} description 提到 ${word}`);
  }
  assert(/项目根|项目根|Set 项目根|project root|Set /.test(String(description)), `${lang} description 写了从哪一步开始`);
  assert(existsSync(join(root, "docs", "DETAIL.md")), `${lang} 有详情文档可读`);
}

console.log("files 白名单");
const files = pkg.files ?? [];
for (const entry of ["lib", "ui", "locale", "docs", "cordis.patch.yml", "icon.svg"]) {
  assert(files.includes(entry), `files 含 ${entry}`);
}
assert(!files.some((entry) => entry.startsWith("test")), "files 不含 test");

console.log("详情页");
const detailPath = join(root, "docs", "DETAIL.md");
if (existsSync(detailPath)) {
  const detail = await readFile(detailPath, "utf8");
  assert(detail.length <= 1024 * 1024, "详情页不超过 1MiB", detail.length);
  // The page renders exactly one feature image, so the document is that one
  // image line — usage prose belongs in meta.description, not under the picture.
  assert(
    /^!\[[^\]]{8,}\]\(preview\.svg\)$/.test(detail.trim()),
    "详情页是单图行",
    JSON.stringify(detail.trim().slice(0, 50)),
  );
  const previewPath = join(root, "docs", "preview.svg");
  assert(existsSync(previewPath), "详情图存在");
  if (existsSync(previewPath)) {
    const preview = await readFile(previewPath, "utf8");
    assert(preview.includes('viewBox="0 0 640 300"'), "详情图按 640x300 绘制");
    assert(!/<script|foreignObject/i.test(preview), "详情图不含脚本或外链对象");
    assert(!/<text[\s>]/i.test(preview), "详情图不含 text 元素");
    assert(!/(href|src)=["']https?:/i.test(preview), "详情图不引用远程资源");
    assert(Buffer.byteLength(preview) <= 5 * 1024 * 1024, "详情图不超过 5MiB", Buffer.byteLength(preview));
  }
}

console.log("入口");
const entry = await readFile(join(root, "lib", "index.js"), "utf8");
assert(/export const name = "dsh-notebook"/.test(entry), "导出 name");
assert(/export function apply\(/.test(entry), "导出 apply");
assert(/export default/.test(entry), "默认导出插件对象");
assert(!/@deepseek-ai\//.test(entry), "不 import 宿主包，保持零依赖");

console.log("客户端");
assert(typeof pkg.exports?.["./client"] === "string", "exports 暴露 ./client");
assert(files.includes("client.js"), "files 含 client.js");
const clientCfg = pkg.dsh?.client;
assert(clientCfg !== undefined, "声明 dsh.client");
assert(clientCfg.platform === "web", "dsh.client.platform 为 web");
assert(Array.isArray(clientCfg.inject), "dsh.client.inject 是数组");
assert(Array.isArray(clientCfg.inject), "dsh.client.inject 是数组（root slot 靠 slots.inject 等声明，无需预置依赖）");

const clientPath = join(root, "client.js");
assert(existsSync(clientPath), "client.js 存在");
const client = await readFile(clientPath, "utf8");
assert(client.includes("window.__ModuleLoader__.load("), "以 ModuleLoader 方式注册");
assert(/id:\s*'dsh-notebook'/.test(client), "factory id 等于包名");
assert(client.includes("require('react')"), "React 来自浏览器模块表");
assert(client.includes("inject: ['slots']"), "声明 slots 依赖");
assert(client.includes("'sidebar.panellist'"), "注册侧栏行");
assert(client.includes("name: 'main'"), "注册主面板");
assert(/ctx\.effect\(/.test(client), "用 ctx.effect 挂清理");
assert(!/from\s*['"]@deepseek-ai\//.test(client), "client.js 不 import 宿主包");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
