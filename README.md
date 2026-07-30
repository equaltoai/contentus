# Contentus

Contentus is the EqualtoAI **lesser CMS client**: a FaceTheory app installed
into lesser instances through lesser's client-install mechanism, delivering the
full CMS surface — public article reading plus the authenticated
authoring → draft → preview → review → publish workflow — over lesser's
GraphQL CMS contract.

It exists inside the lesser ecosystem. It is not a design system, not a
standalone web app, and not a redefinition of lesser. (Its predecessor attempt,
`emdash`, was abandoned for exactly that failure: an arbitrary application
with no deployment path in lesser.)

## Canonical contracts

Contentus consumes, and does not own, the lesser CMS contracts:

- `../lesser/docs/architecture/cms/fediverse-first-blog-cms-contract.md`
- `../lesser/docs/development/CMS_DEVELOPER_GUIDE.md`

A missing capability is an upstream issue against `equaltoai/lesser` or
`equaltoai/greater-components` — never a local workaround.

## Non-negotiables

- **The server renders; the client presents.** lesser's renderer/sanitizer is
  the single authority for article HTML — public pages, `draftPreview`,
  federated content. The client never re-renders Markdown/HTML and never
  displays raw draft source.
- **GraphQL-first** for app functionality (wallet/auth REST exception per
  lesser policy).
- **Lesser auth**: `auth-ui` + OAuth Authorization Code + PKCE. No local auth.
- **Strict CSP**: no inline `<script>` or `<style>`.
- **The review gate is a feature.** Agent-generated drafts require explicit
  reviewer/publisher action through lesser's authenticated CMS workflow.
- **The deployment path is milestone zero.** `facetheory.lesser.json` and
  `lesser client install` to a dev instance are working artifacts from the
  first milestone and stay green at every boundary.

## Stewardship

This repo is stewarded by **contentus**, a served EqualToAI agent published in
the `equaltoai` namespace (`https://theorymcp.ai/equaltoai/agents/contentus/mcp`).
See `AGENTS.md` for the repo-side governance contract. The materialized steward
trees (`.codex/`, `.agents/`, `.claude/`, `.kimi-code/`, `GEMINI.md`,
`.mcp.json`) are generated from the published namespace agent — do not
hand-edit them; change the agent in the namespace and re-materialize.

## Status

Genesis state: steward materials and the milestone-zero deployment artifacts
(install manifest + runbook) are in place. The FaceTheory app source lands in
the milestone sequence under the steward's discipline.

## License

AGPL-3.0-or-later, (c) Equal To AI.
