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
  the same-reference runes `$state`/`$state.raw`, object-literal containers
  and their property reads, array/map containers that receive the value, and
  the results of local functions proven to return it. As round-5 through
  round-7 shipped, that last carrier was narrower than it read: a function
  counted as returning the value only when its return expression was ALREADY a
  tracked name, so a relay taking the value as a parameter (`function relay(p)
{ return p }`) was not a carrier — the parameter never joined the value
  names, and a write to the relay's result laundered the identity clean. The
  round-8 review planted exactly that (R8-2); the reading now binds a local
  callee's parameters as value names whenever a call site hands the value in,
  so a parameter relay IS a carrier, and declaration, inline, `await`, and
  `.then` reads of the call's result bind the identity — sync, async,
  generator, arrow, and multi-hop local call chains alike. `.then`/`.catch`
  callbacks on a value-carrying expression bind their parameter the same way,
  and `await`/`Promise.resolve(<value>)` are read as same-reference wrappers.
  As round-8 shipped, that claim was still narrower than it read: the
  parameter binding fired only when the call site HANDED the value in, so six
  relay spellings laundered the identity clean — a default-parameter
  initializer reading the value with no argument at the call site, a rest
  parameter whose element read carried nothing, `await Promise.all([preview])`
  destructured, `Promise.all([preview]).then(([p]) => …)`, a second `.then`
  hop whose receiver is the first `.then` call, and an inline IIFE returning
  the value. The round-9 review planted all six (R9-3) and the reading now
  binds default initializers at call sites that leave the position to the
  default, records rest parameters as array containers so element reads of
  them carry the identity, models `Promise.all`/`Promise.allSettled`
  fulfillments as arrays holding the reference at the argument positions
  (the awaited destructure and the `.then` destructure alike), reads
  `.then`/`.catch`/`.finally` call results as carriers — multi-hop, with a
  `.then` callback's return analyzed the way the collection transforms'
  returns are — and treats an inline IIFE returning the value as a relay,
  while a provably fresh literal return stays clean.
  A write to `.html` on any of these is a finding, a mutation API
  (`Object.assign`, `Reflect.set`, `defineProperty`, `defineProperties`)
  receiving any of them is a finding, and a CALL handed the value is a finding
  unless the callee is a local function this reading proves never writes to
  its parameters; an imported or unproven callee fails closed.
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

  Round-6 (R6-1/R6-2/R6-3) added the cross-file component/value flow
  analysis: the canonical file can hand the PreviewBody COMPONENT and the
  preview VALUE to a wrapper through props, and the wrapper can invoke them via
  `<svelte:component this={body} preview={value}/>` with no PreviewBody import
  of its own — a second live route the per-file reading never saw. The
  cross-file reading (over the owned Svelte module graph, resolved through the
  `$lib`/relative aliases the toolchain uses) rejects the routes it can
  resolve: a `svelte:component` carrying a `preview` attribute must resolve
  `this` to a component provably free of preview flow; a static invocation of a
  known preview-reaching component must pass provably non-preview values for
  every preview-flowing prop (renamed/shorthand attributes and `$props()`
  destructuring followed); and the PreviewBody component itself may appear only
  in the canonical invocation — handing it through a prop is a finding. As
  round-6 shipped, two gaps remained, and the round-7 review planted both:
  static invocations whose callee resolved to a prop, an unbound name, a dotted
  member, or an owned barrel were skipped rather than failed closed, and markup
  spreads were counted but never read. **R6-2** widened the value identity to non-identifier bindings:
  object/array destructuring and assignment patterns (including rest), getters
  whose return can carry the preview (failing closed on unprovable returns),
  class constructors and `new` expressions, `for (const x of [preview])` loop
  bindings, `try { throw preview } catch (e)` bindings, and array-iteration
  callbacks (`[preview].forEach((p) => …)`); `$state.raw` containers and
  provably non-preview destructures stay clean. **R6-3** followed aliases of
  dangerous built-in callees and methods — `const A = Object.assign`,
  destructured `{ assign } = Object`, `document.execCommand` extractions, and
  `.call`/`.apply`/`.bind` routes all dispatch through the same argument logic
  as the direct spelling — plus call-result payloads (`Object.assign(frame,
payload())`) and rest/spread payload arrays (`Object.assign(frame,
...spreads)`), failing closed on unresolved payloads into receivers that
  cannot be proven non-DOM; `execCommand('copy')` and `Object.assign(state,
defaultState(), initial)` on a provable container stay clean. Two narrow
  residual rules were added rather than documented away: `setHTMLUnchecked`
  (Chromium's un-sanitizing setter, always dangerous when called) and JSX
  `dangerouslySetInnerHTML`. What is deliberately NOT scanned is stated here:
  `eval`, `new Function`, and string-literal timer primitives are
  code-execution primitives, not HTML sinks, and contentus's strict CSP
  (`script-src` without `unsafe-eval`/`unsafe-inline`, enforced by
  `scripts/audit-csp.mjs` and the FaceTheory route-scoped headers) is the
  standing control for them; expanding the renderer-authority gate into a
  generic security scanner would trade a precise, provable claim for a broad
  one.

Round-7 (R7-1/R7-2/R7-3/R7-4) closed those gaps and the launderings the
round-7 adversarial review planted beside them, and this note was corrected
to what the gate proved at each round rather than what it claimed.
**R7-1** fails closed on static Svelte invocations whose callee is a prop,
an unbound name, a dotted member, or an owned module no resolution proves a
component, whenever a preview-flowing value can reach them; markup spread
objects are READ — keys, shorthand, computed keys folded through constant
strings, aliases, local helper returns, and nested spreads — and a spread the
reading cannot resolve fails closed; dotted callees are resolved
conservatively (a prop-supplied namespace member is never a trusted owned
component); imports resolve through owned barrels by following `export …
  from` chains, an unchased chain being unproven rather than benign; legacy
`export let`, `$props()` rest/nested/bindable forms, and markup `{@const}`
aliases feed the same resolution; and the canonical file's MARKUP gets the
same PreviewBody-name scan its script always had. **R7-2** derives the
executable source universe from reachability instead of the `src/` walk: an
executable module outside the classified owned/vendored roots that owned
code or a build entry loads — by the route spellings the round-7 gate
modeled, static or dynamic import, re-export, string-literal glob, relative
alias, root-relative path, query-suffixed specifier, case variant, or
symlink — is a finding, followed hop by hop, with dependencies, generated
output, and the governance tree left to their existing controls. That list
was the round-7 model, not an exhaustive route set: the round-8 review
planted two routes it did not cover — the bundler's `resolve.alias` table
and the template-literal/array glob spellings — and round 8 adds them (with
the value-path relay laundering, R8-2, described in the round-5 paragraph
above). **R7-3**
follows the preview identity into containers populated AFTER declaration
(`stash.body = preview; stash.body.html = …`), through identity-carrying
collection transforms (`map`/`filter`/`find`/`reduce` and friends, failing
closed on unresolved ones), through computed element access folded via
constant strings (unknown keys on a carrying container failing closed),
through setters, inherited constructors, generator yields, and
`Object.values`/`entries` iteration, while `$state.raw` containers and
provably non-preview destructures stay clean. **R7-4** models
property-descriptor setter extraction
(`Object.getOwnPropertyDescriptor(…)?.set?.call(…)`), multi-step method
binding (`const m = host.insertAdjacentHTML; const inj = m.bind(host);
  inj(…)`), computed `Object.assign` keys folded through constant strings with
unresolved computed keys failing closed, `Reflect.apply` and
`Reflect.construct` dispatch, and the Sanitizer-API spellings `setHTML` and
`setHTMLUnsafe` beside `setHTMLUnchecked`.

Round-8 (R8-1/R8-2/R8-3) closed the shapes the round-8 adversarial review
planted against that state, and this note again records only what the gate
proves. **R8-1** reads the bundler's `resolve.alias` table from the governed
root modules (`vite.config.ts`, `svelte.config.js`) with the same parser
reading everything else: the array spelling of `{ find, replacement }`
entries, the object spelling, shorthand and identifier-bound tables,
`.map`-generated entry runs, string and regex `find`, and replacements
folded through constant strings, templates, `path.resolve(root, …)`, and the
config's own root binding. Alias-resolved specifiers join the executable
source universe and the cross-file component-callee resolution exactly like
spelled routes, and an alias into the owned or vendored roots stays clean.
As round-8 shipped, that was all the universe closure did: it recorded only
HITS, and the round-9 review proved a route whose resolved base no candidate
matched dropped without a finding — so every spelling into an excluded root
(`build`, `docs`, a planted `node_modules` package) dropped silently,
because the walk never opens those roots and no candidate existed to match
(R9-1). Round 9 replaced the silence with classification, described below.
The fold is bounded and fails
closed: an alias entry it cannot read, a replacement it cannot place inside
the repository, and a bare specifier that matches no alias and no installed
package are findings rather than benign, while Node builtins and installed
packages stay benign. Round 9 (R9-2) widened the unreadable set to the
override shapes the model names — an entry carrying
any property the model does not consume (`customResolver` first: its return
IS the resolution, so the declared replacement is advisory), a config
declaring `resolve.alias` more than once, and a table naming one find twice
— and round 10 (R10-6) added a post-literal write or mutation of the table
(member assignment, element writes, mutating method calls, `Object.assign`,
and a mutated identifier- or shorthand-bound table), which the runtime
honors while a sequential reader meets only the declaration. **R8-2** is the value-path closure described in the
round-5 paragraph above. **R8-3** collects every `import.meta.glob` argument
shape the bundler accepts — a plain string, a no-substitution template
literal, and an array whose elements are strings or no-substitution template
literals — and fails closed on any other argument or array element, since a
glob the scan cannot enumerate could load any module.

Round-9 (R9-1/R9-2/R9-3) closed the shapes the round-9 adversarial review
planted against that state, and this note again records only what the gate
proves. **R9-1** classifies every resolved route base the universe closure
cannot match to a candidate, in the route spellings the closure models —
alias-resolved, relative, root-relative, glob (aliased or plain, with or
without options), dynamic import, and (since round 10) `new URL('<literal>',
import.meta.url)` targets, each base normalized the way the runtime
normalizes before it is judged. The benign set the classification proves is
exactly: a classified owned/vendored root, a governed root module, a
non-executable path, or a route into a `node_modules` package `package.json`
declares and installs — and that last verdict is POLICY, not a byte proof:
the declared dependency graph is what SEC-3 screens and `pnpm install
--frozen-lockfile` reconstructs; this scan does not verify the bytes inside
an installed package, and a locally tampered `node_modules` sits outside its
reach the same way any local file write does (the probe suite's own plants
live at that trust level). A route into any other excluded root (the roots
the walk never opens — `build`, `docs`, `gov-infra`, the steward trees, and
their kin), a route escaping the repository, a route into a package no
declaration answers for, and a base nothing answers for are findings: a
resolved base no candidate matches receives one of these verdicts, never a
drop. **R9-2** fails closed on the override shapes the model names in the
alias table: an entry carrying any property the model does not consume
(`customResolver` first — its return IS the resolution), a config declaring
`resolve.alias` more than once (the runtime keeps the LAST table; a
sequential reader meets the FIRST), a table naming one find twice (the
winner is runtime semantics the scan cannot faithfully model), and — since
round 10 — a post-literal write or mutation of the table. **R9-3** is the
value-path closure recorded in the round-5 paragraph above. What this gate
is, stays stated: a static analysis over the owned module graph that proves
the shapes it models and fails closed on the shapes it cannot resolve — it
is not a dynamic guarantee, and a future shape that defeats it is a probe to
add, not a prose correction.

Round-10 (R10-1…R10-7) closed the shapes the round-10 standing attack
planted against that state, and this note again records only what the gate
proves. **R10-1** normalizes EVERY resolved route base — `.`/`..` folded the
way the runtime folds them — before candidate matching and miss
classification, in each spelling the closure models: `$lib`, root-relative,
alias-resolved bare (including paths the `/^src\//` regex alias returns,
which the bundler folds and the round-9 gate kept raw), glob static
prefixes, dynamic imports, and `new URL` literals. The round-9 reading
folded only the relative spellings, and an un-normalized base still wearing
an owned prefix classified clean while excluded-root files shipped — proven
end-to-end at the round-9 head for the `$lib`, docs/, and regex-alias
plants. Root-absolute `/src/…` imports are refused by the bundler; the gate
classifies them anyway, as unplaced bases nothing answers for. **R10-2**
consults the alias table for every specifier spelling — the runtime's
first-match-wins matching runs on the raw specifier, not only bare ones —
and an alias match redirecting a module the audit scans (an owned or
vendored path) somewhere else is a finding in both the universe closure and
the component-callee resolution: the round-10 plant aliased
`$lib/review/PreviewBody.svelte` itself to a root shim that audited green
and shipped its marker into the client bundle at the round-9 head. An alias
resolving to the SAME module stays clean, and the repository's own `$lib`,
`$app/*`, regex, and stub entries are the paired positive. **R10-3** binds
binding-element defaults (`{ x = preview } = {}`) at call and destructure
positions; resolves object-literal, class, and instance METHODS at member
call sites — `.call`/`.apply` dispatch included — so a method-parameter
default binds, a `return p` marks the method preview-returning, a method
proven never to write its parameters keeps a value-carrying member call
clean, and a computed member call over an object carrying value-default
methods fails closed; records `Promise.allSettled` fulfillments
ADDITIONALLY behind each wrapper's `.value` read — elements stay carried,
over-approximated, as round 9 bound them — whether the result arrives by
`await`, `.then` parameter, destructure, element read, or for-of; and a
generator's `.next()` result is a wrapper whose `.value` read carries, its
iterator object iterable like the call. **R10-4** reads a local helper's
literal container returns — `function box(v) { return [v]; }` — so a
destructure of the call result, and element/property reads of it, bind the
identity; a helper whose returns carry no preview value stays clean.
**R10-5** judges a tagged template handing the value to its tag exactly as
a call — interpolations bind at the tag's parameters after the
template-strings position, a tag proven never to write its parameters stays
clean the way a read-only helper does — and covers the manual generator
spelling above. **R10-6** fails closed on a post-literal write or mutation
of `resolve.alias` — member assignment, element writes, `.push`/`.splice`/
`.unshift` and the other mutating methods, `Object.assign`, and a mutated
identifier- or shorthand-bound table — because the runtime resolves with the
mutation while a sequential reader meets only the declaration. **R10-7**
collects `new URL('<literal>', import.meta.url)` targets as routes — Vite
bundles the worker/asset spelling — with directory anchors, owned targets,
and non-executable paths staying clean, and states the `node_modules` benign
rule as policy rather than proof (R9-1 paragraph above).

Round-11 (R11-1…R11-3) closed the shapes the round-11 standing attack
planted against that state, and this note again records only what the gate
proves. **R11-1** treats the alias table as UNREADABLE the moment it
escapes its literal's textual reach. The round-10 mutation reading matched
the table's name textually; the round-11 attack executed four spellings it
did not reach — `Reflect.set(cfg.resolve, 'alias', …)`,
`Object.defineProperty(cfg.resolve, 'alias', …)`, a `push` through the
identifier a destructure binds (`const { alias } = cfg.resolve`), and an
element write inside a helper handed the table (`w(cfg.resolve.alias)`) —
each shipping a hijacked `svelte` resolution at runtime over a green audit.
Now: every identifier the table, its `resolve` parent, or the config object
is assigned or destructured into is DERIVED, chased to a fixed point with
casts and parentheses unwrapped; the builtin mutation APIs (`Object.assign`,
`Object.defineProperty`, `Object.defineProperties`, `Reflect.set`,
`Reflect.defineProperty`) judge by their target, which is the table, its
`resolve` object, any derived name, or the config object; and the table, its
`resolve` object, a derived name, or the config object flowing into ANY call
argument, member-call receiver, or spread is an escape. A write, a mutation,
or an escape makes the table unreadable, and the universe closure, the
component-callee resolution, and the barrel tracer all fail closed on the
unreadable table. **R11-2** chases the heritage clause for member calls: an
instance whose own class lacks the callee member resolves to the base that
declares it — bounded, cycle-guarded, multi-hop and class-expression
heritage included, exactly as the prototype walk runs — and fails closed
when the member cannot be proven after the chase: a base the file never
declares, a heritage expression no identifier names (a mixin call), the
depth bound, or a provably-absent member (`implements` clauses are
type-level and declare nothing at runtime). Method defaults bind, a
`return p` marks preview-returning, the mutation reading judges, and
`.call`/`.apply` dispatch resolves through the same chase; class GETTERS
receive the same reading at property-read positions, direct and inherited
alike; and the computed-member fail-closed reading walks the whole chain
for value-default methods. **R11-3** makes the barrel tracer consult the
alias table BEFORE owned resolution — exactly as an import does, and exactly
as the runtime does: the bundler matches every raw specifier against the
table first — so a hijacked barrel re-export is caught there rather than
left to the universe closure alone, and corrects two comments to the
mechanism the code actually runs: a non-literal `new URL(…, import.meta.url)`
first argument is DROPPED (Vite's asset/worker handling is a static rewrite
that fires only on literal targets, so a computed target bundles nothing),
while a computed dynamic import fails closed (the runtime loader reaches
it).

Round-12 (R12-1…R12-5) closed the shapes the round-12 standing attack
planted against that state. **R12-1** treats the alias table as ESCAPED
unless every binding derived from it is provably through the modeled
channels. The round-11 derivation fixed point modeled only identifier and
destructure targets whose source is DIRECTLY a chain ending in
`resolve`/`alias`, a derived name, or the config object, and the round-12
attack aliased the table through twelve wrappers it did not reach — a
function return, an IIFE return, a comma expression, a conditional, an
array wrap, a member-target assignment, an element-target assignment, a
parameter default, a class property, a computed-key read, an object-literal
getter, and a generator yield — each mutating the shipped table over a green
audit. Now: derivation keeps only direct identifier and pattern bindings
and parameter or binding-element defaults, chased to a fixed point; any
other position a state read appears in — a return, a yield, a concise-arrow
body, a wrapped initializer, a member or element assignment target, a
property or class-property slot, a computed pattern key, or the iterable of
a `for-of`/`for-in` iteration (`for await` included) — fails closed as an
escape of the table. Beside the binding positions, a Vite plugin's
`config()` hook can rewrite the table after the declaration — Vite hands
the hook the config object and merges its return — so a readable hook that
returns or mutates `resolve.alias` (or a hook shape the scan cannot read)
escapes the table, while readable hooks that provably contribute no alias
state and opaque plugin values stay clean. One stated exception stays clean: the config object
itself, returned or yielded as the identifier the declaration bound it to
(the cross-file residual of a returned config object remains the stated
one). **R12-4** narrows the destructure reading to the keys the config
literal records as holding alias state — `const { resolve } = cfg` binds
the resolve object, while a sibling key (`const { plugins } = cfg`) binds a
property the table never touches and derives nothing; a bare member read of
a derived name still fails closed, the conservative direction. **R12-2**
extends the heritage chase to the spellings the round-11 reading keyed out:
STATIC members chase on the class name down the same extends clause, SUPER
dispatch resolves on the enclosing class's base, and any in-file install on
a class's prototype (`Object.defineProperty`/`defineProperties`,
`Reflect.defineProperty`/`set`, `Object.assign`, or a direct
`A.prototype.m = …` write) — or on the class object itself for statics —
makes the chain UNPROVEN, because a member installed at runtime is one the
declaration walk never saw. The install taint keys on the value's reach,
not the spelling: the builtin and the target each resolve through EVERY
binding the name receives — declarations and assignments alike, a shadow
over a benign first binding included — so an aliased builtin (`const dp =
Object.defineProperty`, `let d; d = Object.defineProperty`, a namespace
`const R = Reflect`, an element-access callee `Object['defineProperty']`,
an indirect comma `(0, Object.defineProperty)`), a prototype value held by
an intermediate binding or a folded computed key (`C[k]` over
`const k = 'prototype'`), or a destructure — off a namespace alias, with a
computed binding key included — taints the chain exactly as the literal
spelling does, and `Object.assign` taints the static side exactly as the
prototype side (the round-13 W1–W5 plants, the round-14 ae plants). The
round-12 plant installed a getter; its method analogue was already caught
only because the call scan fails closed when the value is handed to an
unproven member, and a getter read hands nothing. **R12-3**
unwraps casts and parentheses off member-call receivers everywhere the
dispatch readings key on them — the carrier, the getter read, the call-site
parameter binding, and the hand-off resolution — closing `(b as T).m()`
with an unproven member. **R12-5** pins the round-11 alias-first barrel
tracer with a probe isolating the tracer path: the universe closure names a
module that LOADS a specifier, the tracer names the barrel that RE-EXPORTS
it, and the probe asserts the tracer's own finding, which a regression
dropping the alias-first consultation would silence while the universe line
survives.

