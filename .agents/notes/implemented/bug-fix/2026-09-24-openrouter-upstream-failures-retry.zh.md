# Agent Note: OpenRouter upstream provider failures retry like a server error

Status: implemented

[English](2026-09-24-openrouter-upstream-failures-retry.md) | 中文

## 问题

OpenRouter 用两种措辞报告上游 provider 在生成响应时失败：一个裸的 `error` finish_reason，pi-ai 把它渲染为 `Provider finish_reason: error`；以及 `Upstream error from <provider>: The model stopped before completing the response.`。`classifyPiAiError` 两者都不认识，于是都落到 `PI_AI_ERROR`，而没有任何重试策略会重试这个码。该步失败，回合以错误结束，headless 运行退出时什么都没交付。在一轮 ASI-Bench b1 sweep 中，前 20 个实例里有 3 个在最初几分钟内就这样结束，任何工作都还没到达 workspace。

## 决策

两种措辞都映射到 `SERVER`，即 5xx 所映射的码，因为失败属于 provider 而不属于请求：provider 恢复或 OpenRouter 换路由后，同一请求重放即可成功。该匹配在具体类别之后运行，所以点名认证、配额、限流、被拒的请求体、上下文溢出或传输中断的上游消息保留各自的码。pi-ai 以同样方式渲染的其他 finish reason，例如 `content_filter`，仍为 `PI_AI_ERROR`：重复一个被过滤的请求不可能成功。

## 考虑过的替代方案

**新增一个可重试码，如 `UPSTREAM`。** 被拒绝：重试策略的默认码列表是部署配置；任何固定了该列表的 profile 都会悄悄地不重试新码，而 `SERVER` 已在每个默认列表中。

**在 pi-ai adapter 内部重试。** 被拒绝：重试由 `dsh-llm-retry` 按 provider 声明的策略拥有；adapter 的职责是稳定的分类。

## 测试

`convert.spec.ts` 固定两种措辞映射到 `SERVER`，并固定 `Provider finish_reason: content_filter` 映射到 `PI_AI_ERROR`。

## 后果

运行能熬过中途断掉的 provider，代价是在重试策略的退避下重放该步。OpenRouter 附在流式错误上的上游细节在到达 adapter 之前仍被 pi-ai 丢弃，所以被重试的失败信息里没有 provider 的名字。
