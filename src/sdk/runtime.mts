/**
 * 插件运行时：RPC 循环与宿主通知。
 *
 * 这是模板里唯一你**不需要改**的部分。它替你处理掉四件容易做错的事：
 *
 * 1. **stdout 只写协议帧**。任何 `console.log` 都会被宿主记成
 *    `PLUGIN_CONTRACT_VIOLATION`，所以 SDK 在启动时直接把 `console.*` 重定向到
 *    stderr——你照常用 `console.log` 调试，不会污染协议流。
 * 2. **一行一个 JSON**。响应里出现裸换行会把帧拆成两半，SDK 统一用
 *    `JSON.stringify` 单行输出。
 * 3. **异常一律转成 JSON-RPC error**。handler 里抛出去的东西不会让进程崩掉，
 *    宿主会收到一条带 message 的错误响应。
 * 4. **顺序**。同一插件的调用宿主是串行发的，但 handler 可能是 async，
 *    SDK 按收到顺序排队执行，不会让两个 handler 交叠。
 */

import { createInterface } from "node:readline";

import {
  MAX_STATE_BYTES,
  PROTOCOL_VERSION,
  type HostLogParams,
  type HostProgressParams,
  type HostSetStateParams,
  type LogLevel,
  type PluginInitParams,
  type RpcRequest,
} from "./protocol.mjs";

/** 一个方法的处理函数。返回值会被原样序列化成 `result`。 */
export type Handler = (params: any) => unknown | Promise<unknown>;

/** 插件在 `plugin.init` 之后能拿到的上下文。 */
export interface PluginContext {
  readonly pluginId: string;
  readonly integrationId: string | null;
  readonly hostVersion: string;
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly dataDir: string;
  readonly locale: string;
  readonly devMode: boolean;
  readonly config: Record<string, unknown>;
  readonly state: Record<string, unknown>;
}

/** JSON-RPC 保留的错误码区间之外，业务错误统一用这个。 */
const BUSINESS_ERROR_CODE = -32001;

let currentContext: PluginContext | null = null;

/**
 * 当前上下文。`plugin.init` 之前为 `null`。
 *
 * 别把它缓存进模块级变量：进程会被重启并**重放 `plugin.init`**，
 * 缓存下来的是上一轮的配置。
 */
export function context(): PluginContext {
  if (!currentContext) {
    throw new Error("plugin.init 还没到，此时没有上下文可用");
  }
  return currentContext;
}

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** 写一条插件日志。会落进该插件的日志文件与诊断面板。 */
export function log(params: HostLogParams): void {
  writeFrame({ jsonrpc: "2.0", method: "host.log", params });
}

export const logger = {
  debug: (message: string, extra?: Partial<HostLogParams>) =>
    log({ level: "debug", message, ...extra }),
  info: (message: string, extra?: Partial<HostLogParams>) =>
    log({ level: "info", message, ...extra }),
  warn: (message: string, extra?: Partial<HostLogParams>) =>
    log({ level: "warn", message, ...extra }),
  error: (message: string, extra?: Partial<HostLogParams>) =>
    log({ level: "error", message, ...extra }),
} satisfies Record<LogLevel, unknown>;

/** 汇报长任务进度。进诊断面板，不进日志文件。 */
export function progress(params: HostProgressParams): void {
  writeFrame({ jsonrpc: "2.0", method: "host.progress", params });
}

/**
 * 持久化游标与自定义状态。
 *
 * **这是插件唯一的持久化通道**（除了自己的 `dataDir`）。进程会因为超时、崩溃、
 * 改配置被重启，内存里的东西随时消失。
 *
 * `state` 序列化后超过 64KB 宿主会拒绝，所以这里先拦一次并给出可读的错误——
 * 让它静默失败的话，插件会以为状态存住了。
 */
export function setState(params: HostSetStateParams): void {
  if (params.state !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(params.state), "utf8");
    if (size > MAX_STATE_BYTES) {
      throw new Error(
        `host.setState 的 state 有 ${size} 字节，超过上限 ${MAX_STATE_BYTES}。` +
          `大块数据请写进 dataDir，state 里只放索引`,
      );
    }
  }
  writeFrame({ jsonrpc: "2.0", method: "host.setState", params });
}

// ─── 多端同步的实时上报（契约 §5.4.4）────────────────────────────────────────
//
// 只有 `contributes.replica` 且 `capabilities.watch = true` 的插件用得上这两个。
// `replica.watch` 必须**立即返回**，之后在自己的循环里等变更，用下面两个通知上报。

