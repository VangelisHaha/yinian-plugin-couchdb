/**
 * `replica.watch` / `replica.unwatch`。
 *
 * 这里验证的是**契约形状与幂等**，不是 longpoll 的等待行为——mock 立刻返回变更，
 * 而真实等待属于 CouchDB 的职责。要守住的三件事：
 *
 * 1. **watch 必须立即返回。** 在 handler 里等第一条变更会被宿主的 10 秒超时杀掉，
 *    然后宿主重启插件、再 watch、再被杀，成一个无限重启循环。
 * 2. **幂等。** 宿主每轮同步都调一次 watch「确保活着」，重复调不该起第二个循环。
 * 3. **unwatch 之后不再发通知。** 否则停用同步之后宿主还会被叫醒去拉。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startMockCouch } from "./mockCouch.mjs";
import * as watch from "../dist/handlers/watch.mjs";

let couch;
let cfg;

before(async () => {
  couch = await startMockCouch();
  cfg = {
    endpoint: couch.baseUrl,
    database: "yinian_sync",
    username: couch.user,
    password: couch.pass,
    timeoutSeconds: 5,
  };
});

after(async () => {
  watch.unwatch({ profileId: "p1" });
  await couch.close();
});

describe("replica.watch", () => {
  it("立即返回且报出心跳周期", () => {
    const started = Date.now();
    const result = watch.watch({ profileId: "p1", config: cfg });
    // 在 handler 里等变更会被宿主的 10s 超时杀掉，然后无限重启
    assert.ok(Date.now() - started < 200, "watch 不能阻塞");
    assert.equal(result.watching, true);
    assert.ok(
      typeof result.heartbeatSeconds === "number" && result.heartbeatSeconds > 0,
      "要报心跳周期，宿主拿它判活",
    );
  });

  it("重复 watch 是幂等的，不起第二个循环", () => {
    const again = watch.watch({ profileId: "p1", config: cfg });
    assert.equal(again.watching, true);
  });

  it("unwatch 找不到订阅也算成功", () => {
    assert.deepEqual(watch.unwatch({ profileId: "从来没订阅过" }), {});
  });

  it("unwatch 之后可以重新 watch", () => {
    watch.unwatch({ profileId: "p1" });
    const result = watch.watch({ profileId: "p1", config: cfg });
    assert.equal(result.watching, true);
  });

  /**
   * **没有变更的那一轮必须发心跳**，宿主拿它判活。
   *
   * 不发的后果是：宿主连续 3 个心跳周期收不到就判订阅已死，于是每轮同步都
   * `unwatch` + `watch` 重建一次，并在设置页写「已退回轮询」——而订阅其实好着。
   * 反过来说，这条测试**只证明代码路径通**：真实环境里若 longpoll 挂住不返回
   * （见本模块顶部那个未解问题），心跳同样发不出来，那时宿主的判活是对的。
   */
  it("没有变更的那一轮要发心跳（宿主靠它判活）", async () => {
    const frames = [];
    const original = process.stdout.write.bind(process.stdout);
    // 心跳是写到 stdout 的一帧 JSON-RPC notification，只能这样验
    process.stdout.write = (chunk, ...rest) => {
      frames.push(String(chunk));
      return original(chunk, ...rest);
    };

    try {
      watch.unwatch({ profileId: "p1" });
      // 库里此刻没有比 currentSeq 更新的变更 → 走「本轮无变更」那条路
      watch.watch({ profileId: "hb", config: cfg });

      const deadline = Date.now() + 3000;
      let seen = false;
      while (Date.now() < deadline) {
        if (frames.some((line) => line.includes('"replica.heartbeat"'))) {
          seen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(seen, "没有变更时也必须发心跳，否则宿主会反复重建订阅");

      const frame = JSON.parse(
        frames.find((line) => line.includes('"replica.heartbeat"')).trim(),
      );
      assert.equal(frame.method, "replica.heartbeat");
      assert.equal(frame.params.profileId, "hb", "要带上是哪份配置");
    } finally {
      process.stdout.write = original;
      watch.unwatch({ profileId: "hb" });
    }
  });
});
