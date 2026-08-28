# Glossy POS Backend Upload API

Production-ready upload API for `/uploads` (multipart/form-data) with PDPA-friendly defaults.

## Endpoint

`POST /uploads`

Form fields:
- `customerName` (required)
- `phone` (required, digits only, min 9)
- `note` (optional)
- `jobType` (required enum):
  - `Document Printing`
  - `Photocopy`
  - `Sticker`
  - `Business Card`
  - `Poster`
  - `Vinyl Banner`
  - `Packaging`
  - `Other`

Files:
- `files[]` (required, min 1, max 10)
- Allowed: `pdf,jpg,jpeg,png,ai,psd,zip,doc,docx,xls,xlsx,csv`
- Max per file: `7,500,000 bytes` (about `7.15 MiB`)

Success response:
```json
{
  "uploadId": "string",
  "orderCode": "string",
  "message": "Upload success"
}
```

## Run

```bash
npm ci
cp .env.example .env.development
npm run start:dev
```

## Test

```bash
npm run test:e2e
```

## Health probes

- `GET /health` is the cheap public liveness probe. It only confirms that the Node process can answer HTTP and should not be used to gate production traffic.
- `GET /health/ready` is the bounded public readiness probe used by `render.yaml`. It returns `200 { "status": "ready" }` only when MongoDB responds to a ping and S3 accepts a non-mutating bucket capability check; otherwise it returns HTTP 503 with only a generic unready status.
- The S3 readiness check uses `HeadBucket`, so the deployed AWS principal must have the non-mutating bucket permission required by that API in addition to the existing object permissions. No bucket name, credential, connection string, or dependency error detail is exposed by the public readiness response.

Production traffic/instance health checks should target `/health/ready`; monitoring that only needs process liveness may target `/health`.

Included e2e cases:
- success upload
- invalid file type
- file too large
- missing required field

## curl example

```bash
curl -X POST http://localhost:8080/uploads \
  -F "customerName=Somchai" \
  -F "phone=0812345678" \
  -F "jobType=Document Printing" \
  -F "note=Please print in color" \
  -F "files=@./sample.pdf" \
  -F "files=@./artwork.png"
```

## Security decisions

- `helmet` enabled globally.
- CORS restricted by `FRONTEND_ORIGIN` only.
- Global `ValidationPipe` with `whitelist + forbidNonWhitelisted`.
- Upload endpoint rate-limited with `@nestjs/throttler`.
- Multer memory storage with strict file count and a `7,500,000 byte` per-file cap.
- Validation checks both file extension and MIME type.
- Filename sanitized before S3 key generation.
- S3 uploads are private (no `public-read`) with server-side encryption:
  - `AES256` by default (SSE-S3)
  - auto-switch to KMS if `AWS_S3_KMS_KEY_ID` is provided.
- Stored S3 metadata is minimized (masked phone, jobType, customerName).
- No AWS secret/credential is ever returned to clients.

## Authentication

Backend authentication is implemented and is the authorization boundary for protected APIs.
The current contract includes `POST /auth/login`, `GET /auth/me`, and `POST /auth/logout`,
with backend-managed `staff`, `manager`, and `admin` roles. The Next.js frontend stores the
backend access token inside its signed HTTP-only admin session cookie and forwards it through
the same-origin BFF. Frontend menu visibility is UX only and must not replace backend role checks.

## S3 retention policy (PDPA)

Set lifecycle policy on `AWS_S3_BUCKET_PRIVATE` to auto-delete objects under prefix `uploads/` after your retention period (for example 30/60/90 days).

Example recommendation:
- Rule scope: `uploads/`
- Expiration: `90 days`
- Abort incomplete multipart uploads: `7 days`
