import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildStrictCspHeader } from '@theory-cloud/facetheory';

import { cspDirectivesForPage, REVIEW_WORKSPACE_PAGE_KEY } from '../src/facetheory/csp.ts';

import { loadHandler, renderRoute } from '../scripts/render-routes.mjs';

/**
 * F1 (round-1 attack): the minted presigned media URL is CSP-blocked on the
 * deployed surface — the figure node renders, the image cannot load.
 *
 * THE FIX UNDER TEST. The authenticated review-workspace route extends
 * FaceTheory's canonical strict CSP through its own `directives` API with an
 * `img-src` source covering lesser's off-origin HTTPS editorial media URL;
 * every other route keeps the canonical policy untouched. The extension goes
 * through the REAL framework builder (`buildStrictCspHeader` from the pinned
 * `@theory-cloud/facetheory`), never a hand-built parallel policy.
 *
 * THE URL. Lesser mints a five-minute AWS SigV4 presigned S3 GET URL
 * (`IssueEditorialAccess`, lesser `pkg/services/media/service.go`) and composes
 * it into the rendered `<figure><img src=…>`. The host is the S3 regional
 * endpoint by construction — instance bucket, instance region — so no fixed
 * origin is predictable; the `https:` scheme-source is the narrowest source
 * the runtime permits, and it is the scheme lesser-host's own client-delivery
 * CSP fallback (`img-src 'self' data: https:`, `Override:false`) already uses.
 *
 * WHAT RUNS HERE. The unit half composes the REAL FaceTheory header from the
 * route's directive extension and matches the S3-shaped URL against the
 * `img-src` directive with browser-equivalent CSP source semantics. The route
 * half drives the BUILT handler (`build/server/handler.mjs`) exactly as
 * lesser's SSR host does and reads the actual `content-security-policy`
 * response header per route — the "actual route CSP header path" the attack
 * report demanded. SSR confidentiality is pinned in `tests/ssr-review.test.mjs`
 * and re-asserted here for the media URL.
 *
 * THE FIVE-MINUTE URL, CORRECTLY ACCOUNTED FOR. The browser requests the image
 * eagerly on a fresh preview load; a reload obtains a fresh preview from the
 * same authenticated document, and with it a fresh URL. Nothing in contentus
 * persists, caches, or re-serves the minted URL, and nothing moves access
 * minting earlier than lesser's own read — the render path is the verbatim
 * `{@html preview.html}` display pinned by the renderer-authority audit.
 */

/** A presigned-form placeholder, never a real bearer artifact. */
const S3_MEDIA_URL =
	'https://media-instance.s3.us-east-1.amazonaws.com/editorial/access/PLACEHOLDER' +
	'?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=PLACEHOLDER';

/** Browser-equivalent CSP source matching for the `img-src` directive only. */
function imgSrcAllows(imgSrcTokens, url) {
	const { protocol, hostname } = new URL(url);
	for (const token of imgSrcTokens) {
		if (token === '*') return true;
		if (token.endsWith(':')) {
			// scheme-source: `https:` matches any https URL.
			if (protocol === token) return true;
			continue;
		}
		if (token.startsWith("'")) continue; // 'self' / 'none' handled below
		const hostSource = token.includes('://') ? new URL(token).hostname : token;
		if (hostSource.startsWith('*.')) {
			if (hostname.endsWith(hostSource.slice(1))) return true;
		} else if (hostname === hostSource) return true;
	}
	return false;
}

function imgSrcDirective(header) {
	const directive = header
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith('img-src '));
	assert.ok(directive, 'the policy must carry an img-src directive');
	return directive.slice('img-src '.length).split(/\s+/);
}

