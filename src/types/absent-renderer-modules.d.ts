/**
 * Declarations for Markdown-rendering modules that contentus deliberately does
 * NOT install.
 *
 * Why these exist:
 *
 * The vendored greater blog face's `Article.Content` imports `sanitizeHtml`
 * from the `src/lib/greater/utils` barrel. That barrel also re-exports
 * `html-to-markdown.ts`, which imports `hast-util-to-mdast`,
 * `mdast-util-to-markdown`, and `mdast-util-gfm`. So the whole barrel enters
 * the TYPE graph even though Vite tree-shakes `html-to-markdown` out of the
 * bundle — nothing contentus ships ever calls it.
 *
 * That leaves two ways to make the typechecker resolve the barrel:
 *
 *   1. Install the Markdown-rendering packages. Refused. lesser's server-side
 *      renderer is the single authority for article HTML, and pulling a
 *      Markdown renderer into contentus's dependency tree to satisfy a
 *      typechecker is precisely the erosion `scripts/audit-renderer-authority.mjs`
 *      exists to prevent.
 *   2. Declare them absent. Done here.
 *
 * These declarations add nothing at runtime and grant nothing: they state that
 * the modules are not present in this project. Any contentus-owned code that
 * tried to USE them would still be caught by the renderer-authority audit,
 * which scans owned source for these imports independently of typing.
 *
 * The underlying problem is upstream: the greater blog face's registry manifest
 * requires the `content` shared module, which carries a full client-side
 * Markdown renderer the face's own `Article.Content` refuses to use. Reported
 * via Factory to the greater-components steward; see
 * `docs/consumption/renderer-authority.md`. Delete this file when the face no
 * longer drags a renderer along.
 */

declare module 'hast-util-to-mdast';
declare module 'mdast-util-to-markdown';
declare module 'mdast-util-gfm';
