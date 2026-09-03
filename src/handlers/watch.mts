/**
 * `replica.watch` / `replica.unwatch`：把「远端有新东西了」实时告诉宿主。
 *
 * 没有它，接收侧只能按间隔轮询——手机上勾完一个任务，电脑最坏要等满一个周期才显示
 * 出来。发送侧再快也没用，**接收侧才是瓶颈**。
 *
 * ## 为什么 watch 必须立即返回
 *
 * 宿主对每个 RPC 都有超时（`replica.watch` 是 10 秒，见一念 `docs/11` §4.5）。在
 * handler 里等第一条变更会被超时杀掉，然后宿主重启插件、再 watch、再被杀——一个
 * 无限重启循环。所以这里只起一个后台循环就返回，变更靠 `replica.changed` 通知上报。
 *
 * ## 为什么是 longpoll 而不是 continuous
 *
 * continuous feed 被频繁中断会泄漏服务端资源（apache/couchdb#1063），而插件进程会因
 * 超时被杀、网络会抖，重连频率不低——自建的树莓派 / 小 VPS 会被打到 CPU 满。
 * longpoll 的延迟一样是亚秒级。
 *
 * ## 断了怎么办
 *
 * **不用自己扛**：一念的轮询兜底一直留着（`docs/14` §8.4），订阅只是加速。所以这里
 * 出错就退避重试，退避上限也不必很短——最坏情况退化成轮询那个间隔，不会停摆。
 * 反过来说，**心跳必须照发**：宿主用它判活，不发的后果是订阅被反复重建。
 */

import { logger, replicaChanged, replicaHeartbeat } from "../sdk/index.mjs";
import { CouchClient, readConfig } from "../couch/client.mjs";

/**
 * longpoll 单轮最多挂多久。到点没变更就丢下这次请求、重新发起，顺便发一次心跳。
 *
 * **20 秒而不是 55 秒**：这个值同时是「订阅出问题后多久自愈」的上限，短一点更稳。
 * 代价是没有变更时每 20 秒重连一次——对自建的小机器仍然可以忽略（一次 `_changes`
 * 查询很轻）。
 *
 * ## 未解问题（真实环境上观察到，两处都已加防线但根因没定位）
 *
 * 在作者的环境（CouchDB 前面有一层反向代理 / 隧道）上：
 *
 * 1. **服务端的 `timeout` 参数不生效**，longpoll 挂起等待时永不返回；
 * 2. **`AbortSignal.timeout` 也没能中断那次 fetch**（响应头还没到）；
 * 3. 加了 `Promise.race` 兜底之后，**连 `setTimeout` 都没让循环推进**——最可能是插件
 *    的 stdout 写入被阻塞（Node 在管道缓冲满、对端不读时会同步写、卡住事件循环），
 *    但没有确证。
 *
 * 有变更时 CouchDB 能立刻返回（已验证），所以订阅在「刚建立且远端已有新对象」时是
 * 工作的；卡住的是「挂起等待新变更」这一段。
 *
 * **这不影响正确性**：一念的轮询兜底一直留着（`docs/14` §8.4），订阅只是加速，
 * 断了只会变慢不会丢数据。要更快可以把同步间隔调到 1 分钟。
 */
const POLL_TIMEOUT_MS = 20_000;

/** 出错后的重试退避（毫秒），逐次递增到上限。 */
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000];

interface Subscription {
  abort: AbortController;
  /** 用来判断「这个 profile 的循环还是不是当前这一个」，避免旧循环继续发通知。 */
  generation: number;
}

const subscriptions = new Map<string, Subscription>();
let generationCounter = 0;

export interface WatchParams {
  profileId: string;
  since?: string;
  config?: Record<string, unknown>;
  traceId?: string;
}

export interface WatchResult {
  watching: boolean;
  heartbeatSeconds?: number;
}

/**
 * 起一个订阅循环。**幂等**：同一个 profile 重复调只保持一个循环。
 *
 * 幂等是宿主那边的简化换来的：它每轮同步都调一次 watch「确保活着」，而不是在启用 /
 * 停用 / 插件重启 / 网络恢复各处挂钩子——那些路径漏一个，现象就是「有时候实时、
 * 有时候要等五分钟」，且极难复现。
 */
