/**
 * 扩展点的业务类型。
 *
 * 与一念仓库 `docs/11-plugin-architecture.md` §5（同步）、§7（设置面板）、
 * §8（出站事件）逐字段对应。字段名就是线格式，**不要在这里改驼峰/下划线**——
 * 宿主按线格式反序列化，改了名就是契约违规（`PLUGIN_CONTRACT_VIOLATION`）。
 */

import type { ConfigScope } from "./protocol.mjs";

// ── 同步 ─────────────────────────────────────────────────────────────────

export type SyncResource = "task" | "event";

export type SyncActionKind =
  | "list"
  | "get"
  | "create"
  | "update"
  | "complete"
  | "reopen"
  | "cancel"
  | "delete";

export type SyncField =
  | "title"
  | "notes"
  | "due_at"
  | "priority"
  | "schedule"
  | "subtasks"
  | "tags"
  | "recurrence";

export type ExternalStatus = "todo" | "doing" | "done" | "canceled";

export type ExternalPriority = "none" | "low" | "medium" | "high";

/**
 * 外部系统的一条记录。
 *
 * 两个容易踩的点：
 *
 * - `completedAt` **不知道就不要传**。传当前时间会让历史任务全部堆在同一秒，
 *   一念的「今日完成」会瞬间多出几百条（`nikou-screen` 踩过）。
 * - `remoteUpdatedAt` 尽量给。宿主的字段级冲突判定靠它，缺了就只能保守处理。
 */
export interface ExternalItem {
  /** 外部系统主键，同一 Integration 内必须唯一且稳定。 */
  externalId: string;
  externalUrl?: string;
  title: string;
  notes?: string;
  status?: ExternalStatus;
  priority?: ExternalPriority;
  /** RFC3339。Deadline 语义：最晚什么时候完成。 */
  dueAt?: string;
  dueTimezone?: string;
  estimateMinutes?: number;
  /** 真实完成时间。不知道就别传。 */
  completedAt?: string;
  recurrenceRule?: string;
  parentExternalId?: string;
  tags?: string[];
  /**
   * 外部系统已经排好的排期段。
   *
   * `dueAt` 回答「最晚什么时候完成」，这个回答「打算什么时候做」——一念把两件事
   * 分开建模，日历上前者是 Deadline 细标记，后者才在时间轴上占一段。**只给 dueAt
   * 的任务在日历上永远只有一个标记。**
   *
   * 只有 manifest 的 `capabilities.fields` 里声明了 `schedule` 才生效。
   *
   * **缺省与空数组语义不同**：不传表示「这次不带排期信息」，宿主不动任何块；
   * 传 `[]` 表示「外部明确没有排期了」，宿主会清掉它建过的块。
   */
  schedule?: ExternalScheduleSlot[];
  /** 外部最后更新时间，RFC3339。 */
  remoteUpdatedAt?: string;
  /** 外部原始 JSON 全量。宿主会原样存下来，界面可以不展示。 */
  remoteData?: unknown;
  /**
   * 想让用户在任务详情「来源」区看到的额外字段。
   *
   * 一念的主模型只有所有待办系统都有的字段。你系统里独有的东西（空间、工作项类型、
   * 当前节点、负责人…）走这里：**你自己整理成「标签 + 值」，宿主原样展示**，
   * 核心不认识任何具体外部系统。
   *
   * **缺省与空数组语义不同**：不传表示「这次不带展示字段」，宿主保持上次的值；
   * 传 `[]` 表示「明确没有了」，宿主会清空。
   */
  details?: ExternalDetailField[];
}

/**
 * 一条展示字段。
 *
 * 宿主的硬限制（超出直接丢弃，不报错）：最多 20 条，`label` ≤ 32 字符，
 * `value` ≤ 512 字符，`label` 或 `value` 为空白的条目会被丢掉。
 */
export interface ExternalDetailField {
  /** 字段名，直接展示给用户。用人话，别用 API 字段名。 */
  label: string;
  /**
   * 已经格式化好的值。
   *
   * 时间戳、枚举 id、嵌套对象请**自己转成人能读的文本**——宿主不认识你的数据结构，
   * 传 `1755000000000` 用户就只能看到 `1755000000000`。
   */
  value: string;
  /**
   * 缺省 `text`。
   *
   * `link` 的 `value` 必须是 `http` / `https`，否则宿主会降级成纯文本展示。
   * 刻意只有这两种：内容来自第三方仓库，能渲染 HTML / Markdown 就等于交出 XSS 面。
   */
  kind?: "text" | "link";
}

