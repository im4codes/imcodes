# Opt-in Cloudflare R2 file relay

Default: direct. No new bridge or file-byte proxy is used. An administrator must set
`USE_R2_RELAY=true`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` in the server environment. Use a private, dedicated staging
bucket and bucket-scoped Object Read & Write S3 credentials. Never ship credentials
to the browser or daemon. Each signed-in user must separately check **Use R2 file relay**
in the sidebar/footer. The preference is per account on this browser. Disabled,
incomplete configuration, old daemons, and controlled nodes keep existing direct behavior.
A failure after a relay begins is reported, not silently rerouted or reported as success.

Upload: authenticated metadata request → signed PUT → browser PUT directly to R2 →
authenticated commit → server checks object size → daemon fetches signed GET. Normal
attachment registration/dedupe remains owned by the daemon. The application server
never buffers upload bytes. Upload tickets bind user, server, session, object and size.

Download: authorized attachment handle → daemon PUT to signed staging URL → request-
scoped progress on WS/NDJSON → short-lived signed GET. The download center shows the
**daemon-to-R2 preparation** bytes, EWMA speed and ETA separately from the subsequent
browser download. A save-picker destination receives the R2 GET directly; other clients
hand the URL to the browser/system download manager, whose final disk completion is
not observable by this page. Cancellation stops client waiting; an already-running
PUT may finish and is still subject to staging cleanup. No bucket credentials reach
the daemon. Only upgraded full daemons advertise the independent R2 capability.

## CORS

On the dedicated bucket allow only the deployed app origins (include the exact native
WebView origin if used), methods `PUT`, `GET`, `HEAD`, headers `content-type`, and expose
`content-length`, `content-type`, `content-disposition`, `etag`. Do not make the bucket
public. Presigned URLs use the S3 API endpoint, not an R2 custom domain. They expire in
15 minutes and authorize exactly one object/method; treat them as temporary secrets.
Large requests must start within that window. Local upload tickets do not survive a
server restart; retry an interrupted upload. Cleanup does survive restarts because it
lists R2 itself, not an in-memory inventory.

## 12-hour retention

Keys are always `staging/YYYY-MM-DD/<random-id>-<filename>`. Configure the Cloudflare
lifecycle API (not S3's integer `Days` field) with an age condition in seconds:

```json
{"rules":[{"id":"imcodes-staging-12h","enabled":true,"conditions":{"prefix":"staging/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":43200}}}]}
```

Merge this rule with existing rules; do not overwrite unrelated bucket policies.
Lifecycle management needs separate Cloudflare API permission; S3 object credentials
are intentionally not given account-wide policy-management permission. The app does
not automatically modify bucket policies. After startup and every 60 seconds while
configured, the server lists only `staging/`, paginates, and deletes recognized staging
keys whose R2 `LastModified` is at least 12 hours old. Partial sweeps retry the next tick;
multiple replicas are safe because deletion is idempotent. Deletion also covers orphaned
and failed-transfer objects. Disabling deployment configuration stops this sweeper, so
keep the bucket lifecycle rule enabled independently.

**Limits:** 12 hours is the expiration threshold, not an exact deletion/billing SLA.
Cloudflare lifecycle processing can lag (typically up to 24 hours after expiration);
the minute sweep narrows that delay while the server and R2 are reachable. Outages or
revoked permissions delay deletion; no implementation can guarantee zero extra cost
or physical removal at an exact second. Monitor cleanup warnings. These are temporary
staging objects, not durable attachment storage.

References: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/),
[lifecycle age seconds API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/).

Local tests use mocked S3 HTTP and real isolated daemon files. Real R2 credentials,
bucket CORS/lifecycle policy installation and cross-country throughput are deployment
checks, not claims made by those unit tests.
