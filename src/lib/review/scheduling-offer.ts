/**
 * Whether the schedule control starts offered, from the instance's own answer.
 *
 * Until lesser v1.6.4 the only signal was the mutation's refusal: the control
 * was offered, and an instance with scheduling off answered with the
 * feature-gate error, which ended the offering for the session. v1.6.4 serves
 * the capability — `InstanceInfo.cmsFeatures.scheduling` on the public
 * `instance` field, read through `$lib/instance/info` — so a served `false` is
 * the same answer known BEFORE the first refusal: the control starts
 * unavailable and no `scheduleDraft` request is ever made.
 *
 * A served `true`, or an instance that did not answer at all (pre-v1.6.4, or a
 * failed read), keeps the old behaviour: offer, and let the typed
 * FEATURE_DISABLED refusal remain the final word — a served `true` can still
 * be stale by click time, and lesser re-checks `requireCMSSchedulingEnabled`
 * at the mutation regardless.
 *
 * Pure and dependency-light for the same reason `verdict-offer.ts` is: the
 * rule is readable in one place and loadable by a probe without a bundler.
 */

import type { InstanceInfo } from '../instance/info.ts';

export function initialSchedulingOffer(info: InstanceInfo | null): boolean {
	return info?.cmsFeatures.scheduling ?? true;
}