/** 排期段状态，取值与一念的排期块一致。 */
export type ScheduleSlotStatus =
  | "planned"
  | "active"
  | "finished"
  | "unfinished"
  | "canceled";

/** 外部系统里的一段排期，落成一念 Task 的一个排期块。 */
export interface ExternalScheduleSlot {
  /**
   * 这一段在外部系统里的**稳定**标识，同一条 `ExternalItem` 内唯一。
   *
   * 宿主全靠它区分「同一段被改了时间」和「删一段又加一段」。给不稳定的值
   * （比如带上了开始时间）会让每轮同步都删旧块建新块，块上记的实际起止时间
   * 跟着丢，还会刷一堆出站事件。
   */
  externalRef: string;
  /** RFC3339。 */
  plannedStart: string;
  /** RFC3339，必须晚于 `plannedStart`。 */
  plannedEnd: string;
  status?: ScheduleSlotStatus;
  /** 段名（如「中台开发」）。一念的排期块不存名字，这里只进日志与诊断。 */
  title?: string;
}

export interface PullRequest {
  integrationId: string;
  traceId: string;
  resource: SyncResource;
  cursor?: string;
  /** RFC3339，增量下界。 */
  since?: string;
  /** 忽略游标做全量拉取。 */
  full: boolean;
  /**
   * 这个 Integration 的完整配置（插件级 + 实例级，宿主已合并，secret 已解密）。
   *
   * **用它，不要用 `context().config`**：一个插件进程服务该插件下的所有实例，
   * `plugin.init` 里那份配置代表不了具体某个实例。
   */
  config?: Record<string, unknown>;
}

export interface PullResult {
  items: ExternalItem[];
  /**
   * 外部日历容器（`resource: "event"` 用）。
   *
   * 不给也能用：宿主会建一个以 Integration 名命名的兜底日历，
   * 没有 `calendarExternalId` 的事件全部落在那里。只有一个日历的源（新股、节假日）
   * 不需要操心这一段。
   */
  calendars?: ExternalCalendar[];
  /** 外部事件（`resource: "event"` 用）。 */
  events?: ExternalEvent[];
  /**
   * `true` 表示本次 pull 的 `events` 就是这些日历的**完整集合**，
   * 宿主会把没出现的事件标成远端删除并置 `canceled`。
   *
   * 解决的问题：外部日历常常没有删除通知（新股上市后就从页面上消失了），
   * 逐条 diff 又要求插件自己记账。
   *
   * **三条约束**：只在最后一页生效（分页时以最后一轮为准）；
   * 增量源（只拉最近改动）**不要开**，否则每轮都会把历史事件全判成删除；
   * 与 `deletedExternalIds` 可以同时用，取并集。
   */
  eventsComplete?: boolean;
  cursor?: string;
  hasMore: boolean;
  /**
   * 外部已删除的 id。
   *
   * task：宿主**不会**删本地任务，只把关联标成 `remote_deleted` 等人处理——
   * 外部删除不该静默带走本地数据。
   * event：关联标 `remote_deleted` 且事件置 `canceled`（不软删，
   * 「这个会取消了」本身是用户要看到的信息）。
   */
  deletedExternalIds?: string[];
}

// ── Event 资源（pull-only，远端权威） ────────────────────────────────────
//
// 见一念仓库 docs/11-plugin-architecture.md §5.1.1。
//
// **宿主不会对 event 调 `sync.push`。** 外部日历一律落成只读日历，一念这侧改不了，
// 也就没有冲突判定与待确认导入。理由：外部日历里的事情是外部已经发生的事实
// （几号上市、会议改到几点），两边各改一半再 merge，结果和两边都不一致。

/** 外部事件状态。**与 task 的四态不同**：Event 没有「完成」，只会取消。 */
export type ExternalEventStatus = "active" | "canceled";

export type ExternalBusyStatus = "busy" | "tentative" | "free";

export type ExternalResponseStatus =
  | "needs_action"
  | "accepted"
  | "declined"
  | "tentative";

