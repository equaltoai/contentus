import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSchema, parse, validate } from 'graphql';

import { main, redacting, VIEWER_IDENTITY_QUERY } from '../scripts/probe-live-contract.mjs';

/**
 * THE PROBE'S OWN CONTRACT.
 *
 * The defect these tests exist against: the probe printed `AUTHENTICATED` whenever
 * `CONTENTUS_PROBE_TOKEN` was set, and the three documents it then read are all
 * PUBLIC. Adversarial review ran the exact reviewed head with
 * `CONTENTUS_PROBE_TOKEN=codex-review-intentionally-invalid`, got AUTHENTICATED,
 * three passes and exit 0. Lesser's auth surface may treat an invalid bearer as
 * anonymous, so a public read succeeding says nothing whatever about the session.
 * The probe was reporting the presence of an environment variable as a property of
 * the instance.
 *
 * NO REAL CREDENTIAL APPEARS IN THIS FILE, and none is needed. The token is a
 * MARKER — a string whose only job is to be recognisable in output. That is the
 * right shape for testing a redactor: planting a real secret to prove it is hidden
 * builds exactly what the secret sweep forbids, and proves less, because a marker
 * can be asserted on directly.
 *
 * EVERY DIRECTION IS DRIVEN THROUGH AN INJECTED `fetch`. The instance is not
 * reachable from CI, and a test that needed it to be would only ever exercise the
 * happy path — which is the path that was already green while the claim was false.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** A marker, not a credential: recognisable, worthless, and never sent anywhere real. */
const TOKEN_MARKER = 'contentus-probe-marker-not-a-credential-0000';

const BASE = ['--base', 'https://instance.invalid'];

/** Collects everything the probe writes, so assertions read exactly what a human would. */
function collector() {
	const chunks = [];
	return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

/**
 * A lesser whose answers are whatever the case says they are, keyed by OPERATION
 * NAME.
 *
 * Keyed on the name rather than on call order, so a probe that reordered its reads
 * would not silently start testing something else — and rather than on substrings
 * of the body, which is how the first version of this harness routed the index
 * query to the navigation answer: `ARTICLE_SUMMARY_FIELDS` selects `categories`,
 * so "does the document mention categories" is true of both. A fixture that
 * matches the wrong document is the same defect as a fixture written to agree with
 * a wrong query, one level up.
 */
const OPERATIONS = {
	ContentusProbeViewerIdentity: 'viewer',
	ContentusArticlesIndex: 'index',
	ContentusArticleNavigation: 'navigation',
	ContentusArticleBySlug: 'detail',
	ContentusAvatarUrlControl: 'control',
};

function lesserReturning(answers) {
	return async (_endpoint, init) => {
		const body = JSON.parse(init.body);
		const operation = body.query.match(/\bquery\s+(\w+)/)?.[1] ?? null;
		const key = OPERATIONS[operation];
		if (!key) throw new Error(`the harness does not know the operation ${operation}`);
		const answer = answers[key];
		if (!answer) throw new Error(`the test supplied no answer for ${key}`);
		const payload = typeof answer === 'function' ? answer(body) : answer;
		return {
			status: payload.status ?? 200,
			ok: (payload.status ?? 200) < 400,
			text: async () => JSON.stringify(payload.body ?? {}),
		};
	};
}

/** The shapes a healthy instance returns, so each case only overrides what it is about. */
const HEALTHY = {
	viewer: { body: { data: { viewer: { id: 'actor-1', username: 'curator' } } } },
	index: {
		body: {
			data: {
				articles: {
					totalCount: 1,
					edges: [
						{
							node: {
								slug: 'a-real-slug',
								author: { username: 'curator', avatar: null },
							},
						},
					],
				},
			},
		},
	},
	navigation: { body: { data: { articleCategories: [] } } },
	detail: {
		body: {
			data: {
				articleBySlug: {
					contentFormat: 'MARKDOWN',
					content: 'body',
					author: { username: 'curator', avatar: null },
				},
			},
		},
	},
	control: {
		status: 422,
		body: {
			errors: [
				{ message: 'Cannot query field "avatarUrl" on type "Actor". Did you mean "avatar"?' },
			],
		},
	},
};

const withOverrides = (overrides) => lesserReturning({ ...HEALTHY, ...overrides });

/* =========================================================================
 * The finding itself: a token is not a session
 * ====================================================================== */

test('an invalid token fails non-zero even though every public read succeeds', async () => {
	// THE REVIEWER'S EXACT RUN. The public documents all answer — that is the point
	// — and the probe must still exit non-zero and must never print AUTHENTICATED.
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({
			viewer: { status: 401, body: { errors: [{ message: 'authentication required' }] } },
		}),
		env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.ok(!/\bAUTHENTICATED as\b/.test(out.text()), 'an invalid token must never be certified');
	assert.match(out.text(), /NOT AUTHENTICATED/);
	assert.match(out.text(), /authentication required/);
});

test('a token treated as anonymous — 200 with no viewer — also fails', async () => {
	// Lesser's auth surface may hand an invalid bearer straight to the anonymous
	// path rather than refusing it. A null viewer with HTTP 200 and no errors is
	// therefore the shape that matters most, and it is the one a naive check misses.
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({ viewer: { body: { data: { viewer: null } } } }),
		env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /NOT AUTHENTICATED/);
});

