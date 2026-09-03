/**
 * 对着 mock CouchDB 验证 replica 的四个必需方法。
 *
 * 覆盖的是「错了以后同步看起来在跑、但数据对不上」的那几处：
 * put 幂等、missing 不当错误、list 的前缀范围与 since 游标、delete 要带 _rev。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startMockCouch } from "./mockCouch.mjs";
import * as replica from "../dist/handlers/replica.mjs";
import * as config from "../dist/handlers/config.mjs";

/** base64 of "hello" 与 "world"，冒充密文——插件不解释内容，用什么都行。 */
const HELLO = Buffer.from("hello").toString("base64");
const WORLD = Buffer.from("world").toString("base64");

let couch;
/** 宿主每次调用都会带上 config，这里模拟那份配置。 */
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
  await couch.close();
});

describe("replica.put", () => {
  it("首次写入返回全部 key，并自动建库", async () => {
    const result = await replica.put({
      profileId: "p1",
      objects: [
        { key: "journals/aaaaaaaa/000000000001.pack", bytes: HELLO },
        { key: "meta.json", bytes: WORLD },
      ],
      config: cfg,
    });
    assert.deepEqual(result.written.sort(), [
      "journals/aaaaaaaa/000000000001.pack",
      "meta.json",
    ]);
  });

  it("重复写同一个 key 仍算成功（幂等）", async () => {
    // 契约要求 put 幂等：网络重试会真的发生，而 journal 分片内容不变。
    // 当成失败会让宿主白白退避并烧断路器。
    const result = await replica.put({
      profileId: "p1",
      objects: [{ key: "journals/aaaaaaaa/000000000001.pack", bytes: HELLO }],
      config: cfg,
    });
    assert.deepEqual(result.written, ["journals/aaaaaaaa/000000000001.pack"]);
  });

  it("空数组不发请求也不报错", async () => {
    const result = await replica.put({ profileId: "p1", objects: [], config: cfg });
    assert.deepEqual(result.written, []);
  });
});

describe("replica.get", () => {
  it("读回原样的 base64，不做任何转换", async () => {
    const result = await replica.get({
      profileId: "p1",
      keys: ["journals/aaaaaaaa/000000000001.pack"],
      config: cfg,
    });
    assert.equal(result.objects.length, 1);
    assert.equal(result.objects[0].bytes, HELLO);
    assert.notEqual(result.objects[0].missing, true);
  });

  it("缺失的对象标 missing 而不是报错", async () => {
    // 对象被别的设备压实掉了是正常情况（契约 §5.4.2）。返回 RPC 错误会白白
    // 触发退避与断路器。
    const result = await replica.get({
      profileId: "p1",
      keys: ["journals/zzzzzzzz/000000000999.pack"],
      config: cfg,
    });
    assert.equal(result.objects[0].missing, true);
    assert.equal(result.objects[0].bytes, undefined);
  });

  it("命中与缺失混在一起时按请求顺序返回", async () => {
    const result = await replica.get({
      profileId: "p1",
      keys: ["nope", "journals/aaaaaaaa/000000000001.pack"],
      config: cfg,
    });
    assert.equal(result.objects[0].key, "nope");
    assert.equal(result.objects[0].missing, true);
    assert.equal(result.objects[1].bytes, HELLO);
  });
});

