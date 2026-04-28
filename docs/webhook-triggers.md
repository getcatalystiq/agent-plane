# Webhook Triggers

External systems can trigger an AgentPlane agent run by POSTing a signed event to a stable, public URL. AgentPlane verifies the HMAC signature, deduplicates by delivery id, and dispatches the agent run asynchronously.

## Endpoint

```
POST https://<your-host>/api/webhooks/{source_id}
```

The `source_id` is a UUID returned when you create the webhook in the admin UI (Agent → **Webhooks** tab) or via the REST API. The id is not a secret — the secret is the HMAC key revealed at creation.

## Required headers

| Header | Description |
|---|---|
| `X-AgentPlane-Signature` | `sha256=<hex>` HMAC of `{timestamp}.{raw_body}` using the webhook secret. The header name is configurable per source. |
| `Webhook-Timestamp` | Unix epoch seconds when the request was signed. Must be within ±5 minutes of server time. |
| `Webhook-Delivery-Id` | Sender-chosen idempotency key. Re-POSTing with the same value returns the original response without creating a second run. |
| `Content-Type` | `application/json`. The body must be valid JSON. |

## Response codes

| Status | Meaning |
|---|---|
| `202 Accepted` | Webhook accepted; run is executing asynchronously. Poll `status_url` for progress. |
| `200 OK` | Duplicate `Webhook-Delivery-Id`. Body contains the original `run_id` (may be `null` if the original attempt failed). |
| `400 Bad Request` | Missing `Webhook-Delivery-Id` or invalid JSON body. |
| `401 Unauthorized` | Generic auth failure: unknown source, disabled source, bad signature, stale timestamp. The response is intentionally indistinguishable across these to prevent enumeration. |
| `413 Payload Too Large` | Body exceeds 512 KB. |
| `429 Too Many Requests` | Per-source (60/min) or per-tenant (600/min) rate limit hit. Honor `Retry-After`. |

## Computing the signature

```bash
TS=$(date +%s)
BODY='{"event":"pull_request.opened","number":42}'
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

curl -X POST https://your-host/api/webhooks/$SOURCE_ID \
  -H "X-AgentPlane-Signature: $SIG" \
  -H "Webhook-Timestamp: $TS" \
  -H "Webhook-Delivery-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

The signed string is `{timestamp}.{raw_body}` with a literal period separator. Sign the **raw** body bytes — not a re-serialized JSON value.

## Configuring the signature header

Per-source `signature_header` lets you point AgentPlane at the header your provider already uses:

| Provider | Header | Configuration |
|---|---|---|
| AgentPlane (default) | `X-AgentPlane-Signature` | (no change) |
| GitHub | `X-Hub-Signature-256` | Set `signature_header: "X-Hub-Signature-256"` |
| Stripe-style senders | `Stripe-Signature` | Set `signature_header: "Stripe-Signature"` (note Stripe uses a different signed-string format — match accordingly) |

The expected signature value is always `sha256=<hex>` regardless of the header name.

## Prompt template

Each source stores a `prompt_template` that is rendered into the agent's prompt when a webhook fires. Two placeholders are supported:

- `{{payload}}` — the raw request body, pretty-printed and (if it exceeds 256 KB) truncated with a `[payload truncated]` marker.
- `{{source.name}}` — the human-readable name you gave the webhook.

Example template:

```
A new event arrived from {{source.name}}:

{{payload}}

Investigate and take any necessary follow-up actions.
```

Per-event filtering (e.g. "only fire on `pull_request.opened`") is the agent's responsibility — the prompt template is responsible for any conditional handling once the run is alive.

## Secret rotation

Calling the rotate endpoint moves the current secret to `previous` (valid for 7 days), generates a new current secret, and reveals the new secret once. During the overlap window, signatures from either secret are accepted — letting you roll the secret in your sender without dropping events.

```
POST /api/webhooks/{source_id}/rotate
```

## Run linkage

Every run created through a webhook has:

- `runs.triggered_by = 'webhook'`
- `runs.webhook_source_id` set to the source id

Filter runs by `?source=webhook` in the admin UI to see them, or query directly. The webhook-triggered run badge is orange.
