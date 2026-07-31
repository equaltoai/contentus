/**
 * `uploadMedia` against lesser's GraphQL contract.
 *
 * STILL GRAPHQL-FIRST. `UploadMediaInput.file` is the `Upload` scalar, which
 * gqlgen consumes through the GraphQL multipart request specification — a
 * `multipart/form-data` POST to the SAME `/api/graphql` endpoint, carrying
 * `operations` and `map` parts beside the file. lesser enables it explicitly
 * (`cmd/graphql/main.go` → `server.AddTransport(transport.MultipartForm{...})`).
 * This is the GraphQL upload transport, not a REST side door: there is no
 * second endpoint, no second contract, and no second auth model.
 *
 * WHY XMLHttpRequest AND NOT fetch. `fetch` reports no upload progress, and the
 * vendored `Compose.MediaUpload` paints a progress ring from the callback it is
 * handed. Feeding that ring 0-then-100 would be a control that looks like it is
 * telling you something while telling you nothing — on the phone connections
 * this face exists for, that is the difference between "still going" and
 * "stalled". XHR's `upload.onprogress` is the only browser API that answers,
 * and it is same-origin, so strict CSP's `connect-src` covers it unchanged.
 *
 * lesser caps the upload at `MaxUploadSize` (10 MiB by default,
 * `graph/mutation_resolvers_media.go`) and does not advertise the value on its
 * GraphQL surface — the same shape of gap as the status length limit. The
 * client does not guess: an oversized file is refused by the instance and the
 * message is shown as-is.
 */

import { accessTokenOrNull } from '$lib/auth/session';

import type { ComposeFailure, ComposeResult } from './compose';
import { graphqlRequest, GraphQLTransportError } from './graphql';
import { GRAPHQL_PATH } from './origin';

/** lesser `MediaCategory`, matching the vendored compose vocabulary exactly. */
export type MediaCategory = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'GIFV' | 'DOCUMENT';

/** lesser `UploadMediaInput`, minus the file itself. */
export interface UploadMediaOptions {
	filename?: string;
	description?: string;
	focus?: { x: number; y: number };
	sensitive?: boolean;
	spoilerText?: string;
	mediaType?: MediaCategory;
}

/** The `Media` fields an attachment strip needs. */
export interface UploadedMedia {
	id: string;
	url: string;
	previewUrl: string | null;
	description: string | null;
	sensitive: boolean;
	spoilerText: string | null;
	mediaCategory: MediaCategory;
	mimeType: string;
}

const UPLOAD_MEDIA_MUTATION = `
	mutation ContentusUploadMedia($input: UploadMediaInput!) {
		uploadMedia(input: $input) {
			uploadId
			warnings
			media {
				id
				url
				previewUrl
				description
				sensitive
				spoilerText
				mediaCategory
				mimeType
			}
		}
	}
`;

interface GraphQLEnvelope {
	data?: { uploadMedia?: { media?: Record<string, unknown>; warnings?: string[] } } | null;
	errors?: { message: string }[];
}

function toUploadedMedia(raw: unknown): UploadedMedia | null {
	if (!raw || typeof raw !== 'object') return null;
	const media = raw as Record<string, unknown>;
	if (typeof media['id'] !== 'string' || media['id'].length === 0) return null;

	return {
		id: media['id'],
		url: typeof media['url'] === 'string' ? media['url'] : '',
		previewUrl: typeof media['previewUrl'] === 'string' ? media['previewUrl'] : null,
		description: typeof media['description'] === 'string' ? media['description'] : null,
		sensitive: media['sensitive'] === true,
		spoilerText: typeof media['spoilerText'] === 'string' ? media['spoilerText'] : null,
		mediaCategory: (String(media['mediaCategory'] ?? 'UNKNOWN').toUpperCase() ??
			'UNKNOWN') as MediaCategory,
		mimeType: typeof media['mimeType'] === 'string' ? media['mimeType'] : '',
	};
}

/**
 * Build the multipart body the GraphQL upload spec defines.
 *
 * `operations` carries the document with a null where the file goes; `map`
 * names the variable path that null belongs to; the numbered part is the file.
 * The null is required — it is what tells the server the variable exists and is
 * waiting to be filled from a part.
 */
function buildUploadForm(file: File, options: UploadMediaOptions): FormData {
	const input: Record<string, unknown> = { file: null };

	if (options.filename ?? file.name) input['filename'] = options.filename ?? file.name;
	if (options.description) input['description'] = options.description;
	if (options.focus) input['focus'] = options.focus;
	if (options.sensitive !== undefined) input['sensitive'] = options.sensitive;
	if (options.spoilerText) input['spoilerText'] = options.spoilerText;
	if (options.mediaType) input['mediaType'] = options.mediaType;

	const form = new FormData();
	form.append('operations', JSON.stringify({ query: UPLOAD_MEDIA_MUTATION, variables: { input } }));
	form.append('map', JSON.stringify({ '0': ['variables.input.file'] }));
	form.append('0', file, options.filename ?? file.name);
	return form;
}