Round-13 (R12-A…R12-D) closed four shapes the round-12 closure still keyed
on textual spellings rather than the value's reach. **R12-A**: the
prototype-install taint matched only literal `Object.defineProperty`-family
callees with textual `X.prototype` targets — five aliased spellings
installed the preview getter over green audits (an aliased builtin callee,
a namespace alias, an intermediate prototype binding, an element-access
`prototype` key, a destructure); the callee and the target now each resolve
through the declaration map, destructured extractions included, and the
direct spellings and the method analogue stay caught. **R12-B**: a
`for-of`/`for-in` over the alias table — direct, through a derived table
name, `for await` included — bound the loop variable to entries the
derivation never modeled and rewrote them over green audits; the iterable
position fails closed like every other unmodeled position. **R12-C**: the
audit had no concept of the plugins array, and a Vite plugin's `config()`
hook — which Vite hands the config object and whose return it merges —
could rewrite `resolve.alias` in-file; the hook's first parameter is now
seeded at the config level so the existing mutation/escape/binding-position
readings judge what flows through it, a return value that could contribute
a `resolve.alias` is an escape, an unreadable hook shape fails closed, and
readable hooks that provably contribute no alias state (with opaque plugin
values like `svelte(...)`) stay clean. **R12-D**: a spread of a
value-carrying array into call arguments laundered the preview past the
call gate — the call-side mirror of the round-9 rest-parameter closure; the
spread holds the value exactly as a direct argument does, at any position,
and a spread of a fresh literal holding nothing stays clean.