test('an empty identity is not an identity', async () => {
	for (const viewer of [
		{ id: '', username: 'curator' },
		{ id: 'actor-1', username: '' },
		{ id: 'actor-1', username: '   ' },
		{ id: null, username: null },
		{},
	]) {
		const out = collector();
		const status = await main(BASE, {
			fetchImpl: withOverrides({ viewer: { body: { data: { viewer } } } }),
			env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
			write: out.write,
		});
		assert.equal(status, 1, `${JSON.stringify(viewer)} must not certify:\n${out.text()}`);
		assert.ok(!/\bAUTHENTICATED as\b/.test(out.text()));
	}
});

test('the identity read happens BEFORE any public document', async () => {
	// Ordering is part of the control. If the public reads ran first, a rejected
	// session would still have produced a page of green output above the failure,
	// which is the report a hurried reader takes away.
	const asked = [];
	const rejectingViewer = withOverrides({
		viewer: { status: 401, body: { errors: [{ message: 'authentication required' }] } },
	});
	const status = await main(BASE, {
		// Bound to a name rather than called as `withOverrides({…})(endpoint, init)`.
		// The call-of-a-call is a shape CON-5's closure walk cannot follow, and the
		// honest repair is to stop writing code it cannot read rather than to
		// disclose past it: a disclosure is a count of what a reading missed, not a
		// licence to keep adding to the count.
		fetchImpl: async (endpoint, init) => {
			asked.push(JSON.parse(init.body).query);
			return rejectingViewer(endpoint, init);
		},
		env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
		write: () => {},
	});

	assert.equal(status, 1);
	assert.equal(asked.length, 1, 'nothing may be read after the identity check fails');
	assert.match(asked[0], /ProbeViewerIdentity/);
});

test('a genuinely authenticated session passes, so the reds above are not vacuous', async () => {
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({}),
		env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
		write: out.write,
	});

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /AUTHENTICATED as curator \(actor-1\)/);
	assert.match(out.text(), /authenticated session verified by protected identity read/);
	// Four: the protected identity read plus the three CMS documents. The identity
	// read is counted because it is required to pass — a tally that omitted it
	// would describe less work than the run actually gated.
	assert.match(out.text(), /4\/4 documents accepted/);
});

