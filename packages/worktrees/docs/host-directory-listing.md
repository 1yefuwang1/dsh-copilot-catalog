# Deferred: Host-served directory listing

Status: **not implemented**. This records a design decision and the reasoning behind
it, so the in-app **Browse for folders** entry can be restored on desktop without
re-deriving the constraints.

## Current behaviour

**Browse for folders** (the in-app multi-select dialog) is offered only where the
Host serves directory listing. A loopback desktop composes the *native* picker, so
it gets **Choose a folder…** and **Enter a folder path** and has no in-app browser.
That is why desktop multi-folder projects are built by repeating the system dialog
or pasting absolute paths.

## Why the composed picker cannot fix this

The Host's directory picker adapts to the session at boot and serves exactly one verb
set:

- **native** — `pick` only. Chosen for a loopback bind on a platform whose OS chooser
  can be reached from the Host display.
- **browse** — `listDirectory` and `createDirectory` only. Chosen for a non-loopback
  bind, an SSH launch, or a display session without a chooser.

The other verb set fails with `directory-picker/unavailable`. In the desktop
composition `uiWorkspace.pickDirectory` is *declared* on the client service face but
served by no mounted picker, and `listDirectory` is refused outright — measured, not
assumed:

```
Operation failed: directory browse failed: directory-picker/unavailable:
directoryPicker.list needs the browse capability; the composed picker serves "native"
```

The choice is a boot-time composition, not a setting, so a profile cannot opt into
both. The plugin therefore cannot reach an in-app browser through DSH's picker seam
on desktop.

## Design if it is ever wanted

Serve listing and creation from **this plugin's own Host half**, so the browser
depends on nothing but the plugin that already ships a Host half.

- **Route.** An exact authenticated quiet RPC route, `dsh-worktrees/directories`,
  registered with `registerQuietRpcRoute`. Deliberately *not* `requestHost(ctx,
  actorId, …, '/execute')`: that path requires an actor, and folder picking must work
  from an empty New-project dialog where no conversation is selected yet.
- **Payload.** Versioned and bounded, mirroring the existing project protocol:
  `{ v: 1, request: { action: 'list', path? } }` and
  `{ v: 1, request: { action: 'create', path, name } }`. No inferred actor and no
  authority carried in the payload.
- **Separation.** A directory parser/controller of its own, so the published
  `workspace_project` / `projectRequest` action union does not grow filesystem
  mutations.
- **Reuse.** Clone the authenticated-operator fence, shutdown, flight and redacted
  envelope handling from `src/project-rpc.ts`, and cap responses with
  `projectJsonSnapshot`.
- **Filesystem semantics.** Node `fs` on the Host, matching the `realpath`/`stat`
  expectations `src/projects.ts` already applies to project folders. Bounded
  directory-only `opendir` listing with crumbs, home default and a truncated flag;
  single-segment, non-recursive `mkdir` that rejects separators, `.`, `..`, control
  characters and existing targets, canonicalises the parent and verifies the child.
- **Client.** A `requestProjectDirectories` helper over `quietRPC`; the folder
  scanner takes its `listDirectory` from that adapter and `FolderBrowser`'s create
  action from the same one. The capability probe asks this endpoint instead of
  `uiWorkspace.listDirectory`.
- **Do not** call the composed `uiWorkspace.listDirectory`: it is absent in this
  composition by design, and routing through it would keep the browser dependent on
  the picker the plugin cannot control.

## Test matrix to carry over

- Authorization, strict payload validation, response cap, abort, teardown, and no
  actor activation.
- Real temporary trees: listing, missing path, path that is not a directory,
  symlink and containment bounds, creation, and refusal to overwrite.
- Renderer scenario: browser selection and creation through the plugin's own
  endpoint while `uiWorkspace` serves the native picker only.

## Scope note

This is a capability improvement, not a fix for the entry-level defects resolved in
0.2.17 (offering entries the session cannot serve, the default entry, the picker
callable contract, and the duplicated dialog). It needs a Host rebuild and install,
whereas those fixes were client-only.
