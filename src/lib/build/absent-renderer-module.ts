/**
 * Build-time stand-in for the Markdown-conversion modules contentus does not
 * ship.
 *
 * The vendored greater blog face's `Article.Content` imports `sanitizeHtml`
 * from the `src/lib/greater/utils` barrel, and that barrel also re-exports
 * `html-to-markdown.ts`, which imports `hast-util-to-mdast`,
 * `mdast-util-to-markdown`, and `mdast-util-gfm`. Nothing contentus ships ever
 * calls it — but the bundler resolves every import in the graph before
 * tree-shaking removes the dead branch, so the build fails on modules that are
 * deliberately absent.
 *
 * The two ways out were: install a Markdown renderer to satisfy the bundler, or
 * state plainly that these modules are not part of this application. lesser's
 * server-side renderer is the single authority for article HTML, so the first
 * is not available to us.
 *
 * These exports throw rather than returning empty values. If the dead branch
 * ever stops being dead, that must be a loud failure at the call site, not a
 * silent no-op that looks like a working conversion — a stub returning `''`
 * would let a "preview" quietly render blank instead of announcing that
 * contentus has no renderer.
 *
 * Aliased in `vite.config.ts`; typed as absent in
 * `src/types/absent-renderer-modules.d.ts`. Both go away when the greater blog
 * face stops requiring the `content` module — see
 * `docs/consumption/renderer-authority.md`.
 */

function absent(name: string): never {
	throw new Error(
		`${name} is not available in contentus: article HTML is rendered by lesser's ` +
			'server-side renderer/sanitizer, and no client-side Markdown conversion ships ' +
			'here. See docs/consumption/renderer-authority.md.'
	);
}

export function toMdast(): never {
	return absent('hast-util-to-mdast');
}

export function toMarkdown(): never {
	return absent('mdast-util-to-markdown');
}

export function gfmToMarkdown(): never {
	return absent('mdast-util-gfm');
}

export default absent;
