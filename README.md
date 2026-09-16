# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Delegation: `subagent` and Agent Teams

dsh ships two ways for an agent to hand work to other agents. `tool-subagent` is mounted in `dsh-base` and available by default. Agent Teams — `packages/experimental/agent-team` and `tool-agent-team` — is opt-in: a deployment mounts both plugins through a patch layer, and the Lead creates a team only when the conversation asks for Agent Teams or teammates.

| | `tool-subagent` | Agent Teams |
|---|---|---|
| Model-facing tools | one `subagent(description, prompt)` call, fire-and-forget, returning `started subagent <id>`; plus `list_agents` and `send_message` | `spawn_teammate`, `team_task_create` / `list` / `get` / `update`, `send_message` / `followup_task`, `wait_agent`, `interrupt_agent`; plus a fixed workflow policy in the system prompt |
| Coordination | parent ↔ child only; children cannot address each other; no shared state; the task is the prompt text | a flat named roster, a durable peer mailbox, and a shared task board with DAG dependencies, one owner per task, compare-and-set revisions, and advisory write scopes |
| Waiting for results | the parent ends its turn and is woken when a child settles | `wait_agent` blocks the Lead on a team edge; the policy requires the Lead to wait for required teammates before answering |
| Persistence | each child is a durable session; nothing is shared | roster, tasks and mail are folded from the Lead's session log: durable, cold-resumable, replayable |
| Identity | anonymous session ids | immutable kebab-case names, addressable, never reused; a failed member keeps its slot |
| Activation | mounted by default; used when the prompt asks for it | mounted explicitly; teammates are created only when the user asks for Agent Teams or teammates |
| File isolation | none | none — write scopes warn about overlap, they do not lock |
| Observed on ASI-Bench b1, this fork at `fac9bd0`, `--profile headless` | 12 of 60 instances exited with subagents still running and delivered nothing | 0 of 52 so far; median completed runtime 3255s against a ~1950s single-agent baseline |

The last row is the practical difference under `--profile headless`, where a run used to end when the root agent's turn ended: a root that dispatched background subagents and yielded had ended its turn, so the run exited and the children's work was lost, while a Lead blocks in `wait_agent` instead. The headless runner now accepts an optional `ctx.headlessSettlement` service; [`agent-team-settlement`](packages/experimental/agent-team-settlement/README.md) provides it over the Team board, `agent-team` can record plain `subagent` runs on that board (`trackSubagentRuns`), and work the run has to give up on is recorded as `lost` rather than dropped. Neither surface has typed outputs or a harness-checked notion of done; those are tracked in [zhengxuyu/mllm-benchs](https://github.com/zhengxuyu/mllm-benchs/blob/main/DEFECTS.md).

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