/**
 * 上报「远端有新对象」。
 *
 * `keys` 可以省略，表示「有变化，宿主自己去 `list`」——插件不必精确报出变了哪些对象，
 * 报不全比报错好，宿主的 `list` 才是权威。
 */
export function replicaChanged(params: {
  profileId: string;
  cursor?: string;
  keys?: string[];
}): void {
  writeFrame({ jsonrpc: "2.0", method: "replica.changed", params });
}

/**
 * 订阅存活心跳。**没有变更时也要发。**
 *
 * 宿主不对 `watch` 返回之后的静默期计时，改用心跳判活：连续 3 个心跳周期没收到就
 * 认为订阅已死，`unwatch` + 重新 `watch`。不发心跳的后果是订阅被反复重建。
 */
export function replicaHeartbeat(params: {
  profileId: string;
  cursor?: string;
}): void {
  writeFrame({ jsonrpc: "2.0", method: "replica.heartbeat", params });
}

/**
 * 把 console.* 重定向到 stderr。
 *
 * 不这么做的话，插件作者第一次 `console.log` 调试就会撞上
 * `PLUGIN_CONTRACT_VIOLATION`，而错误信息指向的是协议层，很难联想到是自己的
 * 调试语句。宿主会把 stderr 逐行收进插件日志，所以重定向之后调试输出照样看得到。
 */
function redirectConsole(): void {
  const toStderr =
    (prefix: string) =>
    (...args: unknown[]) => {
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      process.stderr.write(`${prefix}${text}\n`);
    };

  console.log = toStderr("");
  console.info = toStderr("");
  console.warn = toStderr("[warn] ");
  console.error = toStderr("[error] ");
  console.debug = toStderr("[debug] ");
}

export interface PluginDefinition {
  /** 插件版本，回给 `plugin.init`。建议直接读 manifest。 */
  version: string;
  /**
   * `plugin.init` 之后的额外初始化。
   *
   * **不要在这里做网络请求**：init 有 30 秒超时，而且每次进程重启都会重放。
   * 需要预热的东西放到第一次真正用到时再做。
   */
  onInit?: (context: PluginContext) => void | Promise<void>;
  /** `plugin.shutdown` 时的收尾。5 秒超时，超了会被 SIGKILL。 */
  onShutdown?: () => void | Promise<void>;
  /** 方法名 → 处理函数。含扩展点方法与你的自定义方法。 */
  handlers: Record<string, Handler>;
}

/**
 * 启动插件。
 *
 * 调用它之后进程会一直读 stdin 直到宿主关闭它，所以放在入口文件最后一行。
 */
export function start(definition: PluginDefinition): void {
  redirectConsole();

  const handlers: Record<string, Handler> = {
    "plugin.init": (params: PluginInitParams) => {
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        // 只警告不拒绝：宿主是兼容性的一方，插件硬失败会让用户完全用不了
        process.stderr.write(
          `[warn] 宿主协议版本 ${params.protocolVersion} 与 SDK 的 ${PROTOCOL_VERSION} 不一致\n`,
        );
      }
      currentContext = {
        pluginId: params.pluginId,
        integrationId: params.integrationId,
        hostVersion: params.hostVersion,
        apiBaseUrl: params.apiBaseUrl,
        apiToken: params.apiToken,
        dataDir: params.dataDir,
        locale: params.locale,
        devMode: params.devMode,
        config: params.config ?? {},
        state: (params.state ?? {}) as Record<string, unknown>,
      };
      const result = definition.onInit?.(currentContext);
      return Promise.resolve(result).then(() => ({
        ok: true,
        pluginVersion: definition.version,
      }));
    },

    "plugin.shutdown": async () => {
      await definition.onShutdown?.();
      // 先把响应发出去再退：宿主等这个确认，直接 exit 会让它记一次崩溃
      setTimeout(() => process.exit(0), 10);
      return { ok: true };
    },

    ...definition.handlers,
  };

  // 串行队列：宿主对同一插件是串行调用的，但 handler 是 async，
  // 不排队的话两个 handler 会交叠执行，共享状态就乱了
  let queue: Promise<void> = Promise.resolve();

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;

    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      process.stderr.write(`收到非法请求帧，已忽略: ${line.slice(0, 200)}\n`);
      return;
    }

    queue = queue.then(async () => {
      const handler = handlers[request.method];
      if (!handler) {
        writeFrame({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `未实现的方法: ${request.method}`,
          },
        });
        return;
      }
      try {
        const result = await handler(request.params ?? {});
        writeFrame({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        writeFrame({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: BUSINESS_ERROR_CODE,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  });

  // stdin 关掉说明宿主走了，没必要继续挂着
  lines.on("close", () => process.exit(0));
}
