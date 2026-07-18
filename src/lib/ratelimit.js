// ratelimit.js — thin wrapper over the native Workers Rate Limiting binding.
// Abuse mitigation, NOT authentication: it FAILS OPEN. If the binding is absent
// (local dev / tests) or errors, creation is allowed rather than blocked. See
// SECURITY.md §6.

/** Returns true if the request may proceed, false if it should be 429'd. */
export async function allowCreate(env, request) {
  const rl = env.CREATE_RL;
  if (!rl || typeof rl.limit !== 'function') return true; // fail open
  try {
    const key = request.headers.get('CF-Connecting-IP') || 'anonymous';
    const { success } = await rl.limit({ key });
    return success !== false;
  } catch {
    return true; // fail open
  }
}
