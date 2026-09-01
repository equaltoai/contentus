import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

import { withSourceLock } from './helpers/source-lock.mjs';

import { DRAFT_PREVIEW_QUERY, toDraftPreview } from '../src/lib/cms/review-contract.ts';

/**
 * #112's principal outcome, exercised through the code that runs.
 *
 * THE CLAIM. A figure-bearing `renderedHtml` — what lesser's
 * `RenderDraftPreviewWithMedia` composes when the authenticated preview opts
 * into `includeAccessUrls: true` — reaches the authenticated post-hydration
 * review DOM with its `<figure>` and `<img>` intact, and an old approval that
 * lesser has voided for the current revision is presented as history, never
 * as current approval.
 *
 * WHAT RUNS HERE. The real display component (`src/lib/review/PreviewBody
 * .svelte`) and the real released queue chrome (`src/lib/components/Review/
 * QueueCard.svelte`, emitted by the digest-verified greater CLI at
 * greater-v0.13.7), compiled with the repository's own Svelte compiler and
 * rendered through `svelte/server`. For declarative markup the server render
 * is the same paint hydration produces — the difference between the two is
 * event wiring and `onMount`, and the review data arrives exclusively in an
 * authenticated `onMount` fetch (`tests/ssr-review.test.mjs` pins that the
 * server document and the public hydration payload stay body-free;
 * `tests/review-adapters.test.mjs` pins the wire document and the transport).
 * So a green run here is the browser-equivalent statement: this exact HTML is
 * what lands in the reviewer's DOM.
 *
 * WHAT IS STILL NOT RUN. No real browser: the probes assert the markup the
 * components emit, not layout, CSP enforcement, or the presigned URL fetch —
 * those belong to the operator's live exercise, recorded in the milestone PR.
 */

/**
 * The vendored review chrome imports through the shapes Node cannot resolve:
 * `./state.js` (a `.js` specifier naming a `.ts` file) and, one step down,
 * `../../greater/utils` (a barrel directory the CLI substituted as an alias
 * target). The hook resolves both to the real repository modules — the same
 * disclosed pattern `tests/review-adapters.test.mjs` and
 * `tests/vendored-messaging-render.test.mjs` use — and stubs nothing.
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		// The compiled components execute from a temp directory, where bare
		// specifiers (`svelte`, its internals) cannot resolve. Reparent those
		// reads to this probe file so the repository's `node_modules` answers
		// them; relative specifiers were already rewritten to absolute URLs.
		if (context.parentURL?.includes('/contentus-review-render-'))
			return nextResolve(specifier, {
				...context,
				parentURL: pathToFileURL(resolve('tests/review-preview-render.test.mjs')).href,
			});

		if (
			context.parentURL?.startsWith(pathToFileURL(resolve('src')).href) &&
			specifier.startsWith('.')
		) {
			const resolved = new URL(specifier, context.parentURL);

			// The barrel directory: `state.ts` imports only `formatDateTime`
			// from it, and `relativeTime.ts` owns that symbol. A directory is
			// not a module Node can load; the owner file is the real target.
			if (resolved.pathname === `${resolve('src/lib/greater/utils')}`)
				return {
					url: pathToFileURL(resolve('src/lib/greater/utils/relativeTime.ts')).href,
					shortCircuit: true,
				};

			const candidates = resolved.pathname.endsWith('.js')
				? [resolved.pathname.slice(0, -3) + '.ts']
				: [`${resolved.pathname}.ts`];
			const candidate = candidates.find(existsSync);
			if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

/** Compile one real component file for server rendering, imports rewritten to
 *  the repository's actual modules, and return its default export. The read is
 *  locked because the renderer-authority probes mutate PreviewBody.svelte
 *  while they audit it, and a fixture must never compile for the shipped file. */
