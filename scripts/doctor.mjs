#!/usr/bin/env node
/**
 * 契约自检。零依赖，只用 Node 标准库。
 *
 * 它回答的是「这个包装进一念之后会不会被拒」，而不是「代码写得好不好」。检查三类：
 *
 * 1. **manifest**：必填字段、id / 版本格式、runtime.entry 存在、权限声明与
 *    contributes 的自洽性；
 * 2. **设置面板 schema**：字段 key 格式、类型专属必填项、`action` 指向的方法是否
 *    符合自定义方法命名规则、`visibleWhen` 引用的字段存在；
 * 3. **入口**：编译产物在不在，能不能被 import。
 *
 * 退出码 0 全过，1 有错误。警告不影响退出码。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 检查哪个包。默认是仓库自己，测试用 `--root` 指向临时目录。
 */
function resolveRoot() {
  const flag = process.argv.indexOf("--root");
  if (flag !== -1 && process.argv[flag + 1]) {
    return resolve(process.argv[flag + 1]);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const ROOT = resolveRoot();

/** 与一念契约 §3.1 一致。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const CUSTOM_METHOD_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const RESERVED_PREFIXES = [
  "plugin.",
  "config.",
  "sync.",
  "notify.",
  "hook.",
  "host.",
];

const FIELD_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "duration",
  "enum",
  "multi-enum",
  "action",
  "group",
  "note",
]);

const HOOK_TOPICS = new Set([
  "task.created",
  "task.updated",
  "task.completed",
  "task.reopened",
  "task.canceled",
  "task.deleted",
  "event.created",
  "event.updated",
  "event.canceled",
  "event.deleted",
  "schedule_block.created",
  "schedule_block.updated",
  "schedule_block.deleted",
]);

const SYNC_RESOURCES = new Set(["task", "event"]);

const SYNC_ACTIONS = new Set([
  "list",
  "get",
  "create",
  "update",
  "complete",
  "reopen",
  "cancel",
  "delete",
]);

const SYNC_FIELDS = new Set([
  "title",
  "notes",
  "due_at",
  "priority",
  "schedule",
  "subtasks",
  "tags",
  "recurrence",
]);

const SYNC_MODES = new Set(["interval", "manual", "eventDriven"]);

/** 日期标记类型，契约 §8.3。四个之外的取值宿主直接拒绝安装。 */
const DAY_MARK_KINDS = new Set([
  "lunar",
  "solar_term",
  "festival",
  "holiday",
]);

/** 宿主强制的间隔下限。 */
const MIN_INTERVAL_FLOOR = 60;

const errors = [];
const warnings = [];

const fail = (where, message) => errors.push(`${where}: ${message}`);
const warn = (where, message) => warnings.push(`${where}: ${message}`);

function readJson(relativePath) {
  const full = join(ROOT, relativePath);
  if (!existsSync(full)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(full, "utf8")) };
  } catch (error) {
    return { error: error.message };
  }
}

function checkManifest() {
  const { value: manifest, missing, error } = readJson("yinian-plugin.json");
  if (missing) {
    fail("yinian-plugin.json", "包根目录必须有 manifest");
    return null;
  }
  if (error) {
    fail("yinian-plugin.json", `不是合法 JSON：${error}`);
    return null;
  }

  const where = "yinian-plugin.json";
  if (manifest.manifestVersion !== 1) {
    fail(where, `manifestVersion 目前只支持 1，实际是 ${manifest.manifestVersion}`);
  }
  for (const key of ["id", "name", "version", "author", "minHostVersion"]) {
    if (typeof manifest[key] !== "string" || !manifest[key]) {
      fail(where, `缺少必填字段 ${key}`);
    }
  }
  if (manifest.id && !ID_PATTERN.test(manifest.id)) {
    fail(where, `id「${manifest.id}」不符合 ^[a-z0-9][a-z0-9-]{1,62}$`);
  }
  for (const key of ["version", "minHostVersion"]) {
    if (manifest[key] && !SEMVER_PATTERN.test(manifest[key])) {
      fail(where, `${key}「${manifest[key]}」不是合法 semver`);
    }
  }
  if (manifest.description && manifest.description.length > 200) {
    fail(where, "description 不能超过 200 字符");
  }
  if (manifest.homepage && !/^https?:\/\//.test(manifest.homepage)) {
    fail(where, "homepage 必须是 http/https 链接");
  }

  checkRuntime(manifest, where);
  checkPermissions(manifest, where);
  checkContributes(manifest, where);
  return manifest;
}