test('anonymous mode still works, and never claims a session', async () => {
	const out = collector();
	const status = await main(BASE, { fetchImpl: withOverrides({}), env: {}, write: out.write });

	assert.equal(status, 0, out.text());
	assert.match(out.text(), /ANONYMOUS \(no credential\)/);
	assert.match(out.text(), /3\/3 documents accepted/, 'and no identity read to count');
	assert.ok(!/AUTHENTICATED/.test(out.text()));
	assert.ok(
		!/authenticated session verified/.test(out.text()),
		'an anonymous run must not borrow the authenticated claim'
	);
});

/* =========================================================================
 * No skip-to-green
 * ====================================================================== */

test('an index with no slug fails rather than skipping the detail document', async () => {
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({
			index: { body: { data: { articles: { totalCount: 0, edges: [] } } } },
		}),
		env: {},
		write: out.write,
	});

	assert.equal(status, 1, out.text());
	assert.match(out.text(), /\[FAIL\] articleBySlug/);
	assert.match(out.text(), /incomplete probe rather than a pass/);
	assert.ok(!/\[SKIP\]/.test(out.text()), 'a skipped document must not read as a pass');
});

test('a failing detail document fails the run', async () => {
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({
			detail: { status: 422, body: { errors: [{ message: 'Cannot query field "nope"' }] } },
		}),
		env: {},
		write: out.write,
	});
	assert.equal(status, 1, out.text());
});

test('a negative control that does not bite fails the run', async () => {
	// Without this, a green run proves the endpoint answers, not that it adjudicates.
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({ control: { body: { data: { articles: { edges: [] } } } } }),
		env: {},
		write: out.write,
	});
	assert.equal(status, 1, out.text());
	assert.match(out.text(), /DID NOT BITE/);
});

/* =========================================================================
 * The credential never leaves
 * ====================================================================== */

test('a hostile instance echoing the token back cannot get it into the output', async () => {
	// The path that is not ours: a GraphQL error message is server-controlled text,
	// and an instance that reflects the Authorization header into one would have
	// printed the credential straight to the operator's terminal.
	const out = collector();
	const status = await main(BASE, {
		fetchImpl: withOverrides({
			viewer: {
				status: 401,
				body: {
					errors: [{ message: `bearer ${TOKEN_MARKER} was rejected by the authorization server` }],
				},
			},
		}),
		env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
		write: out.write,
	});

	assert.equal(status, 1);
	assert.ok(
		!out.text().includes(TOKEN_MARKER),
		`the credential reached the output:\n${out.text()}`
	);
	assert.match(out.text(), /«redacted»/, 'and the reader is told something was removed');
});

test('the token is redacted out of data, exceptions and every other path', async () => {
	for (const hostile of [
		// Reflected in article data rather than in an error.
		() =>
			withOverrides({
				index: {
					body: {
						data: {
							articles: {
								totalCount: 1,
								edges: [
									{
										node: { slug: TOKEN_MARKER, author: { username: TOKEN_MARKER, avatar: null } },
									},
								],
							},
						},
					},
				},
			}),
		// Reflected in a thrown network error.
		() => async () => {
			throw new Error(`connect failed while sending ${TOKEN_MARKER}`);
		},
		// Reflected in a non-JSON body.
		() => async () => ({ status: 200, ok: true, text: async () => `not json ${TOKEN_MARKER}` }),
	]) {
		const out = collector();
		await main(BASE, {
			fetchImpl: hostile(),
			env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
			write: out.write,
		});
		assert.ok(
			!out.text().includes(TOKEN_MARKER),
			`the credential reached the output:\n${out.text()}`
		);
	}
});

test('the token is sent as a bearer header and appears nowhere in the request URL', async () => {
	let seen = null;
	const healthy = withOverrides({});
	await main(BASE, {
		fetchImpl: async (endpoint, init) => {
			seen = { endpoint, headers: init.headers, body: init.body };
			return healthy(endpoint, init);
		},
		env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
		write: () => {},
	});

	assert.equal(seen.headers.authorization, `Bearer ${TOKEN_MARKER}`);
	assert.ok(!seen.endpoint.includes(TOKEN_MARKER), 'a URL lands in logs and proxies');
	assert.ok(!seen.body.includes(TOKEN_MARKER), 'and a request body is echoed by error paths');
});

