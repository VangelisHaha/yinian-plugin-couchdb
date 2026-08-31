/**
 * 插件入口：把方法名映射到 handler。
 *
 * **这个插件只贡献 `replica` 一个扩展点**（多端同步的传输后端）。它不实现 `sync.*`——
 * 那是接外部系统（飞书、Apple 日历）的扩展点，与 replica 在「远端删除了怎么办」上语义
 * 正好相反，manifest 里两者互斥。
 *
 * 不在模块顶层做网络请求：模块加载发生在 `plugin.init` 之前，那时还没有配置。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { start } from "./sdk/index.mjs";
import * as config from "./handlers/config.mjs";
import * as replica from "./handlers/replica.mjs";

/** 版本只维护在 manifest 一处，避免和 package.json 漂移。 */
function readManifestVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/main.mjs → 包根目录
  const manifestPath = join(here, "..", "yinian-plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

start({
  version: readManifestVersion(),

  handlers: {
    // 多端同步传输：四个必需方法。watch/unwatch 未实现——manifest 里
    // capabilities.watch = false，宿主会退回轮询（一念 docs/14 §8.4 会在界面上标明时效）。
    "replica.put": replica.put,
    "replica.get": replica.get,
    "replica.list": replica.list,
    "replica.delete": replica.remove,

    // 配置
    "config.validate": config.validate,

    // 自定义方法：设置面板上的「测试连接」按钮
    "couchdb.testConnection": config.testConnection,
  },
});
