# Anonymous paste statistics

`GET /api/statistics` returns the same public aggregate to every visitor:

```json
{
  "totalPastes": 42,
  "baseline": 0,
  "scope": "successfully created pastes since statistics deployment"
}
```

The endpoint is read-only, returns `503` if the aggregate store cannot be read, and briefly
caches successful responses. A zero baseline is intentional: existing storage cannot provide a
lifetime count. New pastes are held in one Durable Object per paste and removed after being
consumed, explicitly deleted, or expired. Older KV records may also have expired or been
deleted. Enumerating records still present would not recover those missing creations.

After a paste Durable Object confirms a successful write, the Worker schedules one increment
using `waitUntil`. The statistics subsystem receives only an increment request. It is not given
the paste ID, ciphertext, encryption key, URL fragment, delete token, IP address, or request
metadata. Sixteen independent Durable Objects store only aggregate integer totals; the read
endpoint sums them. Statistics failure is best-effort and does not fail paste creation.

This counter records successful paste storage commits from deployment onward. If a client
submits a new creation request after an earlier response was lost, each separately stored paste
is counted as a creation. The API has no idempotency key, and statistics do not introduce one
or retain a mapping between requests and pastes.
