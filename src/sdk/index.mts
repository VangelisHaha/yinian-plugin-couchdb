/**
 * 一念插件 SDK。
 *
 * 契约版本 **PROTOCOL_VERSION = 1**，对应一念仓库
 * `docs/11-plugin-architecture.md`。契约的 source of truth 在那边，本 SDK 只是
 * 它的一个 TypeScript 实现——两者不一致时以文档为准。
 */

export {
  context,
  log,
  logger,
  progress,
  replicaChanged,
  replicaHeartbeat,
  setState,
  start,
  type Handler,
  type PluginContext,
  type PluginDefinition,
} from "./runtime.mjs";

export {
  isValidCustomMethod,
  MAX_STATE_BYTES,
  PROTOCOL_VERSION,
  TIMEOUTS,
  type ConfigScope,
  type HostLogParams,
  type LogLevel,
  type PluginInitParams,
} from "./protocol.mjs";

export type * from "./types.mjs";
