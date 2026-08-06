# The executable contract: lesser's schema as the authority

Contentus consumes lesser's GraphQL surface. Until this milestone, nothing in the
repository could tell whether the documents it sent matched the contract lesser
publishes — and for the whole of M1, two of them did not.

## What went wrong

Both public article documents selected `Actor.avatarUrl`:

```graphql
author { id username displayName avatarUrl }
```

Lesser's `type Actor` has never published that field. It publishes `avatar`
(`docs/contracts/graphql-schema.graphql`). The name came from the vendored greater
adapter's own `Account` projection — greater's model of a fediverse server, not
lesser's — and it reached contentus's own queries by resemblance.

The consequence on a real instance is quiet rather than loud. Lesser rejects the
selection, `toAuthorSummary` reads a key no response carries, and
`str(undefined)` returns `null`. Every byline avatar was empty, and nothing said
why.

**Why the tests did not catch it.** They asserted the normalizer against fixtures
that had been written to match the query. The fixture said `avatarUrl: null`, the
normalizer read `avatarUrl`, and the assertion compared `null` to `null`. That is
not evidence about a contract — it is the same mistake entered twice, agreeing
with itself. A mock can only ever confirm that the client agrees with the client.

## What replaced it

`scripts/audit-graphql-contract.mjs` validates **every GraphQL document contentus
can send** against lesser's pinned canonical schema, on every build
(`pnpm run validate:graphql`, reached from `pnpm build`).