function checkRuntime(manifest, where) {
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== "object") {
    fail(where, "缺少 runtime");
    return;
  }
  if (runtime.kind !== "process") {
    fail(
      where,
      `runtime.kind 目前只支持 "process"，实际是「${runtime.kind}」——` +
        "宿主对未知 kind 会直接拒绝，不会静默降级",
    );
  }
  const entry = runtime.entry;
  if (!entry || typeof entry !== "object") {
    fail(where, "缺少 runtime.entry");
    return;
  }
  const target = entry[process.platform === "darwin" ? "macos" : process.platform] ?? entry.default;
  if (typeof target !== "string" || !target) {
    fail(where, "runtime.entry 需要当前平台的键或 default");
    return;
  }
  if (target.startsWith("/") || target.includes("..")) {
    fail(where, `runtime.entry「${target}」必须是不含 .. 的包内相对路径`);
    return;
  }
  if (!existsSync(join(ROOT, target))) {
    fail(
      where,
      `runtime.entry 指向的 ${target} 不存在——先跑 npm run build`,
    );
  }
}

function checkPermissions(manifest, where) {
  const permissions = manifest.permissions ?? {};
  for (const key of ["net", "spawn", "fs", "api"]) {
    const value = permissions[key];
    if (value !== undefined && !Array.isArray(value)) {
      fail(where, `permissions.${key} 必须是数组`);
    }
  }
  if (Array.isArray(permissions.net) && permissions.net.includes("*")) {
    warn(
      where,
      'permissions.net 声明了 "*"，安装界面会高亮告警。能列出具体域名就别用通配',
    );
  }
}