Round-14 (R13-A1, R13-C1, R13-C2) closed the enumerated-spelling holes the
round-13 reach readings still left in two families. **R13-A1**: the install
taint's declaration map recorded only declarations-with-initializers,
first-binding-wins and scope-blind, and the callee/target readers chased
nothing else, so eight spellings installed the preview getter over green
audits — an assignment-aliased callee, an assignment-bound target, a folded
computed `prototype` key, an element-access callee, an indirect comma
callee, a destructure off a namespace alias, a shadow declared after a
benign first binding, and an `Object.assign` onto the class object for
statics. The map records the declarations and the plain `=` assignments a
name receives (shadows included), the callee reads the element-access and
comma spellings, the target folds computed keys, a destructure reads its
source through the same binding map and folds computed binding keys, and
`Object.assign` taints the static side exactly as the prototype side. This
round's wording claimed that as "every binding a name receives" and the
statics sentence as "true as executed"; both were one spelling wide — the map
recorded only `=` to a bare identifier, and the direct-write taint covered
only the prototype side — and it is round 15 (R14-1, R14-2 below) that makes
them true as executed. **R13-C1**: the
plugins-array reading modeled only the enumerated spellings, so the isolated
call hand-off hook sailed through a shorthand `plugins` key, a `get
config()` accessor, a spread into the plugin object, a hook assigned onto
the bound plugin object, a `new` of a locally declared class, and a list
populated after its literal. The scan now chases each of those readable
shapes — the shorthand key through its declaration, the accessor by what it
returns, the spread through its readable source, the hook installed onto the
bound object, the `config` member the class declaration names — and fails
closed on a list it cannot enumerate; opaque plugin values (a call result
like `svelte(...)`, an import) keep the disclosed residual. **R13-C2**: the
binding-position readings early-returned inside the alias declaration's
statement, and the plugins array — every inline hook body — sits inside that
statement, so an inline hook handing its parameter to unreadable code
through an assignment sailed through while the identical bound body was
caught. The exemption is removed: an inline hook body is judged by the same
mutation/escape/binding-position readings as a bound hook body, which is
what the R12-C seeding sentence above claims as executed.

