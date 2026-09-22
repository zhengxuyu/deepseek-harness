---
description: "Jev 判断 seam（ctx.jev），供配置 TypeSafe 或 OpenRouter 凭据、请求与答案词汇以及 JevError 错误码的用户和维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jev

[English](README.md) | 中文

## 概述

`dsh-jev` 是 Jev 判断 seam：`ctx.jev.decide()` 校验一次请求，为该次调用解析凭据，把请求发往 TypeSafe 或 OpenRouter，并在消费者看到之前校验每个答案。当插件需要对提供的状态做经校准的选择、是否或评分判断而不消耗模型回合时选择它；它不注册工具，也不注册命令。没有密钥的部署会在第一次调用时以 `JEV_CREDENTIAL_MISSING` 得知。

## 目录

- [概览](#overview)
- [配置](#config)
- [服务 API](#service-api)
- [错误](#errors)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="overview"></a>
## 概览

Jev 判断 seam（`ctx.jev`）的 Service Definition 兼 TypeSafe 实现。Jev 是 [TypeSafe](https://docs.typesafe.ai) 的 System One 模型：它用校准过的概率回答关于所提供状态的类型化问题，且不生成任何文本。`decide()` 校验一次请求，为本次调用解析凭据，发送 `POST {baseURL}/v1/systemone`，并在消费方看到之前校验每个答案。

该包拥有 `ctx.jev` 键、请求与答案词汇以及 `JevError` 分类。它不注册工具，也不注册命令；[`dsh-tool-jev`](../tool-jev/README.zh.md) 和 [`dsh-command-jev`](../command-jev/README.zh.md) 是消费方。与其他每个 seam 一样，它是默认导出的 `Service`。

不发布运行时不变量伴随插件；该 seam 不拥有会话事件流或可变投影，每个请求与答案都在承载它的调用内部完成校验。

<a id="config"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面 TypeSafe API 密钥。请优先使用 `apiKeyEnv`，让密钥不进入配置；非空字面值优先。 |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 每次请求通过 `ctx.credentials` 解析的凭据引用；该 seam 缺席时从启动环境解析。什么都解析不到时，调用以 `JEV_CREDENTIAL_MISSING` 失败。 |
| `baseURL` | `https://api.typesafe.ai` | 端点基址；追加 `/v1/systemone`，去掉末尾斜杠。回退到 `$TYPESAFE_BASE_URL`。无法解析的值在加载时失败。 |
| `model` | `jev-latest` | 请求未指定模型时发送的模型。 |

```yaml
- id: jev
  name: '@deepseek-ai/dsh-jev'
  config:
    apiKeyEnv: TYPESAFE_API_KEY
```

OpenRouter 在 `https://openrouter.ai/api/v1/systemone` 提供同一端点，请求体和答案完全相同，模型 id 接受 `jev-1.13` 和 `typesafe/jev-1.13` 两种写法。随附的 `dsh-base` 行使用该路由：

```yaml
- id: jev
  name: '@deepseek-ai/dsh-jev'
  config:
    apiKeyEnv: OPENROUTER_API_KEY
    baseURL: https://openrouter.ai/api
    model: typesafe/jev-1.13
```

<a id="service-api"></a>
## 服务 API

`decide(request, signal?)` 接收无损 JSON 的 `state` 以及至少一个以调用方 id 为键的问题，解析为每个 id 一个经校验的答案、实际作答的确切模型和 token 用量。问题在提供方并行运行，彼此看不到对方的答案；把针对同一状态的所有独立问题放在一次调用中提出。

| 问题 | 答案 | 调用方规则 |
|---|---|---|
| `choice`——`options: { name: description \| null }` | `choice`、逐选项的 `probabilities`、`confidence` | 至少两个非空白选项名 |
| `noul`——一个是／否条件 | `noul`，即"是"的概率 | 除 instructions 非空白外无其他要求 |
| `score`——`levels: string[]`，从低到高有序 | `score`（概率加权索引）、`legend`、逐索引的 `probabilities`、`confidence` | 两到十个非空白等级 |

校验在读取任何凭据或发送任何字节之前拒绝。协议响应不被信任：类型与问题不符的答案、请求未提供的被选选项，或非数值的概率，都会以 `JEV_PROVIDER_ERROR` 失败，而不会到达消费方。`describe()` 返回生效中的凭据引用、基址和默认模型，绝不返回密钥值。

<a id="errors"></a>
## 错误

`JevError extends HarnessError`，带开放的 `code`：`JEV_INVALID_REQUEST`（调用方违规或 HTTP 400/422）、`JEV_CREDENTIAL_MISSING`、`JEV_UNAUTHORIZED`（401/403）、`JEV_RATE_LIMITED`（429/529）、`JEV_ABORTED`（调用方信号在调用前或调用中触发）以及 `JEV_PROVIDER_ERROR`（网络故障、其他任何状态码或无法处理的响应体）。HTTP 重定向在联系目标之前就被拒绝。响应体携带提供方错误消息时，会追加在 HTTP 状态之后。

<a id="model-experience"></a>
## 模型体验

间接地，通过 [`dsh-tool-jev`](../tool-jev/README.zh.md) 和 [`dsh-command-jev`](../command-jev/README.zh.md)：该 seam 自身不渲染任何内容，每个消费方各自负责答案措辞及其呈现的 `JevError` 消息原文。

#### KV Cache 影响

无直接失效；该 seam 绝不进入会话请求前缀，每次 TypeSafe 请求都是会话模型缓存之外的独立辅助调用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>
- **不重试**——`JEV_RATE_LIMITED` 或瞬时的 `JEV_PROVIDER_ERROR` 只呈现一次；TypeSafe 的 SDK 会带退避重试，这里的重试策略等待有需要它的消费方。
- **凭据可用性在调用内解析**——没有同步的 `available()`；无密钥的部署在第一次 `decide()` 时以 `JEV_CREDENTIAL_MISSING` 得知。
- **仅文本状态**——TypeSafe 不接受图像或音频；`state` 是无损 JSON，其大小由消费方而非该 seam 限制。
- **单一厂商**——Service Definition 与 TypeSafe 实现共用本包；出现第二个 System One 提供方时按 `dsh-web` 的模式拆分。

<a id="dev-note"></a>
### 开发备注

无。
