# lesser's schema is the authority — what contentus pinned, and what it checks

Status: recorded at M2 (2026-08-06), against lesser `main` at
`cbe9787f9b97c1cc6472183834cfd066e61801b2` and greater-components
**greater-v0.13.1** (`fb6ee927`). The pin moved to **lesser v1.6.4**
(`38034eef6`) and **greater-v0.13.4** at the 2026-08-09 contract sync; the
inventory counts below are current (eleven modules, forty-six documents), and
every document now validates against the v1.6.4 schema.

A thin consumption note. Contentus owns no GraphQL contract; this records what it
reads, what it pinned, and what it now refuses to ship.

## The defect

Contentus selected `Actor.avatarUrl` on both public article documents.

Lesser's `type Actor` has never published that field. It publishes `avatar: String`
— in `docs/contracts/graphql-schema.graphql` and identically in `graph/core.graphql`
— and the string `avatarUrl` does not occur anywhere in either file. Where it _does_
occur in lesser is instructive: `auth-ui/src/lib/greater/adapters/mappers/lesser/`,
which is auth-ui's own vendored copy of the greater adapter, plus Mastodon-compat
REST handlers and OAuth-provider account plumbing. It is greater's name and
Mastodon's name. It was never lesser's GraphQL name, and it reached these queries by
resemblance to the vendored adapter's `Account` projection.

The failure was quiet by construction. Lesser rejects the selection; `toAuthorSummary`
read a key no response carries; `str(undefined)` returned `null`; every byline avatar
was empty, with nothing anywhere saying why.

**Why nothing caught it.** The only things checking these documents were fixtures
written to match them. The fixture said `avatarUrl: null`, the normalizer read
`avatarUrl`, and the assertion compared `null` to `null` — the same mistake entered
twice, agreeing with itself. A mock agrees with the client. Only the schema disagrees
with a wrong document.

## Where the rename lives now

One line, in the function whose whole job is translation.

| Layer                                 | Field name  | Why                                                                      |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `cms/queries.ts` `AUTHOR_FIELDS`      | `avatar`    | It is lesser's field. The document asks for what exists.                 |
| `cms/types.ts` `AuthorSummary`        | `avatar`    | This is the RESPONSE shape — what came off the wire.                     |
| `cms/articles.ts` `toBlogFaceArticle` | `avatarUrl` | THE BOUNDARY. The vendored blog face's `normalize.ts` reads `avatarUrl`. |

Neither side carries the other's vocabulary, and the translation is visible in one
place instead of implied everywhere.

## The pin

`contracts/lesser/graphql-schema.graphql` is a byte-for-byte copy of lesser's
canonical schema, with `contracts/lesser/provenance.json` beside it.

Two properties, deliberately not conflated:

- **Integrity is offline.** `scripts/audit-graphql-documents.mjs` recomputes the
  SHA-256 before it validates anything, so a schema edited in the same pull request
  as the documents it judges fails the build. This proves the bytes have not drifted
  _here_. It proves nothing about upstream.
- **Provenance is the git blob id.** `blob_sha1` is the object id lesser itself
  records for that path at that ref. Anyone can check it in one call, against lesser
  rather than against us:

  ```
  gh api repos/equaltoai/lesser/contents/docs/contracts/graphql-schema.graphql?ref=<ref> --jq .sha
  git hash-object contracts/lesser/graphql-schema.graphql
  ```

  A green offline run is never reported here as evidence of provenance.

There is no build-time network dereference, on purpose. The M2 predecessor grew four
layers of defence around that one question and still had to be told, by review, that
its pin had been able to choose its own examiner.

## The gate

`pnpm run validate:graphql`, part of `pnpm run build`.

An **explicit inventory** — eleven modules, forty-six documents, listed by name in
`scripts/lib/graphql-inventory.mjs` — parsed and validated by `graphql-js`. No
GraphQL parser was written; writing one is where a contract check would go wrong most
quietly.

The list is checked rather than trusted. Four ways it fails:

1. an inventoried constant the module does not declare;
2. an inventoried constant that is not a GraphQL document;
3. an operation-bearing constant in an inventoried module that is not listed;
4. an operation-bearing constant in _any_ contentus-authored `.ts` module under
   `src/` that the inventory does not mention at all.

Plus the fail-closed case: a constant whose source text carries an operation keyword
but which the reader's closed grammar cannot resolve is an **error**, not a skip. A
document the gate cannot resolve is a document nobody validated, and passing over one
would be certifying silence.

"Contentus-authored" is decided by `components.json` — the CLI's own record of the
files it manages — rather than by a second hand-kept path list that would fall behind.

### What it does not do

It does not walk a module graph, model a transport, resolve imports, claim
reachability, or touch the network. Whether a document is _reached_ by a build entry
is a different question from whether it is _valid_; this control answers the second
one only. The rejected predecessor conflated them and grew ~5,000 lines doing it.

### It bites

Reintroducing `avatarUrl` into `AUTHOR_FIELDS` and re-running the gate:

```
2 finding(s):
  - src/lib/cms/queries.ts:92 ARTICLES_INDEX_QUERY (document line 31, column 2)
      Cannot query field "avatarUrl" on type "Actor". Did you mean "avatar"?
  - src/lib/cms/queries.ts:131 ARTICLE_BY_SLUG_QUERY (document line 27, column 2)
      Cannot query field "avatarUrl" on type "Actor". Did you mean "avatar"?
```

## What is NOT proven here

**No live-instance read.** The documented dev instance `trenchcoat.lesser.host` does
not resolve in DNS, and `lab.lesser.host/api/graphql` answers `404` — it is the
control plane, not an instance's GraphQL surface, and its `/` answers `200`, so the
network path is fine and the endpoint simply is not there. Both anonymous article
queries were attempted and neither reached a lesser instance.

That is the **absence** of evidence, recorded as such, and it is not evidence that
the queries fail. The corrected documents are proven against lesser's own schema and
through the built SSR route harness; proving them against a running instance is an
operator-run install step. No authenticated runtime proof is claimed: this session
holds no credential and ran no deploy.

## Where a gap goes

A field contentus wants that lesser does not publish is an upstream issue against
`equaltoai/lesser`. It is never a compatibility field invented here, never a
client-side substitute, and never a second transport. That is the rule this whole
milestone exists to make mechanical.