/**
 * 外部系统里的一个日历容器。
 *
 * 宿主按 `(integrationId, externalId)` upsert 成一念的日历行，用户可以在日历侧栏
 * 按来源逐个隐藏——**隐藏选择不会被同步覆盖**，远端改名只改名字。
 *
 * 刻意只有两个字段：pull-only 下让插件声明「这个日历可写」是空头承诺，
 * 宿主没有 event 的回写通道。外部日历恒为只读。
 */
export interface ExternalCalendar {
  /** 外部日历主键，同一 Integration 内唯一。 */
  externalId: string;
  /** 显示名，≤ 64 字符，超出截断。空白会被跳过（侧栏上是一行空白，认不出）。 */
  name: string;
}

/**
 * 外部日历里的一个事件。
 *
 * 时间形态**二选一**，混用的条目宿主会跳过并计入 `invalid`（其余条目照常落库）：
 *
 * - 定时：`allDay` 不传或 false，必须给 `startAt` / `endAt`
 * - 全天：`allDay: true`，必须给 `startDate` / `endDate`，**右开区间**
 */
export interface ExternalEvent {
  /**
   * 外部主键，同一 Integration 内唯一且稳定。
   *
   * **一条外部记录可以产多个事件**：一只新股有认购截止、暗盘、上市三个时点，
   * 这时自己拼稳定后缀（`02261:listing`）。不要用序号——顺序一变就全错位。
   */
  externalId: string;
  /** 归属的 `ExternalCalendar.externalId`。不给就落在兜底日历。 */
  calendarExternalId?: string;
  /** 给了它，事件详情就有「在你的插件里打开」按钮。 */
  externalUrl?: string;
  title: string;
  notes?: string;
  /** 缺省 `active`。 */
  status?: ExternalEventStatus;
  /** 缺省 false。 */
  allDay?: boolean;
  /** RFC3339，非全天必填。 */
  startAt?: string;
  /** RFC3339，非全天必填，必须晚于 `startAt`。 */
  endAt?: string;
  /** `YYYY-MM-DD`，全天必填。 */
  startDate?: string;
  /** `YYYY-MM-DD`，全天必填，**右开**：只占 8/20 要写 `2026-08-21`。 */
  endDate?: string;
  location?: string;
  /**
   * 缺省 `busy`。
   *
   * 信息类事件（新股上市、节假日、财报日）**建议给 `free`**，
   * 否则会把用户一整天标成忙，忙闲视图就没意义了。
   */
  busyStatus?: ExternalBusyStatus;
  /** 缺省 `accepted`。 */
  responseStatus?: ExternalResponseStatus;
  /** 缺省 **false**，与本地新建 Event 相反——同步来的事件不是你组织的。 */
  isOrganizer?: boolean;
  recurrenceRule?: string;
  /** RFC3339。有它宿主就能跳过没变化的事件，省一次写库。 */
  remoteUpdatedAt?: string;
  /** 外部原始 JSON 全量，宿主原样存下来。 */
  remoteData?: unknown;
  /** 事件详情「来源」区的展示字段，与 task 同一结构、同一限制。 */
  details?: ExternalDetailField[];
}

export interface PushRequest {
  integrationId: string;
  traceId: string;
  resource: SyncResource;
  action: SyncActionKind;
  /** `create` 时为空。 */
  externalId?: string;
  item: ExternalItem;
  /** 本次变更涉及的字段，供你做最小化更新。状态类动作为空数组。 */
  changedFields?: SyncField[];
  /** 这个 Integration 的完整配置，语义同 `PullRequest.config`。 */
  config?: Record<string, unknown>;
}

export interface PushResult {
  /**
   * `false` 表示你有意跳过（外部已经是目标状态）。
   *
   * 宿主视为成功且不重试，也不会开 ack 窗口——毕竟外部没被改动。
   */
  applied: boolean;
  externalId?: string;
  externalUrl?: string;
  remoteUpdatedAt?: string;
  remoteData?: unknown;
}

// ── 生命周期钩子 ─────────────────────────────────────────────────────────

export type HookTopic =
  | "task.created"
  | "task.updated"
  | "task.completed"
  | "task.reopened"
  | "task.canceled"
  | "task.deleted"
  | "event.created"
  | "event.updated"
  | "event.canceled"
  | "event.deleted"
  | "schedule_block.created"
  | "schedule_block.updated"
  | "schedule_block.deleted";

export type EntityKind = "task" | "event" | "schedule_block";

