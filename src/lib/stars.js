// Daily snapshot of the repository's star count. The scheduled Worker is the
// only code that calls GitHub; visitors read the last successful value from KV.

export const STAR_COUNT_KEY = 'system:github-stars:v1';
export const STARS_TTL = 1800;
export const STARS_ERROR_TTL = 60;

const USER_AGENT = 'binthere (+https://binthere.gaury.dev)';

/** Fetch the count once from GitHub's REST API. Returns null on failure. */
export async function fetchStars(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;

  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}`, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/vnd.github+json',
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  try {
    return parseStars(await response.json());
  } catch {
    return null;
  }
}

/** Read the last scheduled snapshot from KV, or null before its first success. */
export async function readStoredStars(env) {
  const value = await env.PASTES.get(STAR_COUNT_KEY);
  if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) return null;
  const stars = Number(value);
  return Number.isSafeInteger(stars) ? stars : null;
}

/** Refresh the KV snapshot; skip the write when GitHub's value is unchanged. */
export async function updateStarCount(env) {
  const stars = await fetchStars(env.GITHUB_REPOSITORY);
  if (stars === null) return { status: 'unavailable' };

  const current = await readStoredStars(env);
  if (current === stars) return { status: 'unchanged', stars };

  await env.PASTES.put(STAR_COUNT_KEY, String(stars));
  return { status: current === null ? 'initialized' : 'updated', stars };
}

/** Pull the count out of a GitHub repo payload; null if it isn't one. */
export function parseStars(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const n = data.stargazers_count;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
