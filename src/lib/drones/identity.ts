/**
 * Simulacrum owns the identity/promotion surface at the instance root. This is
 * deliberately not passed through Contentus's `href`: `/l` belongs to this
 * client, while the sibling client owns `/identity/{username}` on the same
 * Lesser origin.
 */
export function identitySurfaceHref(username: string): string {
	return `/identity/${encodeURIComponent(username)}`;
}