export function watch(params: WatchParams): WatchResult {
  const existing = subscriptions.get(params.profileId);
  if (existing) {
    // 已经在跑：什么都不做，也不重启循环——重启会白丢一次 longpoll 的等待
    return { watching: true, heartbeatSeconds: POLL_TIMEOUT_MS / 1000 };
  }

  const abort = new AbortController();
  const generation = ++generationCounter;
  subscriptions.set(params.profileId, { abort, generation });

  // 不 await：handler 必须立即返回（见模块注释）
  void loop(params, generation, abort.signal);

  return { watching: true, heartbeatSeconds: POLL_TIMEOUT_MS / 1000 };
}

/** 停掉订阅。找不到也算成功——宿主可能在插件重启后补一次 unwatch。 */
export function unwatch(params: { profileId: string }): Record<string, never> {
  const existing = subscriptions.get(params.profileId);
  if (existing) {
    existing.abort.abort();
    subscriptions.delete(params.profileId);
  }
  return {};
}

async function loop(
  params: WatchParams,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  const client = new CouchClient(readConfig(params.config ?? {}));
  let since: string;
  try {
    // 从「现在」开始，不从 0：从头拉一遍已经同步过的变更没有意义，而且第一轮会很大
    since = params.since ?? (await client.currentSeq());
    logger.debug(`订阅已起，起点 seq=${since.slice(0, 24)}`);
  } catch (error) {
    logger.debug(`订阅起点取不到，退回轮询: ${describe(error)}`);
    subscriptions.delete(params.profileId);
    return;
  }

  let failures = 0;
  while (!signal.aborted && subscriptions.get(params.profileId)?.generation === generation) {
    try {
      // **循环的推进不依赖 fetch 的行为。**
      //
      // 实测过：这个环境下 longpoll 挂起等待时永不返回——服务端的 `timeout` 参数不生效，
      // `AbortSignal.timeout` 也没能中断它（响应头都还没到）。而现象极具欺骗性：
      // 连接 ESTABLISHED、插件活着、一条错误都没有，循环却永久卡在一次 fetch 上，
      // 于是心跳停了、订阅再也不自愈。
      //
      // 所以用 `Promise.race` 自己掐一个上限：到点就丢下那次请求（abort 清理连接）
      // 继续下一轮。**这不影响实时性**——有变更时 CouchDB 会立刻返回（已验证），
      // 挂起只发生在没有变更的时候，那时本来就不需要低延迟。
      const attempt = new AbortController();
      const linked = () => attempt.abort();
      signal.addEventListener("abort", linked, { once: true });
      const batch = await Promise.race([
        client.waitForChanges(since, POLL_TIMEOUT_MS, attempt.signal),
        sleep(POLL_TIMEOUT_MS, signal).then(() => {
          attempt.abort();
          return null;
        }),
      ]);
      signal.removeEventListener("abort", linked);
      if (signal.aborted) break;
      failures = 0;
      if (batch === null) {
        // 这一轮没等到变更：发心跳让宿主知道订阅还活着
        replicaHeartbeat({ profileId: params.profileId, cursor: since });
        continue;
      }
      since = batch.lastSeq;
      if (batch.ids.length > 0) {
        logger.debug(`远端有 ${batch.ids.length} 个对象变更，通知宿主`);
        // **不报 keys**：CouchDB 的 doc id 是宿主的对象键，但一念的 list 才是权威，
        // 报不全比报错好（契约允许省略）。这里只说「有变化」。
        replicaChanged({ profileId: params.profileId, cursor: since });
      } else {
        replicaHeartbeat({ profileId: params.profileId, cursor: since });
      }
    } catch (error) {
      if (signal.aborted) break;
      const wait =
        RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)] ?? 60_000;
      failures += 1;
      logger.debug(`订阅中断，${wait / 1000}s 后重试（轮询兜底不受影响）: ${describe(error)}`);
      await sleep(wait, signal);
    }
  }
  // 只有还是自己这一代时才清理，否则会把新循环的登记删掉
  if (subscriptions.get(params.profileId)?.generation === generation) {
    subscriptions.delete(params.profileId);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