function transportFailure(message: string): ComposeFailure {
	return { reason: 'transport', message };
}

/**
 * Upload one file, reporting real progress.
 *
 * Resolves with a failure rather than rejecting: the caller is a per-file
 * upload loop, and one file that could not be sent should not take the others
 * with it.
 */
export function uploadMedia(
	file: File,
	options: UploadMediaOptions = {},
	onProgress?: (percent: number) => void
): Promise<ComposeResult<UploadedMedia>> {
	const accessToken = accessTokenOrNull();
	if (!accessToken) {
		return Promise.resolve({
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to attach media.' },
		});
	}

	return new Promise((resolve) => {
		const request = new XMLHttpRequest();
		request.open('POST', GRAPHQL_PATH, true);
		request.setRequestHeader('accept', 'application/json');
		request.setRequestHeader('authorization', `Bearer ${accessToken}`);
		// No content-type header: the browser sets it, including the multipart
		// boundary, which is the only place that boundary exists.
		request.withCredentials = false;

		request.upload.onprogress = (event) => {
			if (!event.lengthComputable) return;
			onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
		};

		request.onerror = () =>
			resolve({
				ok: false,
				failure: transportFailure('The upload could not reach the instance.'),
			});

		request.ontimeout = () =>
			resolve({ ok: false, failure: transportFailure('The upload timed out.') });

		request.onload = () => {
			let envelope: GraphQLEnvelope;
			try {
				envelope = JSON.parse(request.responseText) as GraphQLEnvelope;
			} catch {
				resolve({
					ok: false,
					failure: transportFailure(
						`The instance returned a non-JSON response to the upload (${request.status}).`
					),
				});
				return;
			}

			if (envelope.errors?.length) {
				resolve({
					ok: false,
					failure: {
						reason: 'rejected',
						message: envelope.errors[0]?.message ?? 'The instance rejected this file.',
					},
				});
				return;
			}

			const media = toUploadedMedia(envelope.data?.uploadMedia?.media);
			if (!media) {
				resolve({
					ok: false,
					failure: {
						reason: 'rejected',
						message: 'The instance accepted the upload but returned no media to attach.',
					},
				});
				return;
			}

			onProgress?.(100);
			resolve({ ok: true, value: media });
		};

		request.send(buildUploadForm(file, options));
	});
}

const UPDATE_MEDIA_MUTATION = `
	mutation ContentusUpdateMedia($id: ID!, $input: UpdateMediaInput!) {
		updateMedia(id: $id, input: $input) {
			id
			url
			previewUrl
			description
			sensitive
			spoilerText
			mediaCategory
			mimeType
		}
	}
`;

/**
 * Update an uploaded attachment's alt text or focal point.
 *
 * Separate from the upload because the poster writes alt text after seeing the
 * thumbnail, and lesser models that the same way: `UpdateMediaInput` carries
 * `description` and `focus` and nothing else. An alt text that only ever
 * existed in the composer's local state would be an accessibility control that
 * does not work, which is worse than not offering one.
 *
 * NOTE, recorded rather than worked around: lesser exposes no `deleteMedia` on
 * its GraphQL surface, so an attachment the poster uploads and then removes
 * before posting stays on the instance unreferenced. Contentus detaches it from
 * the draft, which is all the contract allows a client to do. Upstream
 * observation for the lesser steward.
 */
export async function updateMedia(
	id: string,
	input: { description?: string; focus?: { x: number; y: number } }
): Promise<ComposeResult<UploadedMedia>> {
	const accessToken = accessTokenOrNull();
	if (!accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in to edit media.' },
		};
	}

	try {
		const result = await graphqlRequest<{ updateMedia?: unknown }>(
			UPDATE_MEDIA_MUTATION,
			{ id, input },
			{ accessToken }
		);

		if (result.errors.length > 0) {
			return {
				ok: false,
				failure: {
					reason: 'rejected',
					message: result.errors[0]?.message ?? 'The instance rejected the media update.',
				},
			};
		}

		const media = toUploadedMedia(result.data?.updateMedia);
		if (!media) {
			return {
				ok: false,
				failure: { reason: 'rejected', message: 'The media update returned nothing to apply.' },
			};
		}

		return { ok: true, value: media };
	} catch (error) {
		return {
			ok: false,
			failure: transportFailure(
				error instanceof GraphQLTransportError
					? 'The instance did not answer the media update.'
					: 'The media update could not be sent.'
			),
		};
	}
}
