# Security

This host-side plugin runs inside DSH with the host user's permissions. Review
its code and DSH bundle patch before installation. Discovery accepts only a
read-only credential interface and does not modify stored grants, account model
policies, signed app files, or profile files.

Never post OAuth tokens, credential records, raw API responses, or profile secrets
in public issues. Report suspected token exposure, endpoint trust failures, or
credential-store writes privately to [the repository maintainer](https://github.com/1yefuwang1).
Use [GitHub's private vulnerability reporting](https://github.com/1yefuwang1/dsh-copilot-catalog/security/advisories/new)
if it is enabled; do not open a public issue containing sensitive details.

Supported integration versions are DSH `0.2.0-rc.2` and pi-ai `0.87.1`. Use only
reviewed releases, inspect lockfile updates, and restart the host after removing
or upgrading the wrapper. The wrapper does not replace upstream OAuth safety or
credential refresh locking. Logs intentionally omit arbitrary exception text.

`npm run check:secrets` checks Git-candidate files for common token formats,
private keys, credential-bearing URLs, hard-coded credential-like literals, and
sensitive filenames. `node scripts/check-secrets.mjs --staged` checks the actual
index before committing. Only specific synthetic literals in tests are allowed;
suspected values are never printed. This is a defense-in-depth check, not a proof
that arbitrary secrets cannot be present. Review all files before publication.
