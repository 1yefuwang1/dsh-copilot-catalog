# dsh-copilot-tool-schema

A narrow compatibility guard for **GitHub Copilot Gemini tool declarations** in
DeepSeek Harness (DSH). Additive: it never replaces an adapter, a provider route or
another plugin's settings, and it reads no credentials.

## Why

Measured on one Copilot account (`api.enterprise.githubcopilot.com`, non-streaming
`/chat/completions`, `max_tokens` 16):

| Request | Response |
| --- | --- |
| no tools | 200 |
| all 34 DSH tool schemas as assembled | **400** (plain-text `Bad Request`) |
| the same 34 with an empty `properties` bucket added to `workspace_project` | 200 |
| `workspace_project` alone, raw | **400** |
| `workspace_project` alone with `properties: {}` | 200 |
| `oneOf` deleted but still no `properties` | **400** |

Every other tool in that payload was accepted individually — including
`additionalProperties: true`, `pattern`, `$schema`, `format: "uuid"` and nested
`oneOf`. The measured trigger is an object parameter schema with **no properties
bucket**; this is not a universal Copilot contract, only what this account and route
demonstrated. The fix for the harness's own tool is the worktrees package; this guard
covers future and third-party tools with the same defect.

## Behavior

One rule, applied only when the assembled route matches `providers` and `families`:

- `parameters` is a JSON object with `type: "object"` and no `properties` → add
  `properties: {}`. This is JSON-Schema neutral and leaves `oneOf`, `required`,
  `additionalProperties` and descriptions untouched.
- `parameters` missing, not an object, not `type: "object"`, or containing `$ref` /
  `$dynamicRef` → left byte-identical and logged as `TOOL_SCHEMA_SKIPPED` when
  `logFixes` is enabled.
- Every conformant tool is returned by identity, so its request stays byte-identical.

Nothing else is rewritten: no keyword stripping, no union flattening, no description
changes, no output schemas.

## Mechanism

Registers an **outer global** listener on DSH's public `system-prompt/assemble`
waterfall (`ctx.on(..., { global: true, prepend: true })`), awaits the downstream
chain first, reads `provider`/`model` from the returned assembly variables, and
returns a detached assembly only when a declaration changed.

Outer registration is required: the agent-scoped model-selection listener overwrites
those variables *after* its own `next()`, so an inner listener would read unset
variables and silently do nothing. Because the assembly feeds both the durable
`request/header` and the frozen request, the change stays consistent with the
agent-loop invariant. Another outer prepend listener can still override the result —
no extension can promise terminal ownership.

## Configuration

```yaml
- id: copilot-tool-schema
  name: dsh-copilot-tool-schema
  config:
    providers: [github-copilot]   # routes in scope; [] disables without a restart
    families: [gemini]            # case-insensitive model-id markers
    logFixes: false               # one controlled summary line per changed assembly
```

Volatile settings are snapshotted once per assembly. Failure containment catches only
the guard's own transformation errors and returns the downstream assembly untouched;
a downstream `next()` failure propagates unchanged.

## Install

```sh
dsh plugin --profile <profile> add dsh-copilot-tool-schema
```

Restart the whole DSH process after installing or removing it. The bundle only inserts
this entry. No Web UI rebuild is needed. To uninstall, remove the plugin and restart.

## Verification

```sh
pnpm --filter dsh-copilot-tool-schema run verify
```

The suite includes unit rules, real `SystemPrompt` integration (including registration
order and disposal), a real pi-ai `openai-completions` wire capture with a fake
`fetch`, and its negative control. No live Copilot request, credential read or profile
write is performed.

Registration order is also covered against the real wiring: a minted `createScope`
scope carrying the installed `installModelSelection` listener, registered both before
and after the guard, with two sibling scopes (Gemini normalized, GPT untouched) and an
unscoped assembly left alone. An inner emulated listener additionally pins the ordering
invariant without the scope fixture.

## Limitations

- Adds the bucket only at the parameter root; nested objects are untouched.
- Does not attempt Copilot contract coverage beyond the measured trigger.
- Does not change headers, transport selection, model descriptors or output schemas.
- Other Copilot model families are covered only when their marker is added to
  `families`.

## License

MIT. DSH and pi-ai are peer dependencies and are not redistributed here.