function checkContributes(manifest, where) {
  const contributes = manifest.contributes ?? {};

  // 契约 §3.4 的硬约束：什么都不贡献的插件永远不会被调用，装进去也是死的。
  // `syncStrategy` 与 `settingsPanel` 不算——它们是修饰别的扩展点的，自己不是入口
  const entryPoints = [
    "sync",
    "replica",
    "notificationChannel",
    "dayMarks",
    "hooks",
  ];
  const contributed = entryPoints.filter((key) => {
    const value = contributes[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  });
  if (contributed.length === 0) {
    fail(
      where,
      `contributes 至少要有一个扩展点（${entryPoints.join(" / ")}），否则插件永远不会被调用`,
    );
  }

  if (contributes.sync) {
    const sync = contributes.sync;
    const resources = Array.isArray(sync.resources) ? sync.resources : [];
    if (resources.length === 0) {
      fail(where, "contributes.sync 需要非空的 resources");
    }
    for (const resource of resources) {
      if (!SYNC_RESOURCES.has(resource)) {
        fail(where, `未知的 sync resource「${resource}」`);
      }
    }
    // 纯 event 插件不会收到 sync.push，也不吃 task 字段门控（一念 docs/11 §5.1.1）
    const eventOnly =
      resources.length > 0 && resources.every((item) => item === "event");

    const capabilities = sync.capabilities ?? {};
    if (!Array.isArray(capabilities.actions) || capabilities.actions.length === 0) {
      fail(where, "contributes.sync.capabilities.actions 不能为空");
    } else {
      for (const action of capabilities.actions) {
        if (!SYNC_ACTIONS.has(action)) {
          fail(where, `未知的 sync action「${action}」`);
        }
      }
      if (!capabilities.actions.includes("list")) {
        warn(where, "capabilities.actions 没有 list，宿主无法拉取，只能靠回写");
      }
      if (eventOnly) {
        const extra = capabilities.actions.filter((action) => action !== "list");
        if (extra.length > 0) {
          warn(
            where,
            `event 是 pull-only，「${extra.join("、")}」永远不会被调用，写 ["list"] 就够`,
          );
        }
      }
    }
    for (const field of capabilities.fields ?? []) {
      if (!SYNC_FIELDS.has(field)) {
        fail(where, `未知的 sync field「${field}」`);
      }
    }
    if (eventOnly && (capabilities.fields ?? []).length > 0) {
      warn(
        where,
        "capabilities.fields 是 task 字段的门控，纯 event 插件留空即可",
      );
    }
    if (!contributes.syncStrategy) {
      fail(where, "声明了 sync 就必须声明 syncStrategy");
    }
  }

  if (contributes.syncStrategy) {
    const strategy = contributes.syncStrategy;
    if (!contributes.sync) {
      warn(where, "声明了 syncStrategy 但没有 sync，策略不会生效");
    }
    if (!Array.isArray(strategy.modes) || strategy.modes.length === 0) {
      fail(where, "syncStrategy.modes 不能为空");
    } else {
      for (const mode of strategy.modes) {
        if (!SYNC_MODES.has(mode)) {
          fail(where, `未知的调度模式「${mode}」`);
        }
      }
    }
    if (
      typeof strategy.minIntervalSeconds === "number" &&
      strategy.minIntervalSeconds < MIN_INTERVAL_FLOOR
    ) {
      warn(
        where,
        `minIntervalSeconds=${strategy.minIntervalSeconds} 低于宿主硬下限 ` +
          `${MIN_INTERVAL_FLOOR}，会被抬到 ${MIN_INTERVAL_FLOOR}`,
      );
    }
  }

  // 多端同步传输（契约 §5.4）。**与 sync 互斥**：sync 接外部系统、replica 搬同步
  // 字节，两者在「远端删除了怎么办」上语义正好相反（sync 保留本地、replica 必须真删），
  // 混在一个插件里会让用户分不清它在同步什么，设置面板语义也完全不同。
  if (contributes.replica) {
    const replica = contributes.replica;
    if (contributes.sync) {
      fail(
        where,
        "contributes.sync 与 contributes.replica 不能同时声明：前者接外部系统、后者搬同步字节，语义相反",
      );
    }
    if (contributes.syncStrategy) {
      warn(
        where,
        "replica 不需要 syncStrategy：多端同步的调度由一念核心掌握，与 interval / manual 无关",
      );
    }
    for (const key of ["id", "name"]) {
      if (typeof replica[key] !== "string" || !replica[key].trim()) {
        fail(where, `contributes.replica 缺少 ${key}`);
      }
    }
    const capabilities = replica.capabilities ?? {};
    for (const key of ["watch", "delete"]) {
      if (key in capabilities && typeof capabilities[key] !== "boolean") {
        fail(where, `contributes.replica.capabilities.${key} 必须是 boolean`);
      }
    }
    if (capabilities.delete === false || capabilities.delete === undefined) {
      warn(
        where,
        "capabilities.delete 不为 true 时压实不可用，远端日志只增不减——界面上会如实提示用户",
      );
    }
    if ("maxObjectBytes" in capabilities) {
      const max = capabilities.maxObjectBytes;
      if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
        fail(
          where,
          "contributes.replica.capabilities.maxObjectBytes 必须是正数（解码后字节）",
        );
      }
    }
  }

  for (const topic of contributes.hooks ?? []) {
    if (!HOOK_TOPICS.has(topic)) {
      fail(where, `未知的 hook topic「${topic}」`);
    }
  }

  const channel = contributes.notificationChannel;
  if (channel) {
    for (const key of ["id", "name"]) {
      if (typeof channel[key] !== "string" || !channel[key]) {
        fail(where, `notificationChannel 缺少 ${key}`);
      }
    }
  }

  const dayMarks = contributes.dayMarks;
  if (dayMarks) {
    const providers = dayMarks.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
      fail(where, "contributes.dayMarks 需要非空的 providers");
    } else {
      const seen = new Set();
      for (const provider of providers) {
        if (!provider || typeof provider !== "object") {
          fail(where, "dayMarks.providers 的每一项必须是对象");
          continue;
        }
        for (const key of ["id", "name"]) {
          if (typeof provider[key] !== "string" || !provider[key]) {
            fail(where, `dayMarks.providers 里有一项缺少 ${key}`);
          }
        }
        // provider id 在插件内必须唯一：宿主对外用 `<pluginId>/<providerId>`，
        // 撞了之后两个 provider 的标记会互相覆盖，而且不报错
        if (typeof provider.id === "string" && provider.id) {
          if (seen.has(provider.id)) {
            fail(where, `dayMarks.providers 里 id「${provider.id}」重复`);
          }
          seen.add(provider.id);
        }
        const kinds = provider.kinds;
        if (!Array.isArray(kinds) || kinds.length === 0) {
          fail(
            where,
            `dayMarks.providers「${provider.id ?? "?"}」需要非空的 kinds`,
          );
        } else {
          for (const kind of kinds) {
            if (!DAY_MARK_KINDS.has(kind)) {
              fail(
                where,
                `未知的 dayMark kind「${kind}」，合法取值：${[...DAY_MARK_KINDS].join(" / ")}`,
              );
            }
          }
        }
        if (
          provider.coversUntil !== undefined &&
          !/^\d{4}-\d{2}-\d{2}$/.test(String(provider.coversUntil))
        ) {
          fail(
            where,
            `dayMarks.providers「${provider.id ?? "?"}」的 coversUntil 必须是 YYYY-MM-DD`,
          );
        }
        if (
          provider.region !== undefined &&
          !/^[A-Z]{2}$/.test(String(provider.region))
        ) {
          warn(
            where,
            `dayMarks.providers「${provider.id ?? "?"}」的 region 应该是 ISO 3166-1 alpha-2（如 CN / JP）`,
          );
        }
      }
    }
  }

  const panels = contributes.settingsPanel ?? [];
  if (!Array.isArray(panels)) {
    fail(where, "contributes.settingsPanel 必须是数组");
    return;
  }
  for (const panel of panels) {
    if (!existsSync(join(ROOT, panel))) {
      fail(where, `settingsPanel 里声明的 ${panel} 不存在`);
    }
  }
}

