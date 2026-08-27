/**
 * ENG-1：tsc 的输出目录是 lib/types，包内代码用 `createRequire(...)('../package.json')`
 * 读版本号时解析落在 lib/（不存在）。build 后运行本脚本，把每个包的
 * package.json 镜像进其 lib/types/，使构建产物的运行时读取与发布语义一致。
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";

const roots = [];
for (const group of readdirSync("packages")) {
  for (const pkg of readdirSync(`packages/${group}`)) {
    roots.push(`packages/${group}/${pkg}/`);
  }
}
roots.push("apps/cli/");

let mirrored = 0;
for (const dir of roots) {
  const src = `${dir}package.json`;
  const dst = `${dir}lib/package.json`; // ../package.json 相对 lib/types/*.js 解析到 lib/
  if (existsSync(src)) {
    copyFileSync(src, dst);
    mirrored += 1;
  }
}
console.log(`[sync-built-package-json] mirrored ${mirrored} package.json -> lib/`);
