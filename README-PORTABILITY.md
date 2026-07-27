# BuildWithCLI portability overlay

This package adds the multi-agent compiler to `groxaxo/buildwithcli` without deleting the existing Claude Code marketplace.

## Apply

```bash
node apply-overlay.js /path/to/buildwithcli
```

The installer makes backups, patches the existing package/validators/schemas, copies the compiler and tests, and runs local verification. It is idempotent.

Useful options:

```bash
node apply-overlay.js /path/to/buildwithcli --dry-run
node apply-overlay.js /path/to/buildwithcli --skip-verify
node apply-overlay.js /path/to/buildwithcli --force
```

After application:

```bash
cd /path/to/buildwithcli
npm run portable:doctor
npm run validate:portable
npm run test:portable
npm run portable:compile
```

Executable hooks remain disabled. Read `docs/PORTABILITY_SECURITY.md` before compiling with `--hooks trusted --trust-hooks`.
