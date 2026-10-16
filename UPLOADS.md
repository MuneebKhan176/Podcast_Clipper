# Resumable video uploads — update guide

Copy the `backend/` and `frontend/` folders in this package over your project (same relative paths; files marked
**MODIFIED** replace your current ones, **NEW** files are added). Then:

```bash
cd backend  && npm install && npm run migrate      # installs the AWS SDK, creates the `uploads` table
cd frontend && npm install                          # nothing new, but safe to run
```

## One-time cloud setup (Cloudflare R2)

1. **CORS** (bucket > Settings > CORS policy). The browser PUTs parts straight to R2, so R2 must allow your site:
   ```json
   [{ "AllowedOrigins": ["http://localhost:5173"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
   (Add your production origin later. `ExposeHeaders: ETag` is NOT needed.)
2. **Lifecycle rule** (bucket > Settings > Object lifecycle rules): "Abort incomplete multipart uploads" after 7 days.
   A safety net; the backend also expires abandoned sessions itself (`UPLOAD_SESSION_TTL_HOURS`, default 48).
3. **Env** (already in your `.env`): `CLOUD_ACCOUNT_ID`, `BUCKET_NAME`, `CLOUD_PUBLIC_URI`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`.
   `TOKEN_VALUE` (the `cfat_…` API token) is **not used**: uploads use the S3 API credentials.
   `ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` must be an R2 *S3 API token* with **Object Read & Write** on the bucket.
   `CLOUD_PUBLIC_URI` only builds the link shown after upload; the bucket must have public access (r2.dev or a custom domain) for that link to open.

## How it works

```
Browser                                Backend (Express + Postgres)                 R2
  | POST /api/uploads  {name,size,fingerprint}                                       |
  |------------------------------------> create (or find) the session ------------->| CreateMultipartUpload
  |<-- {uploadId, partSize, totalParts, completedParts:[...]}   <-- ListParts -------|   (resume checkpoint)
  | POST /api/uploads/:id/parts/sign {partNumbers}                                   |
  |------------------------------------> presigned PUT URLs (15 min)                 |
  | PUT <url>  (16 MiB chunk, 3 in parallel, retried)  ------------------------------------------------>| UploadPart
  | POST /api/uploads/:id/complete                                                   |
  |------------------------------------> ListParts, verify EVERY part's size ------->| CompleteMultipartUpload + Head
  |<-- {status:"completed", publicUrl}                                               |
```

* The 3–5 GB never passes through your server; it only issues URLs and verifies the result.
* **Checkpoint strategy:** the source of truth for "what is already uploaded" is R2's own `ListParts`, not a counter in
  the database, so the two can never disagree. After a network drop, tab close, crash or reload, the same file picked again
  gets the same fingerprint → the same session → only the missing parts are sent.
* **Idempotency:** initiate (same user+file → same session; unique index + race handling), part upload (same part number
  overwrites itself), complete (atomic claim; repeating it returns the same result; crash-recovery if R2 finished but the
  reply was lost), abort (repeatable), finished files are returned instead of re-uploaded.
* **Timeouts / failures:** per-part retry with exponential backoff + jitter (6 attempts), stall detection (30 s without bytes),
  waits for the browser's `online` event instead of burning attempts, refreshes expired URLs, SDK retries on the server,
  storage outages return a clean 502 and never leave a half-finished state.
* **Integrity:** before assembling, every part's exact byte length is checked; damaged/missing parts are reported and re-sent;
  the final object's size is verified with a HEAD request.

## Config (backend `.env`, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `UPLOAD_PART_SIZE_MB` | 16 | chunk size (min 5; auto-grows for huge files so parts ≤ 10,000) |
| `UPLOAD_MAX_BYTES` | 10737418240 | largest accepted file (10 GiB) |
| `UPLOAD_MAX_ACTIVE_PER_USER` | 3 | unfinished uploads per user |
| `UPLOAD_URL_TTL_SECONDS` | 900 | lifetime of each presigned URL |
| `UPLOAD_SESSION_TTL_HOURS` | 48 | idle time before an unfinished upload is discarded |
| `UPLOAD_COMPLETE_STALE_SECONDS` | 120 | when a stuck "finalizing" claim may be taken over |
| `CLOUD_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | override for MinIO / local testing |

## Tests

```bash
cd backend  && TEST_DATABASE_URL=postgres://user:pass@localhost:5432/podcast_clipper_test npm test
cd frontend && npm test
```
