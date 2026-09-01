# Renderer authority — what contentus consumes, and what it refuses

Status: recorded at M1 (2026-07-30), verified against the pinned lesser and
greater-components checkouts.

This is a thin consumption note, not a redefinition of anyone's contract. It
records what contentus observed while wiring Face 1, and what it decided to do
about it.

## The contract

lesser's CMS contract is explicit
(`docs/architecture/cms/fediverse-first-blog-cms-contract.md`, "Renderer
authority contract"):

> The server owns the publication renderer. Clients and agents may provide
> source, but they do not define the canonical rendered output.
>
> `contentFormat` records the submitted source format; public output is always
> the server-rendered/sanitized representation.
>
> Draft preview, public browser HTML, and ActivityPub `Article.content` must be
> derived by the same server render/sanitize authority.

Contentus consumes that output and adds nothing to it.

## What contentus observed

At the pinned lesser checkout, the GraphQL article read path does **not** run
the publication renderer:

| Path                      | Renders? | Evidence                                                                                                          |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| ActivityPub serialization | yes      | `pkg/storage/repositories/object_repository.go` substitutes `rendered.HTML` from `cmsrender.RenderArticleContent` |
| `draftPreview`            | yes      | `graph/cms_converters.go` builds `DraftPreview` from `cmsrender` output                                           |
| GraphQL `Article.content` | **no**   | `graph/cms_converters.go` assigns `Content: article.Content` — the stored value, unrendered                       |

Two supporting details:

- `pkg/services/cms/draft_service.go` stores `Content: draft.Content` at
  publish time, so what is persisted is the author's **source**, not rendered
  output.
- `pkg/services/cms/article_service.go`'s `validateArticleRenderable` calls
  `RenderArticleContent` but keeps only `rendered.SourceFormat`, discarding
  `rendered.HTML`. It validates renderability; it does not render.

### Consequences

1. **Renderer authority.** For `contentFormat: MARKDOWN`, GraphQL returns raw
   Markdown source. A client that "just renders it" becomes the second
   canonical renderer the contract forbids.
2. **Sanitization.** For `contentFormat: HTML`, GraphQL returns author-submitted
   HTML that was validated but never passed through `SanitizeArticleHTML` in
   storage. A consumer that injects it directly inherits stored XSS. The
   contract anticipates this — "HTML input is permitted only as input to the
   server sanitizer pipeline, not as trusted already-safe output" — which is
   precisely why the read path returning it unsanitized matters.

## What contentus does about it

Nothing local that would paper over it. Specifically:

- **It does not render Markdown.** No Markdown rendering package is a contentus
  dependency, and `scripts/audit-renderer-authority.mjs` fails the build if one
  appears.
- **It does not display raw source.** `resolveArticleBody`
  (`src/lib/cms/articles.ts`) is the single gate: canonical `renderedHtml` and
  legacy `HTML` are displayed, everything else is withheld and the reader
  renders an explicit, reader-facing "isn't available yet" state.
- **It does not add its own sanitizer.** The vendored greater blog face applies
  greater's `sanitizeHtml` to HTML-format content as defence-in-depth. That is
  upstream-owned code, not a contentus renderer, and contentus does not
  second-guess it.
- **The ONE owned display sink** is `src/lib/review/PreviewBody.svelte`, the
  authenticated review preview, added for #112 (2026-08-31). It displays
  `draftPreview.renderedHtml` — HTML lesser rendered AND sanitized server-side,
  fetched behind `includeAccessUrls: true` — with no second pass: the fediverse
  allowlist in `Article.Content` strips lesser's own `<figure>`/`<img>`, which
  is exactly the operator-reported failure this closes. lesser is the single
  renderer and sanitizer of those bytes; displaying them untransformed is
  renderer authority honored, not bypassed. The sink is pinned by
  `scripts/audit-renderer-authority.mjs` — read with the Svelte compiler and
  TypeScript parser since the round-1 adversarial review (one sink, bound to
  `preview.html` verbatim, type-only imports, no script statement beyond the
  one `$props()` destructure, no markup `{@const}`) and probed by
  `tests/renderer-authority-audit.test.mjs`; every other owned template still
  fails the build on an HTML sink, and every owned executable file fails on an
  alternate raw-HTML sink — `.innerHTML`/`.outerHTML`/`.srcdoc` writes in every
  spelling (property access, element access, constant-folded keys, compound and
  update forms), `.insertAdjacentHTML` and `.createContextualFragment` calls,
  `document.write`/`document.writeln` including locally aliased documents,
  `Reflect.set` and `Object.assign` reaching a raw-HTML property, `srcdoc`
  attributes and iframe attribute spreads in templates and JSX, and any
  computed key the parsers cannot fold (the round-2 evasion shapes) — the gate
  fails closed wherever it cannot establish safety, and a computed write on a
  receiver provably bound from a non-DOM container (an object literal,
  `Object.create(null)`, `new Map()`/`Headers()`/…) is the one cleared shape.
  The same audit also binds the preview VALUE PATH (round-2): every
  `PreviewBody` invocation must pass the preview value itself, verbatim, bound
  only from the `loadDraftPreview` result — a parent `$derived` that spreads
  `preview` and rewrites `preview.html` before the sink fails the build.
  Round-5 (R5-1) widened the value binding from the identifier to the VALUE:
  the reading follows the preview reference through declaration and assignment
  aliases, TypeScript wrapper nodes (`(preview)`, `preview!`, `preview as X`),
  the same-reference runes `$state`/`$state.raw`, object-literal containers and
  their property reads, array/map containers that receive the value, and local
  functions that return it — a write to `.html` on any of them is a finding, a
  mutation API (`Object.assign`, `Reflect.set`, `defineProperty`,
  `defineProperties`) receiving any of them is a finding, and a CALL handed the
  value is a finding unless the callee is a local function this reading proves
  never writes to its parameters; an imported or unproven callee fails closed.
  Dynamic routes fail closed too: a `svelte:component` in a file that reaches
  PreviewBody, or any dynamic `import('…PreviewBody.svelte')` in owned source,
  cannot be statically proven direct, and the canonical file with no static
  import/invocation at all is a finding, never a silent scan. Round-5 (R5-4)
  also closed four alternate-sink launderings: destructured, renamed dangerous
  methods off DOM or unproven receivers (failing closed), identifier-laundered
  `Object.assign` source objects, case-insensitive `srcdoc`/`setAttribute`
  attribute names, and `document.execCommand('insertHTML', …)` — while
  `$state.raw(<object/array literal>)` is recognized as a legitimate non-DOM
  container (R5-5), so its computed writes stay clean.

**Resolved upstream, 2026-08-07.** lesser v1.6.2 added exactly the field this
note said would close the gap: `Article.renderedHtml`, documented in-schema as
"Canonical sanitized HTML. Never fall back to rendering content when this
field is unavailable." greater-v0.13.2 (#1005) consumes it in the blog face's
normalization (canonical `renderedHtml` preferred, format forced to `html`,
escaped fallback retained when absent). `resolveArticleBody` changed in the
one place predicted below: a non-empty `renderedHtml` is the body, outranking
`contentFormat`; the withhold branch remains only for instances that predate
the field or return it blank. The audit copy that blamed an "upstream gap"
was wrong twice over — lesser never pre-renders into storage, and the read
path now carries the authority's output — and was rewritten to plain
reader-facing language in the same change.

## Related observations, same milestone

**No tombstone on the CMS read path.** lesser's GraphQL schema has no
`Tombstone` type and `articleBySlug` returns `Article | null`, so a deleted
article and one that never existed are indistinguishable. Contentus serves 404
for both rather than guessing at 410. Issue #8 asks for 410 handling; it is not
expressible against today's contract.

**No series listing.** `series(id:)` and `seriesBySlug(slug:)` exist, but there
is no query that lists series. The index therefore offers category navigation
but not series navigation. Assembling a listing client-side from article pages
would be an invented operation, so it was not done.

**GraphQL depth.** `GRAPHQL_MAX_DEPTH` defaults to 12 for ordinary callers;
the depth-3 cap in `cmd/graphql/main.go` applies only to agent and CLI-class
tokens. Contentus registers its public browser client through `/api/v1/apps`,
the same ordinary app-registration path simulacrum uses. `client_class` is
optional on that endpoint and omission receives ordinary non-CLI treatment;
contentus omits it, because simulacrum omits it and simulacrum is the proven
client for this flow. A Relay connection query
(`articles → edges → node → field`) is depth 4 at minimum and cannot be
expressed under a cap of 3 at all. This is worth knowing for lesser-body, which
exposes CMS operations to agent tokens.

## greater-components

**The blog face requires a Markdown renderer it does not use.** The face's
registry manifest lists `content` in its required `shared` set, and `content`
carries `MarkdownRenderer.svelte` and `CodeBlock.svelte`, which pull
`remark-parse`, `remark-gfm`, `remark-rehype`, `mdast-util-*`, and `shiki`.
The face's own `Article.Content` deliberately refuses to render Markdown — its
comment reads "Lesser/server owns canonical public rendering and sanitization"
— so the renderer arrives through a sibling module the reading surface never
needs.

Contentus declines to install that chain. The cost is that `greater doctor`
reports missing npm dependencies; the alternative is shipping a second
canonical renderer to satisfy a checker. Checksums, component files, and
orphan detection are all clean — the integrity properties the gate exists for.

Declining has a second cost worth recording, because it is not obvious. The
face's `Article.Content` imports `sanitizeHtml` from the
`src/lib/greater/utils` barrel, and that same barrel re-exports
`html-to-markdown.ts`. Vite tree-shakes the dead branch out of the bundle, but
both the typechecker and the bundler resolve the whole import graph first — so
an absent package fails the build even though nothing calls it. Contentus
handles that by declaring the three modules absent rather than installing them:

- `src/types/absent-renderer-modules.d.ts` for the typechecker, and
- a `vite.config.ts` alias onto `src/lib/build/absent-renderer-module.ts`
  for the bundler.

The stub throws rather than returning empty values: if that branch ever stops
being dead, it must fail loudly at the call site instead of silently behaving
like a renderer that produced nothing. Both files are deleted the day the blog
face stops requiring `content`.

This was caught only by a clean `rm -rf node_modules && pnpm install
--frozen-lockfile`. An earlier build passed against a `node_modules` still
holding the packages `greater add` had installed before contentus's pins were
restored — the same stale-tree trap emdash recorded. Build evidence is only
trustworthy from a clean install.

**The blog face's Article context uses runes in a plain `.ts` module.** At
greater-v0.11.9, `faces/blog/components/Article/context.ts` calls `$state(...)`,
but Svelte 5 runes are compiler directives — they only exist if something
compiles them. vite-plugin-svelte compiles runes in non-component modules only
when the filename carries the `.svelte.` infix, which this file does not have.
Nothing compiles it, `$state` survives verbatim into the bundle, and the article
reader throws `ReferenceError: $state is not defined` the first time an article
actually loads. Two sibling vendored modules get this right
(`utils/use-stable-id.svelte.ts`, `primitives/components/Menu/context.svelte.ts`),
so the convention is understood upstream — this one file misses it.

The defect is invisible in `pnpm dev`, where Vite's SSR resolves the rune through
Svelte's runtime import graph. Only the built artifact fails, which is why the
probes in `tests/ssr-probe.test.mjs` drive `build/server/handler.mjs` rather
than a dev server.

Contentus absorbs it in `vite.config.ts` through the plugin's own supported hook
(`experimental.compileModule.include`), scoped to the whole vendored tree so a
CLI pin bump that adds another such module keeps working. No vendored byte
changes — the file is checksummed, and the fix it actually wants is a rename to
`context.svelte.ts`. `tests/vendored-runes.test.mjs` asserts no shipped bundle
carries an uncompiled rune.

**Dark theme (emdash's U-18) — resolved upstream, 2026-08-07.** At
greater-v0.13.2 the blog face ships 46 `[data-theme='dark']` selectors (cards,
prose, headings, review surfaces) and the primitives theme 47 more. The shell
root now carries `data-theme="dark"` (AppShell.svelte — on the shell rather
than `<html>`, because FaceTheory v4.0.6's adapter pipeline drops `htmlAttrs`
from renderOptions; the `--gr-color-gray-*` ramp itself comes from the greater
tokens layer at `:root`), and the inverted `--gr-color-neutral-*` ramp
in `src/lib/brand/bridge.css` is deleted — nothing vendored consumes
`--gr-color-neutral-*` at v0.13.2. The bridge keeps only small companion rules
that re-ground card and article surfaces on the `--tc-*` brand surfaces.
Residual coverage holes (`gr-blog-author-card`, `.gr-menu`) are routed upstream
as greater-components#1009.

**CLI defects at greater-v0.11.9.** `greater add` rewrote contentus-owned
`package.json` devDependencies to nonexistent versions (`vite ^10.0.1`,
`@types/node ^3.1.0`, `typescript ^6.0.0`, and others) and replaced a pinned
tarball dependency with a nonexistent semver range. Separately, it emits
vendored imports as bare, unresolvable specifiers (`from 'src/lib/greater/utils'`)
in 65 files — the alias _target_ rather than an alias-prefixed path. The first
was corrected in place (package.json is contentus-owned); the second is
absorbed by a resolve alias in `vite.config.ts` and `tsconfig.json`, because
vendored source is never hand-edited.

## FaceTheory

**Strict CSP and the canonical `<link>` — resolved at FaceTheory v4.0.6.** At
v4.0.1, `renderFaceHead` validated every head `<link href>` under a strict
policy as same-origin-or-relative, resolving "same origin" against an
`allowedOrigin` option that `FaceApp` never forwarded: `dist/app.js` called
`renderFaceHead(out, { cspNonce })` and nothing else, so the only shape that
passed was a relative URL and any absolute href threw — taking the whole route
to a 500, which is exactly what the loaded-article path did before the reader
component ever ran (a branch the degraded-path audits could not reach, because
an article that fails to load emits no canonical tag at all). Contentus's
workaround emitted the same-origin identity in relative form.

FaceTheory v4.0.6 (theory-cloud/FaceTheory#404) closes the call-site gap:
`toHTTPResponse` now derives a per-request `allowedOrigin`
(`allowedOriginForRequest` in `dist/app.js`) from a configured
`canonicalOrigin`, the `x-facetheory-original-host` /
`x-apptheory-original-host` + `cloudfront-forwarded-proto` pairs, or the
generic `x-forwarded-host` / `x-forwarded-proto` (rightmost) with a `host`
fallback, and forwards it into `renderFaceHead`. The relative-form workaround
is retired: the canonical link carries lesser's absolute Article identity.

One trust-boundary consequence, handled in `normalizeEvent` in
`src/facetheory/entry-server.ts`: the generic headers FaceTheory reads are
viewer-settable on `/l/*` (CloudFront forwards viewer headers verbatim; only
the `x-lesser-forwarded-*` pair is overwritten at the edge). So contentus
replaces any viewer-supplied `x-forwarded-host` / `x-forwarded-proto` with the
edge-verified values before FaceTheory sees the request, and deletes both when
no trusted origin exists — the origin the strict-CSP check validates against
is the one lesser verified, never one a viewer named. The same-origin guard in
`canonicalLinkHref` stays: a cross-origin syndicated canonical can never pass
the check and still gets no link tag (rather than a 500), with `og:url`
carrying the absolute identity as before.

## Routing these upstream

Contentus's GitHub binding covers `equaltoai/contentus` only, so none of the
above can be filed directly against `equaltoai/lesser` or
`equaltoai/greater-components`. They are reported to Factory for routing to the
owning stewards, per the M1 brief: _a missing capability is an upstream issue
reported back to Factory, never a local workaround._
