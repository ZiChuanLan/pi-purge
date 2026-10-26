# pi-purge

[English](README.md) | [中文](README.zh-CN.md)

An [opencode](https://github.com/sst/opencode) **v2** plugin for system-prompt experiments: `/purge` switches which system prompt a session runs with — opencode's stock prompt, a trimmed variant, or only a persona prompt.

It is meant for prompt engineering work: comparing how the same request behaves when the harness prompt is present, trimmed, or absent; regression-testing your own instructions; and studying instruction-following and prompt-injection robustness under controlled conditions.

With it off, nothing changes — no prompt rewrite, no disk reads. opencode behaves exactly as if the plugin were not installed.

It targets opencode v2 (developed against 2.1.4, using the Promise plugin API from `@opencode/plugin`). It does not work with opencode v1.

## Install

The plugin is a single self-contained file, `index.ts`, with no runtime dependencies.

**Drop it in** — no config needed. opencode loads `.ts` / `.js` files from the `plugins/` directory of an opencode config directory: a project's `.opencode/plugins/`, or the same folder in your global config directory.

```bash
mkdir -p .opencode/plugins
cp index.ts .opencode/plugins/pi-purge.ts
```

**Or point your config at the checkout.** Use the `plugins` array of your opencode config; this is also how you pass options. A local entry must be a directory containing `index.ts` (or `server.ts`), and a relative path resolves against the config file:

```json
{
  "plugins": [
    { "package": "/path/to/pi-purge", "options": { "source": "/path/to/persona.md", "mode": "strict" } }
  ]
}
```

Then, inside a session:

```text
/purge
```

That is all. A short example prompt ships inside the plugin, so a fresh install works with no extra files. To run your own instructions instead:

```text
/purge source C:/prompts/my-instructions.md
/purge mode replace
/purge on
```

`/purge source embedded` switches back to the bundled persona.

## Commands

| Command | Effect |
| --- | --- |
| `/purge` | Toggle on/off for this session |
| `/purge on` / `off` | Enable or disable the rewrite |
| `/purge status` | Mode, prompt source, loaded size, and what the previous turn actually changed |
| `/purge mode append\|replace\|strict` | Switch composition mode (default `strict`) |
| `/purge source <path\|embedded>` | Change the prompt file, or go back to the bundled example; a failed switch rolls back |
| `/purge reload` | Re-read an external prompt file after editing it |

## Modes

| Mode | System prompt sent to the model | Use it when |
| --- | --- | --- |
| `append` | Your prompt placed before opencode's prompt, unchanged. | You want a control run: baseline behavior plus your instructions on top. |
| `replace` | Your prompt, then opencode's prompt with its identity line (`You are an AI agent running in OpenCode, a coding agent harness. …`) removed. Tool guidance, the other guidelines, and project context stay. | You want to measure the effect of the harness framing without losing tool context. |
| `strict` | Your prompt plus `Current working directory: …` only. | You want to isolate your instructions as a single variable. This is the default. |

`replace` finds the identity line by exact wording, at the start of a line. If an opencode update rewords it — or the agent brings its own system prompt, as the built-in `explore` subagent does — it leaves the prompt intact rather than cutting the wrong text: `/purge status` then reports `身份段 未匹配` (identity line not found) and behavior falls back to `append`. `strict` does no matching at all, so it behaves the same across opencode versions.

Tool definitions are sent through the request's tool list rather than the system prompt, so tools keep working in every mode, including `strict`.

## Session scope and defaults

- Scope is the session, keyed by session ID. Every session begins **disabled** — new sessions, sessions you return to after a restart, and the child sessions that subagents run in. Restarting opencode or reloading the plugin always returns to stock behavior.
- Only the agent's own model requests are rewritten. Session titles, compaction summaries, and `generate` calls use their own prompts and are left alone.
- Nothing is written to disk: there is no state file, no cache, no marker.
- The default prompt is the short example bundled inside `index.ts`. `/purge source <path>` points at your own file; `/purge source embedded` comes back.
- To start every session with your own file, set the plugin option `source`, or set `PI_PURGE_SOURCE` to an absolute path:

    ```bash
    PI_PURGE_SOURCE=/home/me/persona.md opencode    # macOS / Linux
    set PI_PURGE_SOURCE=C:/prompts/persona.md        # Windows cmd
    $env:PI_PURGE_SOURCE='C:/prompts/persona.md'     # Windows PowerShell
    ```

    These only supply initial values: `/purge on` is still required, every session still begins disabled, and `/purge source <path>` in a session overrides them. Precedence is `/purge source` in the session, then the `source` option, then `PI_PURGE_SOURCE`, then the bundled example. The `mode` option (`strict` | `replace` | `append`) presets the mode the same way. If the file is missing, `/purge on` reports the error instead of silently falling back to the bundled example.
- The bundled text is deliberately minimal. Published packages are scanned for abusive prompt content, so a full custom persona does not survive publishing; keep your own prompt on disk and reference it with `/purge source`.
- The default mode is `strict`.

## Coming from the pi extension

This fork replaces the pi extension; there is no pi support any more. Commands and modes are unchanged, with these differences:

- State is held per session ID instead of per process.
- There is no `PURGE ON` footer indicator; use `/purge status`.
- `replace` removes only the identity line — opencode's default prompt has no bundled documentation section to cut.
- `PI_PURGE_SOURCE` still works, and the plugin now also accepts `source` / `mode` options.

## Notes for experiments

- `strict` also drops project instructions (`AGENTS.md` and friends), the skills list, and prompt text added by other plugins. That is what makes it a clean single-variable setup, and also what makes results from `strict` not comparable to a normal session.
- `append` is the least invasive mode and usually the weakest signal: later sections of the harness prompt still carry a lot of weight, so differences can be small.
- `replace` still leaves harness text behind, and other plugins may rewrite the system prompt before or after this one runs. In practice `strict` is the only mode where the persona is not competing with other framing.
- `/purge` replies are recorded in the session as user-side messages that do not start a model turn. Later turns can see them, which matters for a strict single-variable run — read `/purge status` once at the end rather than after every change.
- Plugin load order affects what the `context` hook sees. Prefer recording `/purge status` output alongside any results you keep.

## Development

```bash
npm test   # two suites against a small mock opencode host; both assert nothing is written to disk
```

Node 22.19 or newer runs the TypeScript directly. The plugin registers one `context` session hook and a `purge` command. No other hooks, no background work, no file writes.

## Credits

The mechanism here is ported from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge): the idea of **removing** the harness identity line rather than drowning it out, the three composition modes, and the bundled prompt all come from that project. Credited and linked here as its author requires.