/** 收集入口文件里注册的方法名，用来核对 action 的 rpc 是否真的实现了。 */
function collectRegisteredMethods() {
  const entry = join(ROOT, "src", "main.mts");
  if (!existsSync(entry)) return null;
  const source = readFileSync(entry, "utf8");
  const methods = new Set();
  for (const match of source.matchAll(/"([a-zA-Z][a-zA-Z0-9_.]*)":\s*[a-zA-Z_$]/g)) {
    methods.add(match[1]);
  }
  return methods;
}

function checkSchemaFile(relativePath, registered) {
  const { value: schema, missing, error } = readJson(relativePath);
  if (missing || error) return;

  const where = relativePath;
  if (schema.scope !== "plugin" && schema.scope !== "integration") {
    fail(where, `scope 必须是 plugin 或 integration，实际是「${schema.scope}」`);
  }
  if (!Array.isArray(schema.fields)) {
    fail(where, "fields 必须是数组");
    return;
  }
  const expectedScope = relativePath.includes("integration") ? "integration" : "plugin";
  if (schema.scope !== expectedScope) {
    warn(where, `文件名暗示 scope 应该是 ${expectedScope}`);
  }

  const topLevelKeys = new Set(schema.fields.map((field) => field?.key));
  for (const field of schema.fields) {
    checkField(field, where, registered, topLevelKeys, false);
  }
}

