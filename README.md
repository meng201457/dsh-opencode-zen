# dsh-opencode-zen

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that **auto-maintains the author's OpenCode Zen CLI-header patch** for `dsh-llm-pi-ai`, keeping it alive across package updates.

## Background

[OpenCode Zen](https://opencode.ai/zen) rate-limits anonymous clients, which makes its free models impractical to call from a plain API client. The author of this repository found that requests carrying the official opencode-CLI header set (`x-opencode-client: cli`, `opencode/...` User-Agent, random session/request/project ids) are treated as a first-party client and pass the rate limiting.

To use that from the DeepSeek Harness, the author manually patched `dsh-llm-pi-ai/lib/index.js` with an `opencodeClientHeaders` injection that adds these headers to every `opencode` / `opencode-go` request (only for routes whose base URL is on `opencode.ai`). The patch lives in the installed dependency tree, so **any reinstall of `@deepseek-ai/dsh` wipes it** — the profile view is a junction into the installed tree, so both paths are the same physical file.

This plugin automates the maintenance of that patch: on every DSH boot it checks whether the module still contains the injection and re-applies it **byte-identically** when missing. Update the harness as often as you like — the next restart repairs itself, no manual fixups.

## Credits

The `opencodeClientHeaders` technique — spoofing the official opencode CLI header set to bypass OpenCode Zen's anonymous-client rate limiting — was **developed by the author of this repository**. This plugin is the self-healing installer that keeps that hand-written patch applied.

## Files

```
dsh-opencode-zen/
├── lib/index.js                       # cordis plugin: { name, apply, patchFile }
├── scripts/
│   └── dsh-opencode-zen-patch.mjs     # standalone one-shot patcher (idempotent CLI)
└── package.json
```

## Install

1. Put this directory under the profile, e.g. `~/.dsh/profiles/web/plugins/dsh-opencode-zen/`.
2. Register it in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-opencode-zen
      name: './plugins/dsh-opencode-zen/lib/index.js'
```

3. Restart DSH. On boot the plugin verifies/applies the patch and logs `dsh-opencode-zen: re-applied opencodeClientHeaders patch` or `patch already present`.

## Manual patcher

If you want to re-apply the patch without a restart (or from a script):

```sh
node scripts/dsh-opencode-zen-patch.mjs [target-file]
```

Idempotent — exits early when the patch is already applied.

## How it works

- Resolves the physical `dsh-llm-pi-ai/lib/index.js` (module resolution, then known junction/install paths).
- `patchFile(target)` reads the module; if `opencodeClientHeaders` is missing it inserts the header-injection block ahead of `requestHeaders` and wires it into the stream request headers. Returns `"patched" | "already" | "layout-mismatch"`.
- On a changed upstream layout it only warns — it never guesses.

## License

MIT
