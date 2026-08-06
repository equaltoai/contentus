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
  SHA-256 and byte count recorded in `contracts/lesser/provenance.json`.
- **The validator** is graphql-js — the reference implementation — not a
  hand-written parser. A parser is where a contract check would go wrong most
  quietly.
- **Discovery** parses each module with the TypeScript compiler and folds template
  literals, because these documents are stitched together from field fragments
  (`${ARTICLE_SUMMARY_FIELDS}`) and the text a reviewer reads is not the text
  lesser receives.

### It fails closed in four directions

| Case          | What bites                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- |
| Unknown field | The document does not validate; the gate names the field and the type.                        |
| Stale schema  | The pinned SDL is checked against its recorded digest and byte count _before_ it is used.     |
| Wrong schema  | A correctly pinned but older schema fails the documents that depend on newer fields.          |
| Omission      | A document the reader cannot fold, or folds and cannot parse, is a **failure**, never a skip. |

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
3. **Transports are a channel, not a shape.** Anything handed to `graphqlRequest`
   or to `subscribe({ query })` is a document _by provenance_ and must fold, parse
   and validate — no text heuristic involved. Where a private helper forwards a
   document as a parameter (`cms/compose.ts`, `cms/review-transport.ts`), the
   reader derives that helper as a channel and follows its callers, rather than
   carrying a hand-maintained list of forwarders that would go stale.

### The vendored boundary

`src/lib/greater/` is CLI-managed upstream source. Its adapter layer carries seven
GraphQL documents written against greater's own schema, which lesser does not
define. Those are excluded — but as a **declared, counted disclosure** in
`provenance.json`, per file, not as a silent skip. A vendored document appearing,
disappearing or changing shape fails the gate and has to be re-declared.

The exclusion is only defensible while contentus cannot execute what is inside
that tree, so that is checked rather than asserted: the gate walks the import
closure from every module _outside_ the tree and fails if any document-bearing
module _inside_ it is reachable, transitively.

## The rule this encodes

`avatar` is lesser's field name, and lesser's response shape keeps it — through
the document, through `AuthorSummary`, through `toAuthorSummary`. The Greater blog
face wants `avatarUrl`, and it gets it in exactly one place: `toBlogFaceArticle`,
the view-model adapter whose whole job is that translation.

A field contentus wants that lesser does not expose remains an upstream issue
against `equaltoai/lesser`. It is never a name invented here, and — now — never a
name that can reach a build unnoticed.

## Moving the pin

Copy `docs/contracts/graphql-schema.graphql` from lesser at the new ref, update
`ref`, `sha256` and `bytes` together, and run `pnpm run validate:graphql`. Every
document is re-validated against the new schema, so a field lesser removed fails
the build in the same commit that adopts the removal. That is the point of pinning
the contract rather than trusting it.
