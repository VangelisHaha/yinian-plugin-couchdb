/**
 * 一念插件协议的类型定义。
 *
 * 契约的 source of truth 是一念仓库的 `docs/11-plugin-architecture.md`。
 * 本文件对应 **PROTOCOL_VERSION = 1**；宿主在 `plugin.init` 里下发它实际使用的版本，
 * 与这里不一致时 SDK 会在 stderr 上警告（见 `runtime.mts`）。
 *
 * 只写协议层（帧、方法名、init 参数）。业务 DTO 在 `types.mts`。
 */

/** 本 SDK 实现的协议版本。 */
export const PROTOCOL_VERSION = 1;

/** 宿主 → 插件的请求帧。 */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** 插件 → 宿主的响应帧。 */
export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 插件 → 宿主的通知帧（不带 id，宿主不回响应）。 */
export interface RpcNotification {
  jsonrpc: "2.0";
  method: HostNotificationMethod;
  params: unknown;
}

/**
 * 插件可以主动发的通知。**不得主动发带 `id` 的请求帧。**
 *
 * 前三个是所有插件通用；后两个只有 `contributes.replica` 且 `capabilities.watch = true`
 * 的插件会用到（契约 §5.4.4）。
 */
export type HostNotificationMethod =
  | "host.log"
  | "host.progress"
  | "host.setState"
  | "replica.changed"
  | "replica.heartbeat";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface HostLogParams {
  level: LogLevel;
  message: string;
  /** 机器可判的码，进日志后可按它筛。 */
  code?: string;
  detail?: unknown;
  /** 当前调用的 traceId，用来把一次操作的日志串起来。 */
  traceId?: string;
}

export interface HostProgressParams {
  traceId: string;
  phase: string;
  current?: number;
  total?: number;
  message?: string;
}

export interface HostSetStateParams {
  integrationId?: string;
  cursor?: string;
  /** 必须是 JSON 对象，序列化后 ≤ 64KB。 */
  state?: Record<string, unknown>;
}

/** `host.setState` 的 state 上限，超了宿主会拒绝。 */
export const MAX_STATE_BYTES = 64 * 1024;

/** 配置作用域。插件级一份代码共用，实例级每个同步实例一份。 */
export type ConfigScope = "plugin" | "integration";

/** `plugin.init` 的参数。 */
export interface PluginInitParams {
  protocolVersion: number;
  hostVersion: string;
  pluginId: string;
  /** 只在「为某个 Integration 起的实例进程」里有值。 */
  integrationId: string | null;
  apiBaseUrl: string;
  /**
   * 只带 manifest 声明过的 scope。
   *
   * **不是**一念的 Agent token，**不要落盘、不要打日志**。
   */
  apiToken: string;
  /** 插件可以自由读写的目录。访问它不需要声明 fs 权限。 */
  dataDir: string;
  locale: string;
  logLevel: LogLevel;
  devMode: boolean;
  /**
   * 插件级与实例级配置合并后的结果，secret 已解密注入。
   *
   * **不要把它原样写进日志**，里面可能有明文凭据。
   */
  config: Record<string, unknown>;
  /** 上次 `host.setState` 存的东西。进程随时会被重启，状态只能从这里恢复。 */
  state: PluginState;
}

export interface PluginState {
  cursor?: string | null;
  [key: string]: unknown;
}

export interface PluginInitResult {
  ok: boolean;
  pluginVersion?: string;
}

export interface OkResult {
  ok: boolean;
  detail?: string;
}

/** 各方法的超时（毫秒），与契约 §4.5 一致。**只是给插件作者参考**，宿主才是执行方。 */
export const TIMEOUTS: Readonly<Record<string, number>> = Object.freeze({
  "plugin.init": 30_000,
  "config.validate": 30_000,
  "config.schema": 15_000,
  "sync.pull": 120_000,
  "sync.push": 120_000,
  "hook.dispatch": 30_000,
  "notify.send": 30_000,
  /**
   * 远小于其他调用，因为它**在 UI 路径上**——用户翻一页月视图就等着它。
   *
   * 所以别在这个调用里发网络请求：刷新放到自己的后台节奏里，`list` 只读本地缓存。
   * 它失败也不重试、不计入断路器（契约 §4.5）：标记是装饰性显示，
   * 重试只会让翻月卡住。
   */
  "dayMarks.list": 8_000,
  /**
   * 多端同步传输（契约 §5.4.5）。put/get 搬字节给得宽，list/delete 是元数据操作。
   *
   * **watch/unwatch 只有 10 秒**：它们只是开关订阅、不做 I/O 等待。返回之后的静默期
   * 宿主**不计时**，改用 `replica.heartbeat` 判活——这是它与所有其他 RPC 的唯一区别。
   */
  "replica.put": 60_000,
  "replica.get": 60_000,
  "replica.list": 30_000,
  "replica.delete": 30_000,
  "replica.watch": 10_000,
  "replica.unwatch": 10_000,
  "plugin.shutdown": 5_000,
  /** 自定义方法（含 action 与 optionsFrom）。 */
  custom: 15_000,
});

/**
 * 自定义方法名的规则，与契约 §4.2 一致。
 *
 * 形如 `feishu.testConnection`，且不得占用宿主保留的前缀。
 */
export const CUSTOM_METHOD_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * 宿主保留的方法前缀，与宿主 `plugin/protocol.rs` 的 `RESERVED_PREFIXES` 一一对应。
 *
 * 少一个的后果是：doctor 放行了一个自定义方法名，装进宿主却被判违规——报错发生在
 * 用户那边而不是开发期。
 */
export const RESERVED_METHOD_PREFIXES = [
  "plugin.",
  "config.",
  "sync.",
  "notify.",
  "hook.",
  "host.",
  "dayMarks.",
  "replica.",
] as const;

export function isValidCustomMethod(method: string): boolean {
  if (!CUSTOM_METHOD_PATTERN.test(method)) return false;
  return !RESERVED_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}
