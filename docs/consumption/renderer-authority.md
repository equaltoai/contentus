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

| Path | Renders? | Evidence |
| --- | --- | --- |
| ActivityPub serialization | yes | `pkg/storage/repositories/object_repository.go` substitutes `rendered.HTML` from `cmsrender.RenderArticleContent` |
| `draftPreview` | yes | `graph/cms_converters.go` builds `DraftPreview` from `cmsrender` output |
| GraphQL `Article.content` | **no** | `graph/cms_converters.go` assigns `Content: article.Content` — the stored value, unrendered |

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
  (`src/lib/cms/articles.ts`) is the single gate: `HTML` is displayed,
  everything else is withheld and the reader renders an explicit
  "awaiting server-rendered output" state.
- **It does not add its own sanitizer.** The vendored greater blog face applies
  greater's `sanitizeHtml` to HTML-format content as defence-in-depth. That is
  upstream-owned code, not a contentus renderer, and contentus does not
  second-guess it.

When lesser renders on the read path — or exposes a `renderedHtml` field
mirroring `DraftPreview.renderedHtml` — `resolveArticleBody` is the one
function that changes, and the withhold branch disappears.

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
tokens. Contentus registers as `client_class: web` deliberately — a Relay
connection query (`articles → edges → node → field`) is depth 4 at minimum and
cannot be expressed under a cap of 3 at all. This is worth knowing for
lesser-body, which exposes CMS operations to agent tokens.

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

**Dark theme still incomplete (emdash's U-18, re-confirmed).** At
greater-v0.11.9 the blog face carries seven `[data-theme='dark']` rules, all
scoped to `.gr-blog-article-card`. Article prose and headings remain pinned to
light neutrals with no dark counterpart, so `data-theme="dark"` would render
near-black text on the Midnight ground. Product design §2 asks for a straight
ramp map *if* the faces now ship full dark themes; they do not, so contentus
keeps the ramp inversion in `src/lib/brand/bridge.css`.

**CLI defects at greater-v0.11.9.** `greater add` rewrote contentus-owned
`package.json` devDependencies to nonexistent versions (`vite ^10.0.1`,
`@types/node ^3.1.0`, `typescript ^6.0.0`, and others) and replaced a pinned
tarball dependency with a nonexistent semver range. Separately, it emits
vendored imports as bare, unresolvable specifiers (`from 'src/lib/greater/utils'`)
in 65 files — the alias *target* rather than an alias-prefixed path. The first
was corrected in place (package.json is contentus-owned); the second is
absorbed by a resolve alias in `vite.config.ts` and `tsconfig.json`, because
vendored source is never hand-edited.

## Routing these upstream

Contentus's GitHub binding covers `equaltoai/contentus` only, so none of the
above can be filed directly against `equaltoai/lesser` or
`equaltoai/greater-components`. They are reported to Factory for routing to the
owning stewards, per the M1 brief: *a missing capability is an upstream issue
reported back to Factory, never a local workaround.*