test('the redactor refuses to be a formality', () => {
	// A redactor that missed an encoding would be worse than none, because the
	// output would carry the reassurance of having been redacted.
	const chunks = [];
	const say = redacting((text) => chunks.push(text), TOKEN_MARKER);
	say(`raw ${TOKEN_MARKER}`);
	say(`encoded ${encodeURIComponent(TOKEN_MARKER)}`);
	say(`base64 ${Buffer.from(TOKEN_MARKER).toString('base64')}`);
	const text = chunks.join('\n');
	assert.ok(!text.includes(TOKEN_MARKER));
	assert.equal(text.match(/«redacted»/g).length, 3);

	// With no token there is nothing to redact and nothing is mangled.
	const plain = [];
	const plainly = redacting((text) => plain.push(text), null);
	plainly('untouched output');
	assert.deepEqual(plain, ['untouched output']);
});

/* =========================================================================
 * The identity document is one lesser accepts
 * ====================================================================== */

test('the viewer identity document validates against the pinned lesser schema', () => {
	// The anti-drift control, and it is stronger than importing the document would
	// be: importing proves two files in this repository agree, which is the exact
	// mistake this milestone is about. Validating proves lesser would accept it.
	const schema = buildSchema(
		readFileSync(join(REPO, 'contracts/lesser/graphql-schema.graphql'), 'utf8')
	);
	const errors = validate(schema, parse(VIEWER_IDENTITY_QUERY));
	assert.deepEqual(
		errors.map((error) => error.message),
		[]
	);

	// And the paired red: the schema is what adjudicates, not the parser.
	const regressed = VIEWER_IDENTITY_QUERY.replace('username', 'userName');
	assert.notEqual(regressed, VIEWER_IDENTITY_QUERY);
	const regressedErrors = validate(schema, parse(regressed));
	assert.equal(regressedErrors.length, 1);
	assert.match(regressedErrors[0].message, /Cannot query field "userName" on type "Actor"/);
});

test('the identity read is a query — and every document the probe sends is one', () => {
	// The probe runs against a real instance under an operator's credential. A
	// mutation reaching it would be a state change nobody asked for, so the property
	// is checked over the DOCUMENTS the probe actually sends rather than over the
	// file's prose — the first version of this test matched the sentence "there is
	// no mutation in this file" and went red on its own documentation.
	const sent = [];
	const capture = async (_endpoint, init) => {
		sent.push(JSON.parse(init.body).query);
		return { status: 200, ok: true, text: async () => JSON.stringify({ data: {} }) };
	};
	return main(BASE, { fetchImpl: capture, env: {}, write: () => {} }).then(() => {
		assert.ok(sent.length >= 3, 'the probe must have sent its documents');
		for (const document of [...sent, VIEWER_IDENTITY_QUERY]) {
			for (const definition of parse(document).definitions) {
				assert.equal(
					definition.operation,
					'query',
					`${definition.name?.value ?? '<anonymous>'} must be a query, not a ${definition.operation}`
				);
			}
		}
	});
});

/* =========================================================================
 * Input handling
 * ====================================================================== */

test('a non-https base is refused before a credential could leave over plaintext', async () => {
	for (const base of [['--base', 'http://instance.invalid'], ['--base', 'not-a-url'], []]) {
		const out = collector();
		const status = await main(base, {
			fetchImpl: () => {
				throw new Error('no request may be made');
			},
			env: { CONTENTUS_PROBE_TOKEN: TOKEN_MARKER },
			write: out.write,
		});
		assert.equal(status, 1, out.text());
		assert.ok(!out.text().includes(TOKEN_MARKER));
	}
});
