/**
 * 进程内的 mock CouchDB，只实现插件真正用到的那几个端点。
 *
 * 本机没有 CouchDB 也要能验证客户端逻辑——文档 id 编码、_bulk_docs 的 409 语义、
 * _all_docs 的前缀范围查、删除要带 _rev。这些恰恰是最容易写错、且错了以后
 * 「同步看起来在跑但数据对不上」的地方。
 *
 * **它不是 CouchDB 的完整实现**，只保证被测到的行为与真实 CouchDB 一致：
 * - `PUT /{db}` → 201，已存在 → 412
 * - `GET /{db}` → doc_count
 * - `POST /{db}/_bulk_docs` → 逐条 ok / conflict（已存在且未带 _rev）
 * - `POST /{db}/_all_docs?include_docs=true` + keys → 命中给 doc，未命中给 error
 * - `GET /{db}/_all_docs?startkey&endkey&limit` → 按 id 升序的范围查
 * - 认证：Basic，错了给 401
 */

import { createServer } from "node:http";

const USER = "admin";
const PASS = "secret-pass";

/**
 * 起一个 mock CouchDB。
 *
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void>, docs: Map<string, any>, user: string, pass: string }>}
 */
export async function startMockCouch() {
  /** db 名 → (docId → doc)。doc 形如 { _id, _rev, b, s, _deleted } */
  const databases = new Map();
  /** 每个库的变更序号，写一次 +1。真实 CouchDB 按文档算，这里够用。 */
  const seqs = new Map();
  /**
   * 收到过的请求（`METHOD path?query`），供测试断言**没有发出**某个参数。
   *
   * 「不该带 include_docs」这类约束只能这样验证：从响应上看不出区别，
   * 而带上它的后果是每轮把所有密文都下载一遍（流量与历史成正比、功能却完全正常）。
   */
  const requests = [];
  const seq = (dbName) => seqs.get(dbName) ?? 0;
  const bumpSeq = (dbName) => seqs.set(dbName, seq(dbName) + 1);

  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body ?? null));
    };

    const auth = req.headers.authorization ?? "";
    const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
    if (auth !== expected) {
      send(401, { error: "unauthorized", reason: "Name or password is incorrect." });
      return;
    }

    const url = new URL(req.url ?? "/", "http://mock");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const dbName = segments[0];
    const action = segments[1];

    if (!dbName) {
      send(404, { error: "not_found", reason: "missing" });
      return;
    }

    // PUT /{db} —— 建库
    if (req.method === "PUT" && !action) {
      if (databases.has(dbName)) {
        send(412, { error: "file_exists", reason: "The database could not be created." });
      } else {
        databases.set(dbName, new Map());
        send(201, { ok: true });
      }
      return;
    }

    // GET /{db} —— 库信息
    if (req.method === "GET" && !action) {
      const db = databases.get(dbName);
      if (!db) {
        send(404, { error: "not_found", reason: "no_db_file" });
        return;
      }
      const alive = [...db.values()].filter((doc) => !doc._deleted);
      send(200, { db_name: dbName, doc_count: alive.length, update_seq: String(seq(dbName)) });
      return;
    }

    const db = databases.get(dbName);
    if (!db) {
      send(404, { error: "not_found", reason: "no_db_file" });
      return;
    }

    // GET /{db}/_changes —— longpoll。mock 不真挂住：把「自 since 之后写过的 id」
    // 立刻返回，测试要的是协议形状与调用方的处理，不是等待行为本身。
    if (req.method === "GET" && action === "_changes") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const current = seq(dbName);
      const results =
        current > since
          ? [...db.keys()].map((id) => ({ id, seq: String(current) }))
          : [];
      send(200, { results, last_seq: String(current) });
      return;
    }

    let bodyText = "";
    req.on("data", (chunk) => {
      bodyText += chunk;
    });
    req.on("end", () => {
      const body = bodyText ? JSON.parse(bodyText) : {};

      // POST /{db}/_bulk_docs —— 写入 / 删除
      if (req.method === "POST" && action === "_bulk_docs") {
        const rows = (body.docs ?? []).map((doc) => {
          const existing = db.get(doc._id);
          if (doc._deleted) {
            if (!existing || existing._rev !== doc._rev) {
              return { id: doc._id, error: "conflict", reason: "Document update conflict." };
            }
            db.set(doc._id, { ...existing, _deleted: true, _rev: bump(existing._rev) });
            return { id: doc._id, ok: true, rev: bump(existing._rev) };
          }
          // 真实 CouchDB：已存在且未带 _rev → conflict
          if (existing && !existing._deleted && !doc._rev) {
            return { id: doc._id, error: "conflict", reason: "Document update conflict." };
          }
          const rev = existing ? bump(existing._rev) : "1-mock";
          db.set(doc._id, { ...doc, _rev: rev, _deleted: false });
          return { id: doc._id, ok: true, rev };
        });
        if (rows.some((row) => row.ok)) bumpSeq(dbName);
        send(201, rows);
        return;
      }

      if (action !== "_all_docs") {
        send(404, { error: "not_found", reason: "unsupported endpoint in mock" });
        return;
      }

      const includeDocs = url.searchParams.get("include_docs") === "true";

      // POST /{db}/_all_docs { keys } —— 按 key 批量读
      if (req.method === "POST") {
        const rows = (body.keys ?? []).map((key) => {
          const doc = db.get(key);
          if (!doc || doc._deleted) {
            return { key, error: "not_found" };
          }
          return {
            id: key,
            key,
            value: { rev: doc._rev },
            ...(includeDocs ? { doc } : {}),
          };
        });
        send(200, { total_rows: db.size, rows });
        return;
      }

      // GET /{db}/_all_docs?startkey&endkey&limit —— 范围列举
      const startKey = parseJsonParam(url.searchParams.get("startkey"));
      const endKey = parseJsonParam(url.searchParams.get("endkey"));
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const ids = [...db.keys()].sort();
      const rows = [];
      for (const id of ids) {
        const doc = db.get(id);
        if (doc._deleted) continue;
        if (startKey !== undefined && id < startKey) continue;
        if (endKey !== undefined && id > endKey) continue;
        rows.push({
          id,
          key: id,
          value: { rev: doc._rev },
          ...(includeDocs ? { doc } : {}),
        });
        if (rows.length >= limit) break;
      }
      send(200, { total_rows: db.size, rows });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    user: USER,
    pass: PASS,
    databases,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function bump(rev) {
  const n = Number(String(rev ?? "1-mock").split("-")[0]) || 1;
  return `${n + 1}-mock`;
}

function parseJsonParam(raw) {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