- **The schema** is pinned at `contracts/lesser/graphql-schema.graphql`, copied
  from lesser `staging` `e710ffb3`, with its repository, ref, upstream path,
  SHA-256, byte count and **git blob OID** recorded in
  `contracts/lesser/provenance.json`. The blob OID is what binds those bytes to
  lesser — see [Integrity is not provenance](#integrity-is-not-provenance).
- **The validator** is graphql-js — the reference implementation — not a
  hand-written parser. A parser is where a contract check would go wrong most
  quietly.
- **Discovery** parses each module with the TypeScript compiler and folds template
  literals, because these documents are stitched together from field fragments
  (`${ARTICLE_SUMMARY_FIELDS}`) and the text a reviewer reads is not the text
  lesser receives.

### It fails closed in four directions

| Case           | What bites                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Unknown field  | The document does not validate; the gate names the field and the type.                         |
| Edited schema  | The pinned SDL is checked against its digest, byte count and git blob OID _before_ it is used. |
| Wrong upstream | The declared repository, ref and path are dereferenced against lesser in CI.                   |
| Wrong schema   | A correctly pinned but older schema fails the documents that depend on newer fields.           |
| Omission       | A document the reader cannot fold, or folds and cannot parse, is a **failure**, never a skip.  |

The fourth is the one that matters most. "I could not determine what this sends"
must never read the same as "this is fine", because a document the gate cannot see
is exactly the document that reaches lesser unchecked.

### Where documents are found

Discovery is not keyed on naming convention. Membership is decided by
`graphql.parse` accepting an executable definition, so a document in `const x` is
found exactly as one in `const ARTICLES_QUERY`. Three things make coverage real
rather than nominal:

1. **Folding happens in the scope that owns the name.** `ARTICLES_INDEX_QUERY`
   imported into `cms/loaders.ts` interpolates a fragment that exists only in
   `cms/queries.ts`. An earlier version of this reader folded imported constants
   against the _importing_ module's bindings, where the name does not exist — so
   every executor site in `loaders.ts` came back "unreadable" instead of
   validated.
2. **Svelte components are walked.** `src/lib/timelines/TimelineFeed.svelte`
   really does declare a document; a walk keyed on `.ts` would have reported PASS
   over it.
3. **Transports are a channel, not a shape — and not a name.** Anything handed to
   lesser's transport is a document _by provenance_ and must fold, parse and
   validate, with no text heuristic involved.

   This was the part that had to be rebuilt. The first version of the reader held
   a table of NAMES (`{ callee: 'graphqlRequest' }`) and compared it with the
   identifier written at a call site. Adversarial review sent documents past it
   four ways, none of them exotic:

   ```text
   import { graphqlRequest as send } from './graphql';   send(document);
   const send = graphqlRequest;                          send(document);
   transport['graphqlRequest'](document);
   import { subscribe as open } from './subscription';   open({ query });
   ```

   The same document passed directly to `graphqlRequest` was caught, which is what
   proved the alias — not the value — was the bypass. And the shape screen cannot
   rescue any of them: a dynamically assembled anonymous document leaves no
   keyword in its literal chunks to recognize.

   `scripts/lib/transport-channels.mjs` roots the analysis at the transport
   **exports** — `src/lib/cms/graphql.ts#graphqlRequest`,
   `src/lib/timelines/subscription.ts#subscribe` — and follows the module graph
   out to every local name that refers to them: import aliases, defaults and
   namespaces, re-exports including `export * from`, variable aliases and aliases
   of aliases, destructuring, members of namespaces and object literals including
   the static computed form, and wrapper functions derived to a fixpoint across
   files. A wrapper that forwards a parameter into a channel _is_ a channel at
   that parameter, so `cms/compose.ts`'s private helper is transparent and an
   exported one is followed to its callers in other modules.

   Where the reading runs out, it says so rather than going quiet: a computed key
   on something carrying a transport, a transport used as a value rather than
   called, and a call written with a channel's name whose receiver could not be
   resolved are all findings. That last one is narrowed by the document slot, so
   it cannot fire on this tree's unrelated store and push-manager `subscribe`
   methods — precision is part of the control, because a gate that accuses correct
   code is a gate under pressure to be loosened.

## Integrity is not provenance

A digest beside the file it describes is not evidence about an upstream
repository. Both values live here and move in the same commit, so an author who
fabricates a schema and updates the digest gets a tree that is perfectly
self-consistent and still wrong — and a `ref` of forty `f` characters is invisible
to any offline check, because nothing offline dereferences a ref. Adversarial
review demonstrated both against the first version of this gate, which reported
PASS in each case.

The two checks are now separate, and they answer different questions.

| Check                          | Runs                 | Answers                                                  |
| ------------------------------ | -------------------- | -------------------------------------------------------- |
| `audit-graphql-contract.mjs`   | every build, offline | are these the bytes this repository pinned?              |
| `verify-schema-provenance.mjs` | CI, against GitHub   | did lesser publish these bytes, at that commit and path? |

The binding is git's own content addressing. A blob OID is
`sha1("blob " + length + "\0" + bytes)` — a pure function of the bytes — so the
OID computed from the local file is directly comparable with the OID GitHub
reports for `<repository>@<ref>:<upstream_path>`, with no local value trusted in
between. Fabricate the schema and the OID moves; name the wrong repository, ref or
path and nothing resolves; let the schema go stale and upstream's object is a
different one. None of those can be repaired by editing another field here.

`.github/workflows/schema-provenance.yml` runs it on every pull request. It is
deliberately not part of `pnpm build`: a build stays offline and deterministic,
and a network call folded into one either becomes flaky or earns a "skip when
offline" escape hatch — which is how a gate stops asserting anything.

### The vendored boundary

### The vendored boundary

`src/lib/greater/` is CLI-managed upstream source. Its adapter layer carries seven
GraphQL documents written against greater's own schema, which lesser does not
define. Those are excluded — but as a **declared, counted disclosure** in
`provenance.json`, per file, not as a silent skip. A vendored document appearing,
disappearing or changing shape fails the gate and has to be re-declared.

The exclusion is only defensible while contentus cannot execute what is inside
that tree, so that is checked rather than asserted. Two things had to change
before the check meant anything.

**The resolver is Vite's.** The boundary walk used to resolve specifiers with a
hand-written candidate list — the specifier, then `+ '.ts'`, `+ '.js'`, then
`/index.<ext>` — described as an over-approximation of the build. It was not one;
it was a different function. `src/lib/routes/ArticleReader.svelte` imports
`$lib/greater/faces/blog/components/Article/index.js` and the file on disk is
`index.ts`. The candidate list tested `index.js`, then `index.js.ts`, and answered
nothing. Adversarial review turned that into a demonstration: an outside module
importing a document-bearing vendored `adapter.ts` failed the gate as required,
and re-spelling the same import `adapter.js` made the gate PASS.

`scripts/lib/module-resolution.mjs` now asks a real Vite server's plugin container
— the same `resolveId` the build uses, with this repository's own config, so the
`$lib` and `$app/*` aliases, the bare `src/` alias the greater CLI emits, the
markdown stubs, the svelte plugin's extensions, TypeScript's `.js`→`.ts` mapping,
directory barrels and query suffixes all come for free and none of them is
restated here. Both build environments are resolved and unioned; a specifier that
resolves to different files in the two is reported rather than silently collapsed.
Loads the walk cannot follow — an unresolvable path, an unreadable module, a
computed `import(expr)` — are failures, because the boundary is a claim about
everything reachable and a gap in the walk is a gap in the claim. An unresolvable
_bare package_ is counted separately and does not fail: a package this repository
does not install cannot be a file inside the vendored tree.

**Execution starts at the build entries.** The walk used to root at every file
outside the vendored tree, which treats an ORPHAN as a root.
`src/lib/lesserTimelineStore.svelte.ts` is vendored source the greater CLI drops
at the lib root; nothing imports it, and it pulls in the whole `greater/adapters`
barrel. Under a correct resolver that formulation is unsatisfiable for reasons
that have nothing to do with what contentus runs — it only ever passed because the
old resolver could not follow `./LesserGraphQLAdapter.js` to a `.ts` file. The
roots are now `build_entry_points` from the pin, the same two names
`vite.config.ts` gives rollup.

That narrowing is not taken on trust. `tests/graphql-contract.test.mjs` runs the
**real two-pass Vite build** and asserts both directions: every in-tree module
either pass loads is inside the static closure — so the static walk is not missing
edges the build has — and no module the disclosure names is loaded by either pass.
The gate also prints how many outside files reach a forbidden module without being
executable, so the narrowing is counted rather than silent.

## The rule this encodes

`avatar` is lesser's field name, and lesser's response shape keeps it — through
the document, through `AuthorSummary`, through `toAuthorSummary`. The Greater blog
face wants `avatarUrl`, and it gets it in exactly one place: `toBlogFaceArticle`,
the view-model adapter whose whole job is that translation.

A field contentus wants that lesser does not expose remains an upstream issue
against `equaltoai/lesser`. It is never a name invented here, and — now — never a
name that can reach a build unnoticed.

## Evidence from a real instance

A schema check is a statement about a file. Whether a running lesser accepts these
documents is a different question, and this repository previously answered it with
a stale claim: that no instance was reachable. **That claim was false.** The
instance is reachable, credential-free, and the documents work.

Re-check it in one command, read-only and anonymous:

```
node --experimental-strip-types scripts/probe-live-contract.mjs \
  --base https://dev.trenchcoat.greater.website
```

`scripts/probe-live-contract.mjs` imports the documents from
`src/lib/cms/queries.ts` rather than retyping them, so it cannot drift from what
the app sends — the same defect, in the same shape, as fixtures that agreed with
the wrong query. It sends only queries; there is no mutation in it.

**Recorded 2026-08-06, anonymous, against `https://dev.trenchcoat.greater.website`:**

| Document                                 | Result                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `ARTICLES_INDEX_QUERY` (`first: 3`)      | HTTP 200, `totalCount 3`, three articles with slugs                                |
| `ARTICLE_NAVIGATION_QUERY`               | HTTP 200                                                                           |
| `ARTICLE_BY_SLUG_QUERY`                  | HTTP 200, 3095 bytes of content, `contentFormat MARKDOWN`                          |
| **Negative control** — `Actor.avatarUrl` | HTTP 422, `Cannot query field "avatarUrl" on type "Actor". Did you mean "avatar"?` |

The negative control is the part that makes the rest mean something. Without it a
green run proves only that the endpoint answers. With it, the instance itself
adjudicates the defect this milestone fixed: `avatar` is accepted, `avatarUrl` is
refused by name, and the refusal is lesser's own message rather than this
repository's opinion.

`author.avatar` came back `null` for all three actors. That is the field existing
and the actors having no avatar — which is exactly the distinction the old query
could not express, because a rejected selection and an absent value both arrived
as nothing.

### What is NOT proven, stated plainly

- **The deployed build is not this build.** PR #77 is not merged and not
  deployed; the artifact serving `/l/` predates it. Nothing here is evidence about
  the reviewed build's behaviour on an instance.
- **The deployed SSR cannot reach its own GraphQL endpoint.** `/l/` returns HTTP
  200 with strict CSP, and its hydration payload carries
  `unavailable: { reason: "transport" }` while the same anonymous query succeeds
  from outside. `/l/articles/<slug>` returns HTTP 404 with `data-page="article-reader"`
  — the route matches and the article fetch fails, consistent with one cause. Per
  `src/lib/cms/origin.ts` the SSR endpoint derives from the edge-injected
  `x-lesser-forwarded-host`, and this module fails closed when it is absent. This
  is a deployed-artifact/edge-configuration matter, not something the source diff
  in this PR changes, and it is recorded here rather than disguised.
- **Authenticated index/detail reads are absent.** The acceptance contract on
  issue #74 requires them. This session holds no token, was granted no lab deploy,
  and does not sign in as the operator or request a credential — so that half is
  unmet. It is an OPERATOR step: run the probe above with
  `CONTENTUS_PROBE_TOKEN` in the environment, against a build that includes this
  PR. The harness reads the token only from the environment, sends it as a bearer
  header, and never prints, writes or returns it.

**The milestone is therefore not complete.** The exact blocker is: no operator
authorization to deploy this branch to the dev instance, and no credential for an
authenticated read — both operator-held, neither self-grantable.

## Moving the pin

Copy `docs/contracts/graphql-schema.graphql` from lesser at the new ref, update
`ref`, `sha256`, `bytes` and `git_blob_sha1` together (`git_blob_sha1` is exactly
`git hash-object <file>`), then run `pnpm run validate:graphql` for the documents
and `pnpm run validate:schema-provenance` for the upstream object. Every document
is re-validated against the new schema, so a field lesser removed fails the build
in the same commit that adopts the removal. That is the point of pinning the
contract rather than trusting it.