function checkField(field, where, registered, siblingKeys, nested) {
  if (!field || typeof field !== "object") {
    fail(where, "字段必须是对象");
    return;
  }
  const label = field.key ?? "(无 key)";
  if (typeof field.key !== "string" || !FIELD_KEY_PATTERN.test(field.key)) {
    fail(where, `字段 key「${label}」不符合 ^[a-zA-Z][a-zA-Z0-9_]*$`);
  }
  if (!FIELD_TYPES.has(field.type)) {
    fail(where, `字段 ${label} 的类型「${field.type}」不受支持`);
    return;
  }
  if (typeof field.label !== "string" || !field.label) {
    fail(where, `字段 ${label} 缺少 label`);
  }

  switch (field.type) {
    case "action":
      if (typeof field.rpc !== "string" || !field.rpc) {
        fail(where, `action 字段 ${label} 必须声明 rpc`);
      } else {
        checkCustomMethod(field.rpc, where, label, registered);
      }
      break;

    case "note":
      if (typeof field.text !== "string" || !field.text) {
        fail(where, `note 字段 ${label} 必须有 text`);
      }
      break;

    case "group":
      if (!Array.isArray(field.fields) || field.fields.length === 0) {
        fail(where, `group 字段 ${label} 必须有非空 fields`);
      } else if (nested) {
        fail(where, `group 只能嵌一层，${label} 嵌得太深`);
      } else {
        const groupKeys = new Set(field.fields.map((child) => child?.key));
        for (const child of field.fields) {
          checkField(child, where, registered, groupKeys, true);
        }
      }
      break;

    case "enum":
    case "multi-enum":
      if (!Array.isArray(field.options) && typeof field.optionsFrom !== "string") {
        fail(where, `${field.type} 字段 ${label} 需要 options 或 optionsFrom`);
      }
      if (typeof field.optionsFrom === "string") {
        checkOptionsFrom(field.optionsFrom, where, label, registered);
      }
      break;

    default:
      break;
  }

  if (field.visibleWhen) {
    const target = field.visibleWhen.field;
    if (typeof target !== "string") {
      fail(where, `字段 ${label} 的 visibleWhen 缺少 field`);
    } else if (!siblingKeys.has(target)) {
      fail(
        where,
        `字段 ${label} 的 visibleWhen 指向「${target}」，同级里没有这个字段`,
      );
    }
  }
}

function checkCustomMethod(method, where, label, registered) {
  if (!CUSTOM_METHOD_PATTERN.test(method)) {
    fail(
      where,
      `${label} 的 rpc「${method}」不符合 ^[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)+$`,
    );
    return;
  }
  const reserved = RESERVED_PREFIXES.find((prefix) => method.startsWith(prefix));
  if (reserved) {
    fail(where, `${label} 的 rpc「${method}」用了宿主保留前缀 ${reserved}`);
    return;
  }
  if (registered && !registered.has(method)) {
    fail(
      where,
      `${label} 的 rpc「${method}」在 src/main.mts 里没有注册，点了会拿到「未实现的方法」`,
    );
  }
}

function checkOptionsFrom(source, where, label, registered) {
  if (source === "host:tags" || source === "host:calendars") return;
  if (source.startsWith("rpc:")) {
    checkCustomMethod(source.slice(4), where, label, registered);
    return;
  }
  fail(
    where,
    `${label} 的 optionsFrom「${source}」不受支持，只能是 host:tags / host:calendars / rpc:<method>`,
  );
}

/** manifest 声明了扩展点却没实现对应方法，装进去也不会工作。 */
function checkHandlersMatchContributes(manifest, registered) {
  if (!manifest || !registered) return;
  const contributes = manifest.contributes ?? {};
  const where = "src/main.mts";

  const required = [];
  if (contributes.sync) {
    required.push("sync.pull");
    const actions = contributes.sync.capabilities?.actions ?? [];
    if (actions.some((action) => action !== "list" && action !== "get")) {
      required.push("sync.push");
    }
  }
  if ((contributes.hooks ?? []).length > 0) required.push("hook.dispatch");
  if (contributes.notificationChannel) required.push("notify.send");
  if (contributes.dayMarks) required.push("dayMarks.list");

  for (const method of required) {
    if (!registered.has(method)) {
      fail(
        where,
        `manifest 声明了对应扩展点，但没有注册 ${method}——宿主调它会拿到「未实现的方法」`,
      );
    }
  }

  // 反向：注册了却没声明，宿主永远不会调
  if (registered.has("sync.pull") && !contributes.sync) {
    warn(where, "注册了 sync.pull 但 manifest 没声明 contributes.sync，不会被调用");
  }
  if (registered.has("hook.dispatch") && (contributes.hooks ?? []).length === 0) {
    warn(where, "注册了 hook.dispatch 但没订阅任何 topic，不会被调用");
  }
  if (registered.has("notify.send") && !contributes.notificationChannel) {
    warn(
      where,
      "注册了 notify.send 但没声明 notificationChannel，不会被调用",
    );
  }
  if (registered.has("dayMarks.list") && !contributes.dayMarks) {
    warn(where, "注册了 dayMarks.list 但没声明 contributes.dayMarks，不会被调用");
  }
}

