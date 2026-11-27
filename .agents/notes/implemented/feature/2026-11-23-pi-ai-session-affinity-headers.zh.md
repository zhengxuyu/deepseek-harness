# Agent Note: 手写 Chat Completions 路由上的会话亲和请求头

Status: implemented

[English](2026-11-23-pi-ai-session-affinity-headers.md) | 中文

## Problem

位于录制网关后的自托管 Chat Completions 端点（例如 SGLang 前面的 RL rollout 服务）必须把每次模型调用归到发起它的 Session。一次运行里，主 Session 与其队友或子代理 Session 的调用在同一路由上交错，而请求 URL 和消息体都不标明 Session。Session 日志记录这些调用但不含 token id，因此网关的记录与 Session 日志只能通过双方都能看到的标识符关联。

直连 DeepSeek 适配器已经发送 `x-deepseek-harness-session-id`，但它使用 Anthropic Messages 协议，这类服务端不一定接受。pi-ai 的 `openai-completions` 传输可以把 Session id 作为会话亲和请求头发送，`sendSessionAffinityHeaders` 兼容开关控制这一行为。[线路兼容面](../../archived/feature/2026-08-18-pi-ai-wire-compat-surface.md)把该开关视为具名目录厂商所有，因此将其扣留。结果是手写路由无法开启它。

## Decision

`openai-completions` 兼容闸门开放 `sendSessionAffinityHeaders`。`PiAiCompatProfile`、`compat` schema 与生成的配置目录都列出了它。与其他开放的开关一样，可以在路由上设置，也可以只对单个模型设置。该值为 `true` 且请求带有 Session id 时，pi-ai 把这个 id 作为 `x-client-request-id` 与 `x-session-affinity` 请求头发送；在其默认的 `openai` 亲和格式下还会发送 `session_id`。普通 agent、标题与压缩请求的 Session id 由 agent loop 提供。不带 Session id 的请求，或路由设置了 `cacheRetention: none` 的请求，不发送亲和请求头。未设置该开关的路由保留已安装或检测到的值。

该决定只针对 `openai-completions`。`sessionAffinityFormat` 仍被扣留，所以手写路由使用 pi-ai 根据路由检测出的写法：provider 为 `openrouter` 或 `baseURL` 含 `openrouter.ai` 的路由只发送 `x-session-id`，其余路由发送上述三个请求头。Anthropic Messages 闸门仍扣留 `sendSessionAffinityHeaders`，所以在该协议上解析会拒绝这个键。

## Alternatives considered

**继续扣留该开关，按内容关联。** 网关可以把每条录到的补全与 Session 日志里的 assistant 消息逐一比对。不同 Session 中相同的补全无法区分，而且比对依赖两个组件在文本、工具调用与推理内容上逐字节一致的序列化。请求头是 harness 本来就掌握的标识符。

**通过路由的 `headers` 设置请求头。** 配置档请求头对整条路由固定，所以该路由上的每个 Session 都会发送同一个值。

**改走直连 DeepSeek 适配器。** 它会发送 Session id，但要求 Anthropic Messages 端点。Chat Completions 服务端因此需要一个转换代理。

**同时开放 `sessionAffinityFormat`。** 目前没有端点需要其他写法：由部署方掌控的网关可以读取 `x-session-affinity`，除 OpenRouter 外的所有格式都会发送它。在有端点需要其他写法之前，该开关继续扣留。

## Consequences

rollout 网关可以根据 harness 掌控的请求头按 Session 归组录到的调用。把录到的调用对上 Session 日志中的条目，仍依赖每个 Session 内的调用顺序，这一步不在 harness 内。

已归档的目录所有权规则因此多了一个例外。开启该开关的手写路由会向其端点发送稳定的逐 Session 标识符。这条路由因此承担与直连 DeepSeek 适配器对其端点相同的 Session 关联暴露。
