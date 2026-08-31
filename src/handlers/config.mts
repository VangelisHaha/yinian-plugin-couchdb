/**
 * 配置校验与「测试连接」。
 *
 * `config.schema` 不实现：包里有 `settings.plugin.json` 静态文件，宿主直接读它。
 */

import type { ActionResult, ConfigValidateResult } from "../sdk/types.mjs";
import { CouchClient, CouchError, readConfig } from "../couch/client.mjs";

interface ValidateParams {
  config?: Record<string, unknown>;
}

/**
 * 形状校验，**不发网络请求**。
 *
 * 保存配置时会调它，而这时用户可能还没连上 VPN、CouchDB 也可能没开机——因为连不上
 * 就拒绝保存，会让人根本没法把配置存下来。连通性交给「测试连接」按钮，那是用户
 * 主动触发的。
 */
export function validate(params: ValidateParams): ConfigValidateResult {
  const config = params.config ?? {};
  const errors: Array<{ field?: string; message: string }> = [];

  const text = (key: string): string => {
    const value = config[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const endpoint = text("endpoint");
  if (!endpoint) {
    errors.push({ field: "endpoint", message: "请填写 CouchDB 地址" });
  } else if (!/^https?:\/\//i.test(endpoint)) {
    errors.push({
      field: "endpoint",
      message: "地址要以 http:// 或 https:// 开头",
    });
  } else if (/\/[^/]+\/?$/.test(endpoint.replace(/^https?:\/\//i, ""))) {
    // 常见误填：把数据库名也写进了地址。这会让所有请求 404，而报错信息指向数据库不存在
    errors.push({
      field: "endpoint",
      message: "只填到主机与端口，数据库名填在下面那栏",
    });
  }

  const database = text("database");
  if (!database) {
    errors.push({ field: "database", message: "请填写数据库名" });
  } else if (!/^[a-z][a-z0-9_$()+/-]*$/.test(database)) {
    errors.push({
      field: "database",
      message: "CouchDB 要求小写字母开头，只能含小写字母、数字与 _ $ ( ) + - /",
    });
  }

  if (!text("username")) {
    errors.push({ field: "username", message: "请填写用户名" });
  }
  if (!text("password")) {
    errors.push({ field: "password", message: "请填写密码" });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * 测试连接：建库（不存在时）+ 读库信息。
 *
 * 失败时返回可读的 message 而不是抛异常——抛出去用户看到的是一条 RPC 错误，
 * 而这里能明确说清是认证、权限还是网络。
 */
export async function testConnection(
  params: ValidateParams,
): Promise<ActionResult> {
  try {
    const client = new CouchClient(readConfig(params.config ?? {}));
    const info = await client.ping();
    return {
      message: `连接成功：数据库 ${info.database} 可读写，当前 ${info.docCount} 个对象。`,
    };
  } catch (error) {
    const message =
      error instanceof CouchError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { message: `连接失败：${message}` };
  }
}
