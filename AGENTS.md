

<!-- buildwithcli-portability:start -->
# BuildWithCLI agent instructions

- The canonical catalog lives in the existing aggregate plugin trees. Do not fork or duplicate source content for a target CLI.
- Run `npm run validate:portable` and `npm run test:portable` after changing the scanner, normalizer, adapters, hooks, or managed writer.
- Keep generated output under `.buildwithcli/`; never commit secrets or resolved environment values.
- Executable hooks are disabled unless both `--hooks trusted` and `--trust-hooks` are supplied after manual review.
- Preserve least privilege: missing tool metadata inherits host policy, explicit lists are mapped narrowly, and explicit empty lists stay deny-all or are omitted when a host cannot enforce that boundary.
- Use the universal Agent Skills export or a declarative custom target for an unsupported CLI. Never guess executable hook semantics.
- Do not rely on GitHub Actions; all required validation is local and reproducible.
<!-- buildwithcli-portability:end -->