function directiveTokens(header, name) {
	const directive = header
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name} `));
	return directive ? directive.slice(`${name} `.length).split(/\s+/) : [];
}

/* ---------------------------------------------------------------------------
 * The unit half: the real FaceTheory builder, fed the route's extension
 * ------------------------------------------------------------------------ */

test('the review-workspace directive exists and names only the img-src source', () => {
	const extension = cspDirectivesForPage(REVIEW_WORKSPACE_PAGE_KEY);
	assert.ok(extension, 'the review workspace must carry a CSP extension');
	assert.deepEqual(extension.directives['img-src'], ['https:']);
});

test('other routes carry no directive extension at all', () => {
	for (const key of [
		'article-reader',
		'articles-index',
		'review-queue',
		'compose',
		'timelines',
		'messages',
		'message-thread',
		'agents',
		'profile',
	]) {
		assert.equal(
			cspDirectivesForPage(key),
			null,
			`${key} must not inherit the review-workspace img-src widening`
		);
	}
});

test('the real FaceTheory header admits the S3 URL on the review workspace only', () => {
	// The review-workspace policy: canonical strict policy + the img-src source.
	const workspaceHeader = buildStrictCspHeader({
		directives: cspDirectivesForPage(REVIEW_WORKSPACE_PAGE_KEY).directives,
	});
	assert.ok(
		imgSrcAllows(imgSrcDirective(workspaceHeader), S3_MEDIA_URL),
		`the review workspace must allow ${S3_MEDIA_URL}`
	);

	// The canonical policy, unchanged: the same URL must be BLOCKED, which is
	// the regression the fix closes and the shape every other route still ships.
	const baseHeader = buildStrictCspHeader();
	assert.ok(
		!imgSrcAllows(imgSrcDirective(baseHeader), S3_MEDIA_URL),
		'without the extension the S3 URL is blocked — this test would catch the regression'
	);
});

test('scripts and styles stay strict on the widened route', () => {
	const header = buildStrictCspHeader({
		directives: cspDirectivesForPage(REVIEW_WORKSPACE_PAGE_KEY).directives,
	});
	assert.deepEqual(directiveTokens(header, 'script-src'), ["'self'"]);
	assert.deepEqual(directiveTokens(header, 'style-src'), ["'self'"]);
	assert.deepEqual(directiveTokens(header, 'connect-src'), ["'self'"]);
	assert.ok(!header.includes('unsafe-inline') && !header.includes('unsafe-eval'));
});

/* ---------------------------------------------------------------------------
 * The route half: the built handler's actual response headers
 * ------------------------------------------------------------------------ */

const handler = await loadHandler();

const render = (path, expectStatus = 200) =>
	renderRoute(handler, { name: path, path, expectStatus });

test('the review-workspace route serves the widened img-src in its real header', async () => {
	const { headers, status } = await render('/l/review/drafts/draft-123');
	assert.equal(status, 200);
	assert.equal(
		headers['content-security-policy'],
		buildStrictCspHeader({
			directives: cspDirectivesForPage(REVIEW_WORKSPACE_PAGE_KEY).directives,
		})
	);
	assert.ok(
		imgSrcAllows(imgSrcDirective(headers['content-security-policy']), S3_MEDIA_URL),
		'the served review-workspace policy must admit the minted HTTPS media URL'
	);
});

test('unrelated routes do not inherit the img-src widening', async () => {
	for (const path of ['/l/review', '/l/articles/example-article', '/l/compose', '/l/timelines']) {
		const { headers, status } = await render(path);
		assert.equal(status, 200, `${path} status`);
		const policy = headers['content-security-policy'];
		assert.ok(policy, `${path} must serve a CSP`);
		assert.ok(
			!imgSrcAllows(imgSrcDirective(policy), S3_MEDIA_URL),
			`${path} must keep the canonical img-src, blocking the off-origin media URL`
		);
		assert.deepEqual(
			directiveTokens(policy, 'script-src'),
			["'self'"],
			`${path} must keep script-src strict`
		);
	}
});

test('the anonymous review-workspace document still contains no body or media URL', async () => {
	// The media URL is minted only behind the authenticated preview read, which
	// the server never performs (no token on the document request). The SSR
	// document must carry neither the body nor any trace of the minted URL.
	const { html, status } = await render('/l/review/drafts/draft-123');
	assert.equal(status, 200);
	assert.ok(!html.includes('PLACEHOLDER?X-Amz-Signature'), 'no media URL may reach the document');
	assert.ok(!html.includes('<figure>'), 'no rendered body may reach the anonymous document');
});