describe("replica.list", () => {
  before(async () => {
    await replica.put({
      profileId: "p1",
      objects: [
        { key: "journals/aaaaaaaa/000000000002.pack", bytes: HELLO },
        { key: "journals/bbbbbbbb/000000000001.pack", bytes: WORLD },
      ],
      config: cfg,
    });
  });

  it("按前缀过滤，meta.json 不在 journals/ 里", async () => {
    const page = await replica.list({
      profileId: "p1",
      prefix: "journals/",
      limit: 100,
      config: cfg,
    });
    const keys = page.objects.map((o) => o.key);
    assert.ok(keys.every((k) => k.startsWith("journals/")), keys.join(","));
    assert.ok(!keys.includes("meta.json"));
    assert.equal(keys.length, 3);
  });

  it("按 key 升序返回并给出游标", async () => {
    const page = await replica.list({
      profileId: "p1",
      prefix: "journals/",
      limit: 100,
      config: cfg,
    });
    const keys = page.objects.map((o) => o.key);
    assert.deepEqual(keys, [...keys].sort(), "必须按 key 升序，宿主靠它续游标");
    assert.equal(page.cursor, keys[keys.length - 1]);
  });

  it("since 游标严格大于：不会重复给上一页最后一条", async () => {
    const first = await replica.list({
      profileId: "p1",
      prefix: "journals/",
      limit: 1,
      config: cfg,
    });
    assert.equal(first.objects.length, 1);
    assert.equal(first.hasMore, true);

    const second = await replica.list({
      profileId: "p1",
      prefix: "journals/",
      since: first.cursor,
      limit: 100,
      config: cfg,
    });
    const keys = second.objects.map((o) => o.key);
    assert.ok(
      !keys.includes(first.objects[0].key),
      "since 是「严格大于」，重复返回会让宿主反复回放同一条",
    );
  });

  it("列举只回键、不下载内容", async () => {
    // 这一条守着一个真实的、极隐蔽的缺陷：早先为了给宿主回 `size` 带了
    // `include_docs=true`，于是**每次列举都把这一页所有分片的密文整份下载一遍**——
    // 而宿主一处都不消费 size。远端 1700 个对象时是每 5 分钟一两 MB，且随历史线性
    // 增长。从响应上看不出任何异常，所以只能断言「请求里没有这个参数」。
    const before = couch.requests.length;
    const page = await replica.list({
      profileId: "p1",
      prefix: "journals/",
      limit: 100,
      config: cfg,
    });

    const listCalls = couch.requests
      .slice(before)
      .filter((line) => line.startsWith("GET") && line.includes("_all_docs"));
    assert.ok(listCalls.length > 0, "应该真的发过范围列举请求");
    for (const line of listCalls) {
      assert.ok(
        !line.includes("include_docs"),
        `列举绝不能下载对象内容: ${line}`,
      );
    }

    // 契约里 size 可省（一念 docs/11 §5.4.2），所以这里一个都不报
    assert.ok(page.objects.length > 0);
    assert.ok(
      page.objects.every((o) => o.size === undefined),
      JSON.stringify(page.objects),
    );
    assert.ok(page.objects.every((o) => typeof o.key === "string"));
  });

  it("翻到末尾时 hasMore 为 false", async () => {
    const page = await replica.list({
      profileId: "p1",
      prefix: "journals/",
      limit: 100,
      config: cfg,
    });
    assert.equal(page.hasMore, false);
  });
});

describe("replica.delete", () => {
  it("删掉存在的对象并返回它们", async () => {
    const key = "journals/bbbbbbbb/000000000001.pack";
    const result = await replica.remove({ profileId: "p1", keys: [key], config: cfg });
    assert.deepEqual(result.deleted, [key]);

    // 删完再读应为 missing
    const after = await replica.get({ profileId: "p1", keys: [key], config: cfg });
    assert.equal(after.objects[0].missing, true);
  });

  it("删不存在的对象不报错（可能已被别的设备删过）", async () => {
    const result = await replica.remove({
      profileId: "p1",
      keys: ["journals/zzzzzzzz/000000000999.pack"],
      config: cfg,
    });
    assert.deepEqual(result.deleted, []);
  });
});

describe("配置与连接", () => {
  it("测试连接成功时报出数据库与对象数", async () => {
    const result = await config.testConnection({ config: cfg });
    assert.match(result.message, /连接成功/);
    assert.match(result.message, /yinian_sync/);
  });

  it("密码错误时给出「用户名或密码不对」而不是堆栈", async () => {
    const result = await config.testConnection({
      config: { ...cfg, password: "wrong" },
    });
    assert.match(result.message, /连接失败/);
    assert.match(result.message, /用户名或密码不对/);
  });

  it("地址填了数据库名会被 validate 挡住", async () => {
    const result = config.validate({
      config: { ...cfg, endpoint: "https://couch.example.com/yinian_sync" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "endpoint"));
  });

  it("缺字段时逐项报错，不发网络请求", () => {
    const result = config.validate({ config: {} });
    assert.equal(result.ok, false);
    const fields = result.errors.map((e) => e.field).sort();
    assert.deepEqual(fields, ["database", "endpoint", "password", "username"]);
  });

  it("配置齐全时校验通过", () => {
    assert.deepEqual(config.validate({ config: cfg }), { ok: true });
  });

  it("库名不合 CouchDB 规则时报错", () => {
    const result = config.validate({ config: { ...cfg, database: "Yinian-Sync" } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "database"));
  });
});