Round-15 (R14-1, R14-2, R14-3, R14-4) closed four families of SIBLING
spellings the round-14 closures left open — readings keyed on one spelling of
a mutable value with the adjacent spellings unjudged — and corrects the
round-14 claims those gaps falsified. **R14-1**: the install binding map
recorded only a plain `=` to a bare identifier, so five spellings installed
the preview getter over green audits — a `??=`/`||=` compound-assignment
callee, an object destructuring assignment (`({ defineProperty: d } =
Object)`), an array destructuring assignment (`[d] =
[Object.defineProperty]`), and an element store (`o['d'] =
Object.defineProperty; o['d'](…)`). The map now mirrors the alias-level
derivation fixed point: it records the full assignment-operator range on
identifier targets, the identifier positions an array-shape destructuring
assignment binds, and the values stored at member and element positions —
direct stores and stores through `Object.assign`/`defineProperties`/
`defineProperty`/`Reflect.set` alike — and the callee and target readers read
back through those stores. This is what makes the R12-2 value-reach statement
(the builtin and the target each resolve through every binding the name
receives) true as executed. **R14-2**: the direct-write taint covered only the
prototype side, so `class C {}; C.g = () => preview;` — a static getter
installed by plain assignment — sailed past while the identical
`Object.assign(C, …)` spelling was caught. A direct write now taints whichever
side it names, prototype or static, exactly as the install-builtin call does;
this is what makes the "class object itself for statics" sentence fully true
as executed. **R14-3**: `configResolved` was unjudged and undisclosed. Vite
hands `configResolved` the resolved config and ignores its return, but the
hook can MUTATE the config, and the bundled-environment path re-reads
`config.resolve.alias` at environment creation AFTER `configResolved` runs —
and contentus ships via `vite build`, the bundled path — so a `configResolved`
mutation reaches the shipped table. `configResolved` is now judged by the same
machinery as `config()`: its first parameter is seeded at the config level so
the mutation/escape/binding-position readings judge what flows through it, for
an inline and a bound-plugin spelling alike, while its return — nothing Vite
consumes — is not judged as a contribution. Of the Vite plugin hooks, only
`config` and `configResolved` can rewrite the shipped alias table, and only
those two are judged; every other hook is left unjudged and is disclosed here
with the reason. The Rollup-level hooks (`options`, `outputOptions`,
`buildStart`, `buildEnd`, `resolveId`, `load`, `transform`, `moduleParsed`,
`renderChunk`, `generateBundle`, `writeBundle`, `closeBundle`) receive Rollup
options or per-module/per-chunk data, never the Vite config object, so none
can mutate `resolve.alias`; and the dev-server and HMR hooks
(`configureServer`, `configurePreviewServer`, `handleHotUpdate`) do not run in
the bundled build this audit models. **R14-4**: the bound-plugin hook chase
recorded only the dot-assignment LHS, so `Object.assign(p, { config(…){…} })`,
`Object.defineProperty(p, 'config', { value(…){…} })`, and `p['config'] =
hook` sailed through. A hook installed onto a bound plugin object after its
literal is now chased through every install spelling — a dot or computed
assignment, `Object.assign`/`defineProperties` over a source object literal or
an identifier the declarations map reads to one, an
`Object.defineProperty`/`Reflect.defineProperty` descriptor, and
`Reflect.set` — for both hook names, and a hook installed through an
unreadable source fails closed rather than being silently accepted. The
round-15 self-attack sweep closed two further siblings the families imply: an
install builtin laundered through `Object.assign` onto a plain object and read
back (`Object.assign(o, { d: Object.defineProperty }); o['d'](C.prototype,
…)`), and a readable plugin base merged into a bound plugin (`Object.assign(p,
base)` over `const base = { config(…){…} }`).

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