export interface EntityRef {
  type: EntityKind;
  id: string;
}

export interface HookEvent {
  /**
   * 发件箱记录 id。
   *
   * **必须按它做幂等**：投递保证是「至少一次」，重试与宿主重启都会让同一条事件
   * 再来一遍。把处理过的 id 存进 `host.setState`，别只放内存——进程随时会被重启。
   */
  outboxId: string;
  traceId: string;
  topic: HookTopic;
  /** 业务实际发生时间，不是派发时间。 */
  occurredAt: string;
  entity: EntityRef;
  payload: {
    /** 变更后的实体全量快照（线格式）。 */
    snapshot?: Record<string, unknown>;
    changedFields?: string[];
  };
}

export interface HookResult {
  ok: boolean;
  detail?: string;
}

// ── 通知渠道 ─────────────────────────────────────────────────────────────

export type NotificationKind =
  | "task_due"
  | "task_completed"
  | "schedule_start"
  | "event_start"
  | "sync_failed"
  | "custom";

export interface NotificationAction {
  id: string;
  label: string;
}

/** 明细里的一行。`value` 是宿主**已经格式化好的**字符串，直接印。 */
export interface NotificationField {
  label: string;
  value: string;
}

/**
 * 给富消息渠道的明细（契约 §8.2）。
 *
 * `title` / `body` 是为系统通知栏那两行字准备的；飞书卡片、企微图文有更大的版面，
 * 只印这两行等于浪费掉。
 *
 * **`fields` 的值不要再解析。** 时区转换、全天右开区间、跨天段、只到日期的截止，
 * 宿主已经按本机时区处理好了；渠道自己算一遍必然会写歪，而写歪的表现是用户收到
 * 一个错的时间且毫无提示。要做视觉强调用 `priority` 与 `overdue`。
 *
 * `kind: "custom"`（比如设置页的测试通知）没有宿主实体，**不会带 detail**。
 */
export interface NotificationDetail {
  /** 事项本体标题，不含段名。`Notification.title` 是 `subject · label` 的合成结果。 */
  subject: string;
  /** 排期块的段名（「中台开发」），其余类型没有。 */
  label?: string;
  /** 只有 Task 与排期块有。事件是 `undefined`，不是 `"none"`。 */
  priority?: "none" | "low" | "medium" | "high";
  /** 锚点是否已经过去。 */
  overdue?: boolean;
  /**
   * `yinian://open/{task|event}/{id}`，唤起一念并打开该事项。
   *
   * **由宿主生成，不要自己拼 scheme。** 排期块给的是所属任务的链接（§8.2.1）。
   */
  deepLink?: string;
  fields?: NotificationField[];
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  entity?: EntityRef;
  /** 只有 manifest 里声明了 `supportsActions` 的渠道才会收到。 */
  actions?: NotificationAction[];
  /** 富消息渠道用的明细。系统通知栏那种渠道可以完全忽略它。 */
  detail?: NotificationDetail;
}

export interface NotifyRequest {
  traceId: string;
  notification: Notification;
}

export interface NotifyResult {
  delivered: boolean;
  detail?: string;
}

// ── 日期标记 ─────────────────────────────────────────────────────────────
//
// 见一念仓库 docs/11-plugin-architecture.md §8.3。
//
// 日期标记是挂在**某一天**上的公开日历知识：农历日序、二十四节气、传统与公历节日、
// 法定假日与调休上班。它不属于任何用户，**不进宿主数据库、永不参与同步**——
// 给定日期就能算出来或查出来。

/**
 * 标记类型。**这就是界面上的开关粒度**，用户可以只要休 / 班而不要圣诞节。
 *
 * `festival` 与 `holiday` 刻意分开：春节是**一天**、春节假期是**七天**，
 * 混成一类就没法只显示放假安排而不显示节日名。
 */
export type DayMarkKind = "lunar" | "solar_term" | "festival" | "holiday";

/** 这天是休还是班。**`kind: "holiday"` 必须给。** */
export type DayRest = "off" | "work";

