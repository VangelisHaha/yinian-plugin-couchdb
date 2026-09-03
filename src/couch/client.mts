/**
 * CouchDB HTTP 客户端。
 *
 * 只用四个端点：`PUT /{db}`（建库）、`POST /{db}/_bulk_docs`（写/删）、
 * `POST /{db}/_all_docs`（按 key 批量读）、`GET /{db}/_all_docs`（按前缀范围列举）。
 *
 * # 为什么不用 CouchDB 的复制协议 / PouchDB
 *
 * 一念只把 CouchDB 当「带范围查询的对象存储」用（一念仓库 `docs/14` §8.1）。用了复制
 * 协议就绑死这一种后端，而 WebDAV 那条路得再写一套收敛逻辑——「换后端不动核心」当场作废。
 * 冲突判定 100% 在一念核心做字段级；这里一个业务判断都没有。
 *
 * # 不会产生 revision 冲突
 *
 * journal 分片是 immutable append-only 文档：写进去就不再修改，所以永远不撞
 * CouchDB 的文档级冲突模型。也正因为如此，`put` 遇到 409 conflict 时可以直接当成功
 * （见 `bulkPut`）。
 *
 * # 错误信息要先脱敏
 *
 * CouchDB 的错误体不带凭据，但 URL 里可能带（如果有人把账号密码写进了 endpoint）。
 * 所以这里的错误一律只输出状态码 + CouchDB 的 `reason`，**不回显完整 URL**——它会
 * 显示给用户，也会进日志。
 */


/** 连接配置，来自插件设置面板（secret 已由宿主解密注入）。 */
export interface CouchConfig {
  endpoint: string;
  database: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/** CouchDB 里一个对象文档。`_id` 就是宿主给的对象 key。 */
interface CouchDoc {
  _id: string;
  _rev?: string;
  /** base64 密文。字段名短是为了省远端空间——对象数量会很多。 */
  b?: string;
  /** 解码后字节数，`list` 用它回 `size`，免得为了报大小把内容整份读出来。 */
  s?: number;
  _deleted?: boolean;
}

interface BulkResultRow {
  id?: string;
  ok?: boolean;
  rev?: string;
  error?: string;
  reason?: string;
}

interface AllDocsRow {
  id?: string;
  key?: string;
  error?: string;
  value?: { rev?: string; deleted?: boolean };
  doc?: CouchDoc | null;
}

interface AllDocsResult {
  rows?: AllDocsRow[];
}

/** 传输失败。message 已脱敏，可直接显示给用户。 */
export class CouchError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CouchError";
    this.status = status;
  }
}

/**
 * 从宿主下发的 config 里读出连接参数并校验。
 *
 * 缺字段就报错而不是用空串去请求——后者会得到一个 401，用户看到的是「认证失败」，
 * 而真实原因是「没填地址」。
 */
