# pi-purge

[English](README.md) | [中文](README.zh-CN.md)

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for system-prompt experiments: `/purge` switches which system prompt a session runs with — pi's stock prompt, a trimmed variant, or only a persona prompt.

It is meant for prompt engineering work: comparing how the same request behaves when the harness prompt is present, trimmed, or absent; regression-testing your own instructions; and studying instruction-following and prompt-injection robustness under controlled conditions.

With it off, nothing changes — no prompt rewrite, no disk reads. pi behaves exactly as if the extension were not installed.

## Install

```bash
FULL:pi install git:github.com/ZiChuanLan/pi-purge@ffafeb9
pi install npm:pi-purge
```

Then, inside a session:

```text
/purge
```

That is all. A short example prompt ships inside the package, so a fresh install works with no extra files. To run your own instructions instead:

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
| `append` | Your prompt prepended to pi's prompt, unchanged. | You want a control run: baseline behavior plus your instructions on top. |
| `replace` | Your prompt, then pi's prompt with its built-in assistant identity line and bundled documentation section removed. Tool list, guidelines, and project context stay. | You want to measure the effect of the harness framing without losing tool context. |
| `strict` | Your prompt plus `Current working directory: …` only. | You want to isolate your instructions as a single variable. This is the default. |

`replace` finds both sections by exact wording. If a pi update rewords them, it leaves the prompt intact rather than cutting the wrong text — `/purge status` then reports `身份段 未匹配` (identity line not found) and behavior falls back to `append`. `strict` does no matching at all, so it behaves the same across pi versions. On omp, which supplies a prompt block array without these pi-specific anchors, `replace` also leaves the host prompt intact; use `strict` when the harness framing must be gone.

Tool schemas are passed through the API `tools` parameter rather than the system prompt, so tools keep working in every mode, including `strict`.

## Session scope and defaults

- Scope is the session. Every `session_start` — startup, `new`, `resume`, `reload` — begins **disabled**. Quitting pi always returns to stock behavior.
- Nothing is written to disk: there is no state file, no cache, no marker. Two pi processes cannot affect each other.
- The default prompt is the short example bundled inside `extensions/pi-purge.ts`. `/purge source <path>` points at your own file; `/purge source embedded` comes back.
- To start every process with your own file without writing any state, set `PI_PURGE_SOURCE` to an absolute path:

    ```bash
    PI_PURGE_SOURCE=/home/me/persona.md pi          # macOS / Linux
    set PI_PURGE_SOURCE=C:/prompts/persona.md        # Windows cmd
    $env:PI_PURGE_SOURCE='C:/prompts/persona.md'     # Windows PowerShell
    ```

    It only supplies the initial value of `source`: `/purge on` is still required, `enabled` still begins `false` on every `session_start`, and `/purge source <path>` in a session overrides it. If the file is missing, `/purge on` reports the error instead of silently falling back to the bundled example.
- The bundled text is deliberately minimal. Published packages are scanned for abusive prompt content, so a full custom persona does not survive publishing; keep your own prompt on disk and reference it with `/purge source`.
- The default mode is `strict`.

## Upgrading from 0.1.x

0.2 no longer writes or reads `pi-purge.json`, and it no longer auto-detects a prompt file — the persona is bundled and the mode defaults to `strict`.

- Delete `<agent dir>/pi-purge.json`; it is ignored from now on.
- Enabling is per session: after a restart or `/resume`, run `/purge` again.
- `append` and `replace` are unchanged if you need them.

## Notes for experiments

- `strict` also drops `AGENTS.md` / project context, the skills list, and prompt text injected by other extensions. That is what makes it a clean single-variable setup, and also what makes results from `strict` not comparable to a normal session.
- `append` is the least invasive mode and usually the weakest signal: later sections of the harness prompt still carry a lot of weight, so differences can be small.
- `replace` still leaves harness text behind, and other extensions may append their own prompt sections after this one runs. In practice `strict` is the only mode where the persona is not competing with other framing.
- Extension load order affects what `before_agent_start` sees. Prefer recording `/purge status` output alongside any results you keep.

## Development

```bash
npm test   # two suites; both run against temporary agent dirs and assert nothing is written
```

The extension registers one `before_agent_start` hook, one `session_start` hook, and a `/purge` command. No other hooks, no background work, no file writes.

## Credits

The mechanism here is ported from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge): the idea of **removing** the harness identity line rather than drowning it out, the three composition modes, and the bundled prompt all come from that project. Credited and linked here as its author requires.

## Legal and compliance notice

**Non-profit, study and research only.** Users bear full responsibility for how they use this software. It must not be used for any unlawful purpose.

**Zero tolerance.** The authors do not support, encourage, or assist unauthorized network attacks, exploitation, data theft, intrusion into information systems, or the generation of illegal content. Any such use is unrelated to the authors, and the person doing it bears the full legal responsibility alone.

**No illegal content.** The code, docs, and bundled prompt are not malware, backdoors, unauthorized penetration tooling, ransomware, credential-stuffing scripts, or attack payloads aimed at public or third-party systems.

**Local use on your own pi only.** Prompt substitution happens entirely inside the official pi installation on the user's own machine (`@earendil-works/pi-coding-agent`, the local agent directory and profile). The target is your own local software, not someone else's website, server, account, or information system.

**No outbound networking.** This extension only rewrites the system prompt inside the local process. It opens no network connections, and it does not scan, probe, intrude on, or send attack traffic to any public host or unauthorized system. Do not use it as a stepping stone against external networks.

**Authorized, controlled scope only.** This is an aid for prompt-engineering and robustness evaluation on an official pi installation you are entitled to administer. Do not run it against targets you lack written authorization for, against public online systems, or in production. All testing must stay within your own authorized local pi, offline synthetic fixtures, authorized exercise ranges, and compliant lab environments.

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

**Third-party independence.** This is a fully independent open-source security research project. It has no affiliation, commercial partnership, authorization, or official endorsement from pi or any related entity. The word "official" refers only to the fact that the evaluation target is the official pi package installed on the user's machine; it does not mean pi develops, endorses, or vouches for this extension.

**Attribution required.** Anyone reusing this project's name, approach, code, or prompt must credit the author and link this repository. Failure to attribute will be pursued legally.

## License

MIT

---

感谢 [LINUX DO](https://linux.do) 社区