/** 一条日期标记。 */
export interface DayMark {
  /**
   * 本地日期键，**严格** `YYYY-MM-DD`。
   *
   * `2026-8-1` 会被宿主拒（`PLUGIN_CONTRACT_VIOLATION`）：它当 Map key 时和
   * `2026-08-01` 对不上，界面表现为「有几天没有农历」而且不报错。
   */
  date: string;
  kind: DayMarkKind;
  /**
   * 紧凑标签，月视图格子里显示的就是它，**2–3 字**。
   *
   * 更长的会被省略号截掉——那一格宽度只有 100 出头像素，还要和日期数字、
   * 休班角标、负载数字挤在同一行。
   */
  label: string;
  /** 长文案，给 Agenda 与日期详情。与 `label` 相同时不必给。 */
  detail?: string;
  /**
   * `off` 放假 / `work` 调休上班。
   *
   * **周末也可能是上班日**，这正是它必须被显示出来的原因。
   */
  rest?: DayRest;
}

/**
 * provider 声明。与 manifest 的 `contributes.dayMarks.providers` 同形。
 *
 * 在 `dayMarks.list` 的结果里回传它，可以**动态更新覆盖范围**——比如联网拉到了
 * 次年的放假安排，`coversUntil` 就该往后延。省略时宿主沿用 manifest 的声明。
 */
export interface DayMarkProviderSpec {
  id: string;
  /** 展示名。**宿主不翻译它**——「日本の祝日」该按原样显示。 */
  name: string;
  kinds: DayMarkKind[];
  /** ISO 3166-1 alpha-2。跨地区的（农历）留空。 */
  region?: string;
  /**
   * 数据覆盖到哪天（`YYYY-MM-DD`）。
   *
   * **留空表示「算得出来」**（农历、节气按天文算法算，任意年份都有）；
   * 有值表示「数据只到那天」（法定假日是按年公布的），超出的日子宿主会提示
   * 「安排尚未公布」。
   *
   * 把「查不到」当成「那天不放假」是这个扩展点最容易犯的错：用户会照着一张错的
   * 日历排期，而界面上没有任何异常。
   */
  coversUntil?: string;
}

export interface DayMarksListRequest {
  /** 要问哪个 provider，对应 manifest 里声明的 `id`。 */
  providerId: string;
  /** 闭区间起点，`YYYY-MM-DD`。 */
  from: string;
  /** 闭区间终点，`YYYY-MM-DD`。**闭区间**：月视图要的就是那 42 个格子。 */
  to: string;
}

export interface DayMarksListResult {
  /**
   * 区间内的全部标记。**允许为空**——「这段时间没有节日」不是错误。
   *
   * 同一天可以给多条（清明既是节气又是节日又是假期），宿主负责排序与择一显示，
   * 你不需要操心优先级。
   */
  marks: DayMark[];
  /** 可选，用来动态更新覆盖范围。 */
  providers?: DayMarkProviderSpec[];
}

// ── 设置面板 ─────────────────────────────────────────────────────────────

export type SettingsFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "duration"
  | "enum"
  | "multi-enum"
  | "action"
  | "group"
  | "note";

export interface SettingsFieldOption {
  value: unknown;
  label: string;
}

export interface SettingsField {
  /** `^[a-zA-Z][a-zA-Z0-9_]*$` */
  key: string;
  type: SettingsFieldType;
  label: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  /** 只支持一层判断。隐藏的字段不参与必填校验，也不提交。 */
  visibleWhen?: { field: string; equals: unknown };
  /** `secret` 落加密存储且永不回显。 */
  format?: "text" | "url" | "path" | "secret";
  placeholder?: string;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: "seconds" | "minutes";
  options?: SettingsFieldOption[];
  /** `host:tags` / `host:calendars` / `rpc:<自定义方法>` */
  optionsFrom?: string;
  maxItems?: number;
  /** `action` 必填：点按钮时调的自定义方法。 */
  rpc?: string;
  confirm?: string;
  /** `group` 必填。 */
  fields?: SettingsField[];
  /** `note` 必填。 */
  text?: string;
}

export interface SettingsSchema {
  scope: ConfigScope;
  fields: SettingsField[];
}

export interface ConfigValidateRequest {
  scope: ConfigScope;
  config: Record<string, unknown>;
}

export interface FieldError {
  /** 对应 schema 里的 `key`。省略则降级成整体错误提示。 */
  field?: string;
  message: string;
}

export interface ConfigValidateResult {
  ok: boolean;
  errors?: FieldError[];
}

/**
 * `action` 按钮的返回值，三个字段都可选。
 *
 * `openUrl` 只接受 http/https，宿主用系统浏览器打开——这是 OAuth 类插件把授权
 * 链接递到用户面前的唯一方式，插件自己画不了界面。
 */