async function compileForServer(componentPath) {
	const source = withSourceLock(() => readFileSync(componentPath, 'utf8'));
	const { js } = compile(source, {
		generate: 'server',
		filename: componentPath,
		dev: false,
	});

	// Point every relative import at the real file it names (`.js` -> `.ts`),
	// as an absolute URL — the compiled module is evaluated from a temp
	// directory, so relative specifiers would otherwise resolve into the void.
	const base = pathToFileURL(componentPath);
	const code = js.code.replace(/from\s+["'](\.[^"']+)["']/g, (_match, spec) => {
		const target = new URL(spec, base);
		const ts = target.pathname.endsWith('.js')
			? `${target.pathname.slice(0, -3)}.ts`
			: `${target.pathname}.ts`;
		return `from "${pathToFileURL(ts).href}"`;
	});

	const dir = mkdtempSync(join(tmpdir(), 'contentus-review-render-'));
	const file = join(dir, 'compiled.mjs');
	writeFileSync(file, code, 'utf8');
	try {
		const module = await import(pathToFileURL(file).href);
		return module.default;
	} finally {
		// Removal is deferred to process exit rather than executed here: the
		// imported module's identity is what the tests render, and the file is
		// small, temp-scoped, and prefixed for the janitor of last resort.
		process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
	}
}

/* ---------------------------------------------------------------------------
 * The fixtures
 * ------------------------------------------------------------------------ */

/**
 * A canonical preview body as lesser's renderer composes one when
 * `includeAccessUrls: true`: `buildArticleFigure` (lesser `pkg/cmsrender/
 * compose.go`) emits the `<figure>`/`<img>` pair with the minted access URL
 * as the `src`. The URL is a SYNTACTIC placeholder shaped like the presigned
 * form lesser serves — never a real bearer artifact.
 */
const FIGURE_HTML =
	'<h1>What the agent wrote</h1>' +
	'<p>Some prose the agent produced.</p>' +
	'<figure>' +
	'<img src="https://media.instance.test/editorial/access/PLACEHOLDER?signature=PLACEHOLDER" ' +
	'alt="A chart of the results" width="600" height="400">' +
	'<figcaption>Figure one — Photo: Scribe</figcaption>' +
	'</figure>';

const reviewer = {
	id: 'actor-human-1',
	username: 'editor',
	domain: null,
	displayName: 'Editor',
	avatar: null,
	isAgent: false,
};

const agent = {
	id: 'actor-agent-1',
	username: 'scribe',
	domain: null,
	displayName: 'Scribe',
	avatar: null,
	isAgent: true,
};

/** A `DraftReview`-shaped fixture for the queue chrome, bent per case. */
const queueReview = (overrides = {}) => ({
	draftId: 'draft-112',
	title: 'What the agent wrote',
	subtitle: 'A dispatch from the agent',
	excerpt: 'Some prose.',
	contentFormat: 'MARKDOWN',
	status: 'DRAFT',
	updatedAt: '2026-08-31T12:00:00Z',
	createdAt: '2026-08-31T09:00:00Z',
	generatedBy: agent,
	reviewedBy: reviewer,
	reviewStatus: 'APPROVED',
	editorNotes: null,
	contentHash: 'sha256:current-revision',
	revision: 4,
	activeReviewerIds: [reviewer.id],
	publishEligibility: {
		eligible: false,
		blockingReasons: ['generated draft requires an active approval from the instance principal'],
		reviewersApproved: true,
		principalApprovalRequired: true,
		principalApproved: false,
	},
	grant: { grantedAt: '2026-08-31T10:00:00Z', reviewer },
	verdicts: [],
	...overrides,
});

/* ---------------------------------------------------------------------------
 * The preview body: lesser's figure-bearing HTML reaches the review DOM
 * ------------------------------------------------------------------------ */

test('the authenticated preview display renders lesser figures and images intact', async () => {
	// The projection is the real one: the same `toDraftPreview` the transport
	// feeds, over a fixture shaped exactly like lesser's answer to the opted-in
	// document. The wire document itself is asserted to carry the opt-in.
	assert.match(DRAFT_PREVIEW_QUERY, /draftPreview\(id: \$id, includeAccessUrls: true\)/);
	const preview = toDraftPreview({
		draftId: 'draft-112',
		success: true,
		renderedHtml: FIGURE_HTML,
		sourceFormat: 'markdown',
		sourceBytes: 120,
		renderedBytes: FIGURE_HTML.length,
		errors: [],
	});
	assert.equal(preview.html, FIGURE_HTML);

	const PreviewBody = await compileForServer(resolve('src/lib/review/PreviewBody.svelte'));
	const { body } = render(PreviewBody, { props: { preview } });

	// The figure reaches the DOM the reviewer's browser paints.
	assert.match(body, /<figure>/);
	assert.match(
		body,
		/<img src="https:\/\/media\.instance\.test\/editorial\/access\/PLACEHOLDER\?signature=PLACEHOLDER" alt="A chart of the results" width="600" height="400">/,
		'the bound image renders with the minted src, alt text, and dimensions lesser authored'
	);
	assert.match(body, /<figcaption>Figure one — Photo: Scribe<\/figcaption>/);

	// Rendered, not escaped: an escaped sink would print the markup as text.
	assert.doesNotMatch(body, /&lt;figure&gt;/);
	assert.doesNotMatch(body, /&lt;img/);

	// Accessible semantics travel with the markup: the alt text is the
	// accessible name, the figcaption the visible caption.
	assert.match(body, /alt="A chart of the results"/);
});

