/**
 * The path lesser reserves for the installed FaceTheory client.
 *
 * This is a lesser ROUTING constant, not an instance-specific value: every
 * lesser stage stack routes `/l` and `/l/*` to the SSR host and `/l/_assets/*`
 * to the client asset bucket (lesser `docs/guides/CLIENT_APP_GUIDE.md`
 * → "Routing model"). `LESSER_CLIENT_BASE_PATH=/l` is the only relevant env
 * the SSR host sets, so the value is the same on every instance and is safe to
 * carry as a constant.
 *
 * It is emphatically NOT a domain. No host, origin, or instance name appears
 * anywhere in contentus source — those derive from the request at runtime
 * (`src/lib/cms/origin.ts`).
 */
export const APP_BASE_PATH = '/l';

/** Public URL of the external hydration data endpoint, base path included. */
export const HYDRATION_DATA_PATH = '/_facetheory/hydration';

/** Public URL prefix for built client assets. */
export const CLIENT_ASSET_BASE = `${APP_BASE_PATH}/_assets/`;
