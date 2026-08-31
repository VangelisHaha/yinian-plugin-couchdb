#!/usr/bin/env node
/**
 * 打一个可安装的插件 zip。
 *
 * 两条硬要求（宿主会拒收不合规的包）：
 *
 * - **解压后顶层就是包结构**，不能多包一层目录；
 * - 包内不得有 `..` 路径段。
 *
 * 用系统 `zip` 而不是引 JS 压缩库：这个仓库要保持零运行时依赖，而 macOS 与
 * Linux 都自带 zip。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "release");

/** 进包的东西。少一样宿主就装不起来，多一样就是把开发文件发给用户。 */
const CONTENTS = [
  "yinian-plugin.json",
  "dist",
  // 没有 settings.integration.json：replica 插件不产生同步实例（Integration），
  // 连接配置是插件级的一份，见 manifest 的 contributes.settingsPanel
  "settings.plugin.json",
  "README.md",
];

function main() {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "yinian-plugin.json"), "utf8"),
  );
  const name = `${manifest.id}-v${manifest.version}.zip`;

  for (const entry of CONTENTS) {
    if (!existsSync(join(ROOT, entry))) {
      console.error(`[error] 缺少 ${entry}${entry === "dist" ? "，先跑 npm run build" : ""}`);
      process.exitCode = 1;
      return;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, name);
  rmSync(target, { force: true });

  // -r 递归，-X 不带 macOS 扩展属性（否则包里会多出 __MACOSX）
  const result = spawnSync("zip", ["-r", "-X", "-q", target, ...CONTENTS], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("[error] zip 失败");
    process.exitCode = 1;
    return;
  }

  console.log(`已打包：${target}`);
  console.log(
    `发布时 Git tag 必须与 manifest 的 version 完全一致：v${manifest.version}`,
  );
}

main();