test('the preview display renders nothing for a render lesser did not succeed', async () => {
	const PreviewBody = await compileForServer(resolve('src/lib/review/PreviewBody.svelte'));

	// A failed preview: `toDraftPreview` already nulled the HTML.
	const failed = toDraftPreview({
		draftId: 'draft-112',
		success: false,
		renderedHtml: '<p>half of it</p>',
		sourceFormat: 'markdown',
		sourceBytes: 400_000,
		renderedBytes: 0,
		errors: ['draft source exceeds the 256 KiB limit'],
	});
	assert.equal(failed.html, null);

	const { body } = render(PreviewBody, { props: { preview: failed } });
	assert.doesNotMatch(body, /<figure>|<img|half of it/, 'a failed render displays no body at all');

	// And a successful render with an empty body displays nothing either.
	const empty = toDraftPreview({
		draftId: 'draft-112',
		success: true,
		renderedHtml: '',
		sourceFormat: 'markdown',
		sourceBytes: 0,
		renderedBytes: 0,
		errors: [],
	});
	const emptyRender = render(PreviewBody, { props: { preview: empty } });
	assert.doesNotMatch(emptyRender.body, /<figure>|<img/);
});

/* ---------------------------------------------------------------------------
 * The queue chrome: stale approval demoted, current approval intact
 * ------------------------------------------------------------------------ */

test('the released queue chrome presents a stale approval as history, never as current', async () => {
	const QueueCard = await compileForServer(resolve('src/lib/components/Review/QueueCard.svelte'));

	const { body } = render(QueueCard, {
		props: {
			review: queueReview({
				verdicts: [
					{
						verdict: 'APPROVED',
						notes: null,
						contentHash: 'sha256:older-revision',
						current: false,
						stale: true,
						recordedAt: '2026-08-31T10:30:00Z',
						reviewer,
					},
				],
			}),
			href: '/l/review/drafts/draft-112',
		},
	});

	// The superseded label and the explanation are VISIBLE TEXT — the meaning
	// never depends on badge colour.
	assert.match(body, /Latest verdict: Approved \(superseded\)/);
	assert.match(
		body,
		/This approval no longer counts\. Principal approval for the current revision is outstanding\./
	);

	// The stale tone class, and NOT the success tone class.
	assert.match(body, /gr-blog-review-card__state--stale-approved/);
	assert.doesNotMatch(body, /gr-blog-review-card__state--approved"/);

	// The badge stays qualified as activity, never publication state.
	assert.match(body, /latest activity, not publication state/);

	// No current-success wording anywhere in the card.
	assert.doesNotMatch(body, /Latest verdict: Approved</);
});

test('the released queue chrome keeps a genuinely current approval approved', async () => {
	const QueueCard = await compileForServer(resolve('src/lib/components/Review/QueueCard.svelte'));

	const { body } = render(QueueCard, {
		props: {
			review: queueReview({
				publishEligibility: {
					eligible: true,
					blockingReasons: [],
					reviewersApproved: true,
					principalApprovalRequired: true,
					principalApproved: true,
				},
				verdicts: [
					{
						verdict: 'APPROVED',
						notes: null,
						contentHash: 'sha256:current-revision',
						current: true,
						stale: false,
						recordedAt: '2026-08-31T11:45:00Z',
						reviewer,
					},
				],
			}),
			href: '/l/review/drafts/draft-112',
		},
	});

	// The server status renders verbatim with the success tone...
	assert.match(body, /gr-blog-review-card__state--approved"/);
	assert.match(body, /APPROVED/);
	// ...and carries none of the superseded wording or the stale tone.
	assert.doesNotMatch(body, /\(superseded\)/);
	assert.doesNotMatch(body, /gr-blog-review-card__state--stale-approved/);
	assert.doesNotMatch(body, /This approval no longer counts/);
	assert.match(body, /latest activity, not publication state/);
});
