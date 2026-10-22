# Publishing

Four packages, published in dependency order: `@sealpost/core`, `@sealpost/react`, `@sealpost/sdk`, `@sealpost/cli`.

## One-time setup

1. Create the npm organization `sealpost` (free, public packages).
2. Create a granular access token scoped to `@sealpost/*` with publish permission and bypass-2FA enabled.
3. Add it to GitHub as the repository secret `NPM_TOKEN`.

## Release

```bash
npm run ci                       # must be green
npm version 0.1.0 --workspaces --no-git-tag-version   # only if bumping
git tag v0.1.0 && git push origin v0.1.0
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which re-runs CI and publishes core, react, sdk, then cli with provenance.

## Manual publish

```bash
npm run build
npm publish -w @sealpost/core --access public
npm publish -w @sealpost/react --access public
npm publish -w @sealpost/sdk --access public
npm publish -w @sealpost/cli --access public
```

The CLI bundles the static Studio (`studio-dist`) at build time, so `npm run build` must run first.

## Verify

```bash
npx @sealpost/cli@latest --version
npm view @sealpost/core dist.tarball
```

`npm run smoke` packs all four tarballs, installs them into a clean temp app and exercises init, compile, send, receipts, the Studio server and concurrent dedupe, so a broken package layout is caught before publish.

## Ruby and PHP SDKs

```bash
# Ruby (RubyGems): create an API key at rubygems.org first
cd sdks/ruby && gem build sealpost.gemspec && gem push sealpost-0.1.0.gem
```

PHP is published by Packagist from the repository: submit `https://github.com/isagarpinninti/sealpost` at packagist.org and point it at `sdks/php` (a monorepo subdirectory needs a split repository or a `composer.json` at the root of a tag; the common approach is a read-only split repo such as `isagarpinninti/sealpost-php`).

## Python and Go SDKs

They are versioned independently of the npm packages and are not part of the tag-triggered npm release.

```bash
# Python (PyPI): create an API token at pypi.org first
cd sdks/python && python3 -m pip install build twine && python3 -m build && python3 -m twine upload dist/*
```

```bash
# Go: modules publish by tag; the module lives in a subdirectory, so the tag carries its path
git tag sdks/go/v0.1.0 && git push origin sdks/go/v0.1.0
```

CI runs `python -m unittest` and `go test ./...` for both on every push.
