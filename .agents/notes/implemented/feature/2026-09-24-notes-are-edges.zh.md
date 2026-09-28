# Agent Note: Notes are edges

Status: implemented

[English](2026-09-24-notes-are-edges.md) | 中文

## 问题

Team 成员之间靠发给成员的邮件互相告知，任务板对此一无所知：一个队友的收尾报告点名了另一个任务输出中的缺陷，Lead 读过就继续了，那个任务照样完成，并因报告所描述的 import 错误得了零分。在图之外流动的信息不留下边，于是没有什么能据此 hold 住一个节点，之后沿产物谱系的信用分配也看不到它。

## 决策

note 是收件方为任务的消息。`noteTask` 在同一个提升任务 revision 的 Lead 事务里把它记录为任务的 `notes`（id 为 `<task>-note-<n>`、发送成员、文本），以 note 作者的身份邮寄给任务当前的 owner 而不等待投递，`claim` 与 `reassign` 时组合的简报会列出这些 note，因此下一个做这个任务的人把它们当作输入。note 需要一个活跃任务：`pending`、`in_progress` 或 `lost`。

以纯子串方式点名了另一个活跃任务所声明输出路径的 note 会 hold 住那个任务：在同一事务里向被 hold 的任务追加一条 `holds`（note id、note 所发往的任务、发送者），`complete` 以 `TEAM_TASK_HELD` 拒绝并列出每个 hold，只有 Lead 能用点名 note 的 `acknowledge` 动作清除 hold。已完成的任务绝不携带 hold。Team 工具新增 `team_task_note` 与 `acknowledge` 动作，frontier 的行计数 `notes` 与 `holds`。两个字段都是版本 3 `team/task` payload 上的可选属性，作为同版本变更确认。

## 考虑过的替代方案

**给 `send_message` 增加任务目标。** 被拒绝：成员名是自由文本，会与任务 id 冲突；而 note 的结果（note id、被 hold 的任务）与邮件回执是不同的值；第十个工具让两个契约都保持精确。

**只要提到任务就 hold，而不限于其输出。** 被拒绝：谈论某任务的 note 是常态，不应让它停下；设计中的规则是点名另一个节点输出的 note，这正是那次失分的形态。

**让被 hold 任务的 owner 自己确认。** 被拒绝：hold 的意义在于让 Lead 读到 note；owner 确认自己任务上的 hold 会恢复这条规则所消除的沉默。

## 测试

包测试覆盖记录与寄给 owner、简报列出 note、对已结束与不存在的任务及空文本的拒绝、hold 及其 `TEAM_TASK_HELD` 拒绝、确认清除一个 hold 而保留其余、仅 Lead 可确认的规则，以及 projection 的规则。工具测试覆盖带被 hold 任务与 frontier 计数的 note 结果，以及通过工具的确认。`team-targets` 快照固定 schema 与策略文本。

## 后果

一个 note 花费一次任务 revision，外加每个被 hold 任务各一次；被 hold 任务的 owner 在 Lead 读过相关 note 之前不能完成。子串规则会在 note 只是顺带引用某路径时也 hold 住该任务；Lead 的确认只需一次调用。