export function readConfig(config: Record<string, unknown>): CouchConfig {
  const text = (key: string): string => {
    const value = config[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const endpoint = text("endpoint").replace(/\/+$/, "");
  const database = text("database") || "yinian_sync";
  const username = text("username");
  const password = text("password");

  const missing: string[] = [];
  if (!endpoint) missing.push("CouchDB 地址");
  if (!username) missing.push("用户名");
  if (!password) missing.push("密码");
  if (missing.length > 0) {
    throw new CouchError(`同步后端还没配好：缺少 ${missing.join("、")}`);
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new CouchError("CouchDB 地址必须以 http:// 或 https:// 开头");
  }

  const rawTimeout = config.timeoutSeconds;
  const seconds =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
      ? Math.min(Math.max(rawTimeout, 5), 60)
      : 30;

  return { endpoint, database, username, password, timeoutMs: seconds * 1000 };
}

export class CouchClient {
  private readonly config: CouchConfig;
  /** 建库只需成功一次，之后不再多发请求。进程重启会重来一次，代价可忽略。 */
  private databaseReady = false;

  constructor(config: CouchConfig) {
    this.config = config;
  }

  private authHeader(): string {
    const raw = `${this.config.username}:${this.config.password}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  private dbUrl(suffix = ""): string {
    // database 名可能含 `/`（CouchDB 允许），必须整体编码，否则会被当成路径分隔
    return `${this.config.endpoint}/${encodeURIComponent(this.config.database)}${suffix}`;
  }

  /**
   * 发一次请求。超时用 AbortSignal，**必须有**：自建机器可能连得上但不响应，
   * 没有超时会一直挂到宿主把整个插件进程杀掉。
   */
  private async request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json",
          ...(body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          // CouchDB 正常情况下只回 JSON；回了别的说明前面有代理在挡
          throw new CouchError(
            `远端返回了非 JSON 响应（HTTP ${response.status}），检查地址是否指向 CouchDB 本身`,
            response.status,
          );
        }
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof CouchError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new CouchError(
          `请求超时（${this.config.timeoutMs / 1000} 秒）：远端没有响应`,
        );
      }
      // 网络层错误的 message 常带完整 URL，脱敏后只保留归类
      throw new CouchError("连不上远端：请检查地址、端口与网络");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 等一批变更（`_changes?feed=longpoll`）。
   *
   * **用 longpoll 而不是 continuous**：continuous feed 被频繁中断会泄漏服务端资源
   * （apache/couchdb#1063），而插件进程会因超时被杀、网络会抖，重连频率不低——
   * 自建的树莓派 / 小 VPS 会被打到 CPU 满。longpoll 的延迟一样是亚秒级。
   *
   * 返回 `null` 表示这一轮没等到变更（到了 `timeoutMs` 上限）。调用方据此继续下一轮，
   * 顺便发一次心跳。
   *
   * **不复用 [`request`]**：那个方法的超时是给普通请求用的（默认几十秒），而这里要
   * 主动挂住等变更，两者的超时语义正好相反。
   */
  async waitForChanges(
    since: string,
    timeoutMs: number,
    abort: AbortSignal,
  ): Promise<{ lastSeq: string; ids: string[] } | null> {
    // **不要同时给 heartbeat 和 timeout。** CouchDB 里 heartbeat 优先、timeout 被忽略，
    // 于是连接永不超时——而我们靠「超时返回」来发心跳、也靠它在订阅出问题时自愈。
    // 踩过一次：加了 heartbeat 之后 longpoll 一次都没返回过（连超时都没有），
    // 实时订阅看起来建立成功、实际什么都收不到。
    const url = this.dbUrl(
      `/_changes?feed=longpoll&since=${encodeURIComponent(since)}&timeout=${timeoutMs}`,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: this.authHeader(), Accept: "application/json" },
        signal: abort,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return null;
      throw new CouchError("订阅远端变更失败：连不上远端");
    }
    const text = await response.text();
    if (!response.ok) {
      throw new CouchError(`订阅远端变更失败（HTTP ${response.status}）`, response.status);
    }
    let json: { last_seq?: unknown; results?: unknown };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // longpoll 超时后 CouchDB 也回一个合法 JSON，解析不了说明中间有代理在挡
      throw new CouchError("订阅远端变更失败：远端返回了非 JSON 响应");
    }
    const lastSeq = typeof json.last_seq === "string" ? json.last_seq : since;
    const results = Array.isArray(json.results) ? json.results : [];
    const ids = results
      .map((row) =>
        row && typeof row === "object" && "id" in row
          ? String((row as { id?: unknown }).id ?? "")
          : "",
      )
      .filter((id) => id.length > 0);
    return { lastSeq, ids };
  }

  /** 当前的变更序号，用来作为订阅起点。 */
  async currentSeq(): Promise<string> {
    const { status, json } = await this.request("GET", this.dbUrl());
    if (status !== 200) throw this.fail(status, json);
    const seq =
      json && typeof json === "object" && "update_seq" in json
        ? (json as { update_seq?: unknown }).update_seq
        : undefined;
    return typeof seq === "string" ? seq : "0";
  }

  /** 把 CouchDB 的错误体转成给用户看的一句话。**只取状态码与 reason**。 */  private fail(status: number, json: unknown): CouchError {
    const reason =
      json && typeof json === "object" && "reason" in json
        ? String((json as { reason?: unknown }).reason ?? "")
        : "";
    const hint =
      status === 401
        ? "用户名或密码不对"
        : status === 403
          ? "这个账号没有该数据库的权限"
          : status === 404
            ? "数据库不存在，且自动创建失败"
            : status === 413
              ? "远端拒绝了过大的请求"
              : "远端拒绝了请求";
    return new CouchError(
      reason ? `${hint}（HTTP ${status}：${reason}）` : `${hint}（HTTP ${status}）`,
      status,
    );
  }

  /**
   * 确保数据库存在。
   *
   * 自建场景下让用户先手动建库是没必要的摩擦，所以这里自动建。412 是「已存在」，
   * 不是错误。
   */
  async ensureDatabase(): Promise<void> {
    if (this.databaseReady) return;
    const { status, json } = await this.request("PUT", this.dbUrl());
    if (status === 201 || status === 202 || status === 412) {
      this.databaseReady = true;
      return;
    }
    throw this.fail(status, json);
  }

  /** 连通性与权限自检：建库 + 读一次库信息。 */
  async ping(): Promise<{ database: string; docCount: number }> {
    await this.ensureDatabase();
    const { status, json } = await this.request("GET", this.dbUrl());
    if (status !== 200) throw this.fail(status, json);
    const info = (json ?? {}) as { doc_count?: number };
    return {
      database: this.config.database,
      docCount: typeof info.doc_count === "number" ? info.doc_count : 0,
    };
  }

  /**
   * 批量写入对象。返回成功写入的 key。
   *
   * **409 conflict 视为成功**：对象是 immutable 的（journal 分片写进去就不再改），
   * 同 key 重复写只会发生在网络重试时，内容必然相同。契约要求 `put` 幂等
   * （一念 `docs/11` §5.4.2），把它当失败会让宿主白白退避并烧断路器。
   */
  async bulkPut(objects: Array<{ key: string; bytes: string }>): Promise<string[]> {
    if (objects.length === 0) return [];
    await this.ensureDatabase();

    const docs: CouchDoc[] = objects.map((object) => ({
      _id: object.key,
      b: object.bytes,
      s: decodedSize(object.bytes),
    }));
    const { status, json } = await this.request("POST", this.dbUrl("/_bulk_docs"), {
      docs,
    });
    if (status !== 201 && status !== 202) throw this.fail(status, json);

    const rows = Array.isArray(json) ? (json as BulkResultRow[]) : [];
    const written: string[] = [];
    const failures: string[] = [];
    for (const row of rows) {
      if (!row.id) continue;
      if (row.ok || row.error === "conflict") {
        written.push(row.id);
      } else {
        failures.push(`${row.id}: ${row.error ?? "unknown"}`);
      }
    }
    if (failures.length > 0) {
      throw new CouchError(`远端拒绝了 ${failures.length} 个对象的写入`);
    }
    return written;
  }

  /**
   * 批量读取对象。缺失的项返回 `missing: true`。
   *
   * **缺失不是错误**：对象被别的设备压实掉了是正常情况（契约 §5.4.2）。
   */
  async bulkGet(
    keys: string[],
  ): Promise<Array<{ key: string; bytes?: string; missing?: boolean }>> {
    if (keys.length === 0) return [];
    await this.ensureDatabase();

    const { status, json } = await this.request(
      "POST",
      this.dbUrl("/_all_docs?include_docs=true"),
      { keys },
    );
    if (status !== 200) throw this.fail(status, json);

    const rows = ((json ?? {}) as AllDocsResult).rows ?? [];
    const byKey = new Map<string, AllDocsRow>();
    for (const row of rows) {
      const key = row.key ?? row.id;
      if (key) byKey.set(key, row);
    }

    return keys.map((key) => {
      const row = byKey.get(key);
      const bytes = row?.doc?.b;
      // 已删除的文档 CouchDB 会回 value.deleted，doc 为 null——同样算 missing
      if (!row || row.error || !bytes) return { key, missing: true };
      return { key, bytes };
    });
  }

  /**
   * 按前缀列举对象键。`since` 是上次的游标，返回**严格大于**它的项。
   *
   * 用 `_all_docs` 的 startkey/endkey 范围查而不是 `skip`：skip 在大数据集上是线性扫，
   * 而 journal 会累积上万个分片。`since + "\u0000"` 是「紧接着 since 的下一个可能 key」，
   * 拿它当 startkey 就等于「> since」。
   *
   * 多取一条来判断 `hasMore`——比再发一次 count 请求便宜。
   */
  async list(
    prefix: string,
    since: string | undefined,
    limit: number,
  ): Promise<{
    objects: Array<{ key: string; size: number }>;
    cursor?: string;
    hasMore: boolean;
  }> {
    await this.ensureDatabase();

    const startKey = since && since > prefix ? `${since}\u0000` : prefix;
    // \ufff0 是个足够大的字符，覆盖 prefix 下所有 key；CouchDB 按 UTF-8 排序
    const endKey = `${prefix}\ufff0`;
    const query = new URLSearchParams({
      startkey: JSON.stringify(startKey),
      endkey: JSON.stringify(endKey),
      limit: String(limit + 1),
      include_docs: "true",
    });
    const { status, json } = await this.request(
      "GET",
      this.dbUrl(`/_all_docs?${query.toString()}`),
    );
    if (status !== 200) throw this.fail(status, json);

    const rows = ((json ?? {}) as AllDocsResult).rows ?? [];
    const objects: Array<{ key: string; size: number }> = [];
    for (const row of rows) {
      const key = row.id ?? row.key;
      // 设计文档以 _ 开头，不是同步对象；已删除的墓碑也跳过
      if (!key || key.startsWith("_") || row.value?.deleted) continue;
      objects.push({ key, size: row.doc?.s ?? decodedSize(row.doc?.b ?? "") });
    }

    const hasMore = objects.length > limit;
    const page = hasMore ? objects.slice(0, limit) : objects;
    const cursor = page.length > 0 ? page[page.length - 1]?.key : since;
    return {
      objects: page,
      ...(cursor === undefined ? {} : { cursor }),
      hasMore,
    };
  }

  /**
   * 删除对象（压实时用）。返回真正删掉的 key。
   *
   * CouchDB 删除要带 `_rev`，所以先批量读一次 rev 再批量删。不存在的 key 直接跳过——
   * 压实要删的东西可能已经被另一台设备删过了。
   */
  async bulkDelete(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    await this.ensureDatabase();

    const { status, json } = await this.request(
      "POST",
      this.dbUrl("/_all_docs"),
      { keys },
    );
    if (status !== 200) throw this.fail(status, json);

    const rows = ((json ?? {}) as AllDocsResult).rows ?? [];
    const docs: CouchDoc[] = [];
    for (const row of rows) {
      const key = row.key ?? row.id;
      const rev = row.value?.rev;
      if (!key || row.error || !rev || row.value?.deleted) continue;
      docs.push({ _id: key, _rev: rev, _deleted: true });
    }
    if (docs.length === 0) return [];

    const result = await this.request("POST", this.dbUrl("/_bulk_docs"), {
      docs,
    });
    if (result.status !== 201 && result.status !== 202) {
      throw this.fail(result.status, result.json);
    }
    const deleted: string[] = [];
    for (const row of (Array.isArray(result.json)
      ? (result.json as BulkResultRow[])
      : [])) {
      if (row.id && row.ok) deleted.push(row.id);
    }
    return deleted;
  }
}

/**
 * base64 字符串解码后的字节数，不真的解码。
 *
 * 只为了给 `list` 报 size。真解码一遍会把整份密文读进内存，而调用方只想知道大小。
 */
export function decodedSize(base64: string): number {
  const clean = base64.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}
