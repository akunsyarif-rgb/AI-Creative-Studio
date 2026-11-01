# Internal API Contract

This document describes the intended application API. Endpoints are not implemented merely because they are listed here.

## Jobs
- `POST /api/jobs` — validate and create a capability job.
- `GET /api/jobs/:id` — retrieve owner-authorized job state.
- `POST /api/jobs/:id/cancel` — request cancellation when supported.

## Providers
- `GET /api/providers` — list configured providers and connection status; never return credentials.
- `POST /api/providers/test` — validate a stored provider credential.
- `GET /api/models` — list verified models and capability manifests.

## Uploads and Library
- `POST /api/uploads/presign` — issue an authorized short-lived upload URL.
- `GET /api/library` — list owner-authorized assets.
- `DELETE /api/library/:id` — delete an asset and its storage object under an explicit owner action.

## Webhooks
- `POST /api/webhooks/:provider` — receive provider callbacks after signature and replay validation.

## Response conventions
Success:
```json
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "status": "queued"
  }
}
```

Error:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be validated."
  }
}
```

## Requirements
- Validate request and response data at runtime.
- Authenticate and authorize every private operation.
- Apply rate limits and file-size limits.
- Use idempotency keys for billable job submissions.
- Do not expose provider credentials or internal stack traces.
- Document actual implemented behavior separately from planned endpoints.
