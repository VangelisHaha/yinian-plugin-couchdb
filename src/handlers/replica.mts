/**
 * `replica.*` 的四个必需方法（一念 `docs/11` §5.4.2）。
 *
 * 这一层薄得几乎没有逻辑，因为**契约要求插件不做任何业务判断**：
 *
 * - 不解释 `bytes`（它是 XChaCha20-Poly1305 密文，解释不了），日志里也不打它；
 * - 不改写 `key`（宿主生成、不含业务语义。改了换设备后就对不上）；
 * - `missing` 不当错误；
 * - `put` 幂等。
 *
 * 每次调用都从 `params.config` 现建 client：宿主可能在两次调用之间被改了配置，
 * 缓存 client 会让用户「改完地址还是连旧的」。建 client 不发请求，代价可忽略。
 */

import { logger } from "../sdk/index.mjs";
import type {
  ReplicaDeleteParams,
  ReplicaDeleteResult,
  ReplicaGetParams,
  ReplicaGetResult,
  ReplicaListParams,
  ReplicaListResult,
  ReplicaPutParams,
  ReplicaPutResult,
} from "../sdk/types.mjs";
import { CouchClient, readConfig } from "../couch/client.mjs";

function clientFrom(config: Record<string, unknown> | undefined): CouchClient {
  return new CouchClient(readConfig(config ?? {}));
}

export async function put(params: ReplicaPutParams): Promise<ReplicaPutResult> {
  const client = clientFrom(params.config);
  const objects = params.objects ?? [];
  const written = await client.bulkPut(
    objects.map((object) => ({ key: object.key, bytes: object.bytes })),
  );
  // 只记数量与 key，绝不记 bytes
  logger.debug(`已上传 ${written.length} 个对象`, {
    ...(params.traceId ? { traceId: params.traceId } : {}),
  });
  return { written };
}

export async function get(params: ReplicaGetParams): Promise<ReplicaGetResult> {
  const client = clientFrom(params.config);
  const fetched = await client.bulkGet(params.keys ?? []);
  const missing = fetched.filter((item) => item.missing).length;
  if (missing > 0) {
    // 缺失是正常情况（被别的设备压实掉了），记 debug 而不是 warn
    logger.debug(`${fetched.length} 个对象里有 ${missing} 个已不在远端`, {
      ...(params.traceId ? { traceId: params.traceId } : {}),
    });
  }
  return {
    objects: fetched.map((item) =>
      item.missing
        ? { key: item.key, missing: true }
        : { key: item.key, bytes: item.bytes ?? "" },
    ),
  };
}

export async function list(
  params: ReplicaListParams,
): Promise<ReplicaListResult> {
  const client = clientFrom(params.config);
  const limit = Number.isFinite(params.limit) && params.limit > 0
    ? Math.min(params.limit, 1000)
    : 100;
  const page = await client.list(params.prefix ?? "", params.since, limit);
  return {
    objects: page.objects,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    hasMore: page.hasMore,
  };
}

export async function remove(
  params: ReplicaDeleteParams,
): Promise<ReplicaDeleteResult> {
  const client = clientFrom(params.config);
  const deleted = await client.bulkDelete(params.keys ?? []);
  logger.info(`已删除 ${deleted.length} 个对象`, {
    ...(params.traceId ? { traceId: params.traceId } : {}),
  });
  return { deleted };
}
