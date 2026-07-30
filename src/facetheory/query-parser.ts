import type { Query } from '@theory-cloud/facetheory';

/** Parse a raw search string into FaceTheory's multi-value query shape. */
export function queryFromSearchString(search: string): Query {
	const params = new URLSearchParams(search);
	const query: Query = {};
	for (const [key, value] of params.entries()) {
		(query[key] ??= []).push(value);
	}
	return query;
}