## Legal and compliance notice

**Non-profit, study and research only.** Users bear full responsibility for how they use this software. It must not be used for any unlawful purpose.

**Zero tolerance.** The authors do not support, encourage, or assist unauthorized network attacks, exploitation, data theft, intrusion into information systems, or the generation of illegal content. Any such use is unrelated to the authors, and the person doing it bears the full legal responsibility alone.

**No illegal content.** The code, docs, and bundled prompt are not malware, backdoors, unauthorized penetration tooling, ransomware, credential-stuffing scripts, or attack payloads aimed at public or third-party systems.

**Local use on your own opencode only.** Prompt substitution happens entirely inside the official opencode installation on the user's own machine (`@opencode/cli`, the local config directory and profile). The target is your own local software, not someone else's website, server, account, or information system.

**No outbound networking.** This extension only rewrites the system prompt inside the local process. It opens no network connections, and it does not scan, probe, intrude on, or send attack traffic to any public host or unauthorized system. Do not use it as a stepping stone against external networks.

**Authorized, controlled scope only.** This is an aid for prompt-engineering and robustness evaluation on an official opencode installation you are entitled to administer. Do not run it against targets you lack written authorization for, against public online systems, or in production. All testing must stay within your own authorized local opencode, offline synthetic fixtures, authorized exercise ranges, and compliant lab environments.

**Mainland China, Hong Kong, and Macao are off limits.** Do not access, scan, probe, or otherwise operate against networks in mainland China, Hong Kong, or Macao, nor against servers, sites, or addresses that resolve into those ranges. Naming a cloud provider is not an exception. The only exception is the single exact IP or the single fully qualified hostname the user has registered beforehand as their own server. Keys, passwords, CIDR blocks, wildcards, and verbal statements in a conversation add no exception. Unregistered means prohibited, without exception.

**Prohibited uses.** Users must not use this project, directly or indirectly, to violate any of the following, and must comply with each without exception:

- Criminal Law of the People's Republic of China
- Cybersecurity Law of the People's Republic of China
- Data Security Law of the People's Republic of China
- Personal Information Protection Law of the People's Republic of China
- Any other applicable laws, administrative regulations, and regulatory requirements

Also prohibited: unauthorized penetration or attack against public or private information systems, extortion, damage, credential stuffing, or malware distribution; producing or spreading content that endangers national security, promotes terrorism or graphic violence, is obscene or gambling-related, fraudulent, or infringes privacy or intellectual property; and violating the terms of service or abuse policies of any model provider.

**User assumes all liability.** This project is provided "as is" under the MIT License, without warranty of any kind, express or implied, as to completeness, security, or fitness for purpose. Users bear sole and complete civil, administrative, and criminal liability for their own download, deployment, execution, modification, and distribution of this software, and for all inputs and outputs that result. The authors and contributors accept no direct, indirect, or consequential liability arising from misuse.

**License terminates on breach.** Any person or entity that uses this project for illegal attacks, malicious activity, or other violations has its open-source license terminated automatically and irrevocably from the date of the violation. That party must stop using the project immediately, permanently destroy all copies of its code, scripts, and derived data, and face the applicable legal consequences.

**Third-party independence.** This is a fully independent open-source security research project. It has no affiliation, commercial partnership, authorization, or official endorsement from opencode or any related entity. The word "official" refers only to the fact that the evaluation target is the official opencode package installed on the user's machine; it does not mean opencode develops, endorses, or vouches for this extension.

**Attribution required.** Anyone reusing this project's name, approach, code, or prompt must credit the author and link this repository. Failure to attribute will be pursued legally.

## License

MIT

---

感谢 [LINUX DO](https://linux.do) 社区
