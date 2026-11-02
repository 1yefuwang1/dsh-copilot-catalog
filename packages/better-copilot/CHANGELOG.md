# Changelog

## 0.1.0 — consolidated Copilot plugin

First release of `dsh-better-copilot`, merging three independently installable
plugins into one package with one bundle row (`better-copilot`) and one combined
configuration object:

- `dsh-copilot-catalog@0.2.9` — account-aware model discovery, Copilot wire
  identity and the pi-ai adapter wrapper.
- `dsh-copilot-search@0.1.5` — the `github-copilot-search` Responses web-search
  provider.
- `dsh-copilot-tool-schema@0.1.3` — the Copilot Gemini tool-declaration guard.

Behaviour is preserved:

- the wrapper still disables and replaces `llm-pi-ai`, still preserves the
  adapter's own provider schema, and still installs the wire-identity
  interceptor best-effort;
- search still resolves credentials through the adapter's public pi-ai surface,
  still keeps a search-owned guarded refresh clone, and still refuses untrusted
  origins and redirects;
- the guard still only adds a missing root `properties` bucket for configured
  provider/model families and leaves every other declaration untouched.

Changed:

- one plugin row and one config object: `providers` (unchanged adapter schema),
  `search` (was the search plugin's row config) and `toolSchema` (was the guard's
  row config);
- subpath exports are now `.`, `./catalog`, `./discovery`, `./identity`,
  `./search` and `./guard`; the predecessor subpaths are removed;
- the colliding `CopilotAuthOptions` type is exported as `CatalogAuthOptions`
  and `SearchAuthOptions`;
- a missing `web` service, a throwing guard registration, a throwing search
  registration and a throwing identity installer are contained: they degrade
  only their own capability instead of failing the mount.