export interface ActionResult {
  message?: string;
  openUrl?: string;
  /** 按 key 合并回表单。 */
  patch?: Record<string, unknown>;
}

/** `optionsFrom: "rpc:*"` 的返回值。 */
export interface OptionsResult {
  options: SettingsFieldOption[];
}

// ─── 多端同步传输（replica，契约 §5.4）──────────────────────────────────────
//
// **replica 与 sync 是两个不同的扩展点，不要混。** sync 接的是外部系统（飞书、
// Apple 日历），插件要理解对方的模型、产出 `ExternalItem`；replica 接的是**同一份
// 数据的另一个副本**，插件**只搬运加密字节**，一个业务判断都不做。
//
// 两者语义在关键处正好相反：sync 遇到远端删除要保留本地，replica 必须真删。所以
// manifest 里互斥，一个插件只能选一边。
//
// 五条硬约束（契约 §5.4.2，违反了宿主会判错或数据对不上）：
//
// 1. **`bytes` 是 base64。** 行分隔 JSON 放不了裸二进制。`maxObjectBytes` 说的是
//    **解码后**的大小。
// 2. **不得解释 `bytes`，也解释不了**——它是 XChaCha20-Poly1305 密文。日志里别打它。
// 3. **`key` 由宿主生成**，不含业务语义。插件不得改写、加前缀或重排目录，否则换设备
//    后对不上。要把数据放进自己的命名空间，用配置里的 database / 路径，别动 key。
// 4. **`missing: true` 不是错误。** 对象被别的设备压实掉了是正常情况，返回 RPC 错误
//    会白白触发退避与断路器。
// 5. **`put` 必须幂等。** 同一个 key 重复写入同样的内容不算失败——网络重试会真的
//    发生，而 journal 分片内容是不变的。

/** `replica.put` 的一个待上传对象。 */
export interface ReplicaPutObject {
  key: string;
  /** base64 编码的密文。 */
  bytes: string;
}

export interface ReplicaPutParams {
  profileId: string;
  traceId?: string;
  objects: ReplicaPutObject[];
  config?: Record<string, unknown>;
}

export interface ReplicaPutResult {
  /** 成功写入的 key。 */
  written: string[];
}

export interface ReplicaGetParams {
  profileId: string;
  traceId?: string;
  keys: string[];
  config?: Record<string, unknown>;
}

/** 下载结果的一项。`missing: true` 时 `bytes` 省略，**这不是错误**。 */
export interface ReplicaFetchedObject {
  key: string;
  bytes?: string;
  missing?: boolean;
}

export interface ReplicaGetResult {
  objects: ReplicaFetchedObject[];
}

export interface ReplicaListParams {
  profileId: string;
  traceId?: string;
  prefix: string;
  /** 上次返回的游标，增量列举。首次为空。 */
  since?: string;
  limit: number;
  config?: Record<string, unknown>;
}

export interface ReplicaObjectMeta {
  key: string;
  /** 解码后字节数。 */
  size: number;
}

export interface ReplicaListResult {
  objects: ReplicaObjectMeta[];
  /** 下次 `list` 传回的游标。 */
  cursor?: string;
  hasMore?: boolean;
}

export interface ReplicaDeleteParams {
  profileId: string;
  traceId?: string;
  keys: string[];
  config?: Record<string, unknown>;
}

export interface ReplicaDeleteResult {
  deleted: string[];
}

export interface ReplicaWatchParams {
  profileId: string;
  traceId?: string;
  since?: string;
  config?: Record<string, unknown>;
}

/**
 * `replica.watch` 的应答。**必须立即返回**，不要在里面等第一条变更。
 *
 * 宿主是「串行请求-响应 + 超时杀进程」（契约 §4.5），挂在 watch 里等 60 秒的
 * longpoll 会被当成超时杀掉然后无限重启。返回之后在自己的循环里等变更，用
 * `replica.changed` 通知上报，并每 `heartbeatSeconds` 至少发一次 `replica.heartbeat`
 * （没有变更时也要发）——宿主按 3 个心跳周期判活。
 */
export interface ReplicaWatchResult {
  watching: boolean;
  heartbeatSeconds?: number;
}

export interface ReplicaUnwatchResult {
  watching: false;
}