/**
 * 权限声明与实际调用是否对得上。
 *
 * 一期没有沙箱，宿主**不会**在运行时拦住未声明的调用——所以这里查不出来的话，
 * 用户在安装界面看到的权限清单就是假的。这是启发式扫描（正则），只看得见明面上的
 * 调用；间接调用（比如经过一层封装的 http 客户端）扫不出来，所以查不出问题
 * 不等于声明是完整的。
 */
function checkPermissionUsage(manifest) {
  if (!manifest) return;
  const sources = readSourceFiles();
  if (sources.length === 0) return;

  const permissions = manifest.permissions ?? {};
  const where = "permissions";
  const declaredNet = (permissions.net ?? []).length > 0;
  const declaredSpawn = (permissions.spawn ?? []).length > 0;

  const probes = [
    {
      pattern: /\bfetch\s*\(/,
      declared: declaredNet,
      key: "net",
      what: "发起网络请求（fetch）",
    },
    {
      pattern: /\b(?:https?|node:https?)\b.*\.request\s*\(|\brequire\(["']https?["']\)/,
      declared: declaredNet,
      key: "net",
      what: "发起网络请求（http/https 模块）",
    },
    {
      // 只认 child_process 的调用形态。**不能写成 `\b(?:exec|spawn)\s*\(`**：
      // 那样 `/正则/.exec(s)` 和 `pattern.exec(s)` 也会中招，任何用正则的插件都会
      // 被误判成「执行外部命令」。所以要么是裸调用（import 进来的），要么是挂在
      // child_process / cp 这类模块对象上。
      pattern:
        /(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|\b(?:child_process|childProcess|cp)\.(?:spawn|spawnSync|exec|execFile|execSync)\s*\(|(?<![.\w$])exec\s*\(\s*["'`]/,
      declared: declaredSpawn,
      key: "spawn",
      what: "执行外部命令",
    },
  ];

  for (const probe of probes) {
    const hit = sources.find((file) => probe.pattern.test(file.text));
    if (hit && !probe.declared) {
      fail(
        where,
        `${hit.name} 里${probe.what}，但 permissions.${probe.key} 是空的——` +
          "安装界面会告诉用户「不需要这项权限」，那是假的",
      );
    }
  }

  // 反向：声明了却没用到，等于向用户多要了权限
  if (declaredNet && !sources.some((file) => /\bfetch\s*\(|\.request\s*\(/.test(file.text))) {
    warn(where, "声明了 net 权限但源码里没看到网络调用，考虑去掉");
  }
  if (
    declaredSpawn &&
    !sources.some((file) =>
      /(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(|\b(?:child_process|childProcess|cp)\.(?:spawn|exec|execFile)\s*\(/.test(
        file.text,
      ),
    )
  ) {
    warn(where, "声明了 spawn 权限但源码里没看到起子进程，考虑去掉");
  }
}

function readSourceFiles() {
  const dir = join(ROOT, "src");
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, name);
      } else if (/\.m?ts$/.test(entry.name)) {
        files.push({ name: `src/${name}`, text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir, "");
  return files;
}

function main() {
  const manifest = checkManifest();
  const registered = collectRegisteredMethods();

  for (const file of readdirSync(ROOT)) {
    if (/^settings\..*\.json$/.test(file)) {
      checkSchemaFile(file, registered);
    }
  }
  checkHandlersMatchContributes(manifest, registered);
  checkPermissionUsage(manifest);

  for (const message of warnings) console.warn(`[warn] ${message}`);
  for (const message of errors) console.error(`[error] ${message}`);

  if (errors.length > 0) {
    console.error(`\ndoctor 发现 ${errors.length} 个问题`);
    process.exitCode = 1;
    return;
  }
  console.log(
    warnings.length > 0
      ? `doctor 通过（${warnings.length} 条警告）`
      : "doctor 全绿",
  );
}

main();
