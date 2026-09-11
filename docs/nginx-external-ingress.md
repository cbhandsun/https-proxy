# Nginx external ingress

The proxy exposes a credential-free readiness endpoint at:

```text
/v1/.well-known/hpm-health
```

It returns only the application marker, readiness state, and entry protocol. It never returns
credentials, configured upstreams, model routes, process IDs, or user content.

The following template forwards an OpenAI Chat-compatible public endpoint to the local HTTPS entry
on port `3447`. Keep the API entry protected with `entryAuth`; only the readiness endpoint is public.

```nginx
upstream https_proxy_manager_openai_chat {
    server 127.0.0.1:3447;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    # Configure your public certificate here.
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location /v1/ {
        proxy_pass https://https_proxy_manager_openai_chat;
        proxy_http_version 1.1;
        proxy_set_header Host localhost;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Request-Id $request_id;

        proxy_ssl_server_name on;
        proxy_ssl_name localhost;

        # Prefer trusting the generated local CA with proxy_ssl_trusted_certificate.
        # Use this only when nginx and the proxy share a trusted host boundary.
        proxy_ssl_verify off;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_intercept_errors off;
    }
}
```

Validate and reload atomically so a failed configuration never replaces the active route:

```bash
nginx -t && nginx -s reload
```

Image generation compatibility and asynchronous jobs:

- OpenAI-compatible clients such as Cherry Studio call `POST /v1/images/generations` and wait for
  one JSON response. Keep `proxy_read_timeout` at 300 seconds or higher for that endpoint.
- Native clients can avoid a long-lived ingress connection by calling `POST /v1/image-jobs` with
  the same request body. The proxy returns `202 Accepted`, a high-entropy job ID, and a
  `status_url` immediately.
- Poll `GET /v1/image-jobs/{id}` until the status is `completed`, `failed`, or `cancelled`.
  `DELETE /v1/image-jobs/{id}` cancels queued or running work.
- Job access is scoped to the entry API key that created it. Jobs are kept in a bounded in-memory
  queue and expire one hour after reaching a terminal state. A proxy restart discards jobs, so
  clients must treat `404` after a restart as terminal and submit a new task.

Example:

```bash
curl -X POST https://api.example.com/v1/image-jobs \
  -H 'Authorization: Bearer YOUR_ENTRY_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-3.1-flash-image","prompt":"Draw a red circle","response_format":"b64_json"}'
```

The queue can be bounded further with `PROXY_IMAGE_JOB_MAX_JOBS`,
`PROXY_IMAGE_JOB_MAX_QUEUED`, `PROXY_IMAGE_JOB_MAX_CONCURRENCY`, and
`PROXY_IMAGE_JOB_TTL_MS`. Invalid values fail back to safe defaults.

After deployment, enter the public base URL (for example, `https://api.example.com/v1`) in
**Logs & Diagnostics → External ingress probe**. The probe sends no API key or conversation body.
It distinguishes these cases:

- `proxy_reached`: nginx and the tunnel reached HTTPS Proxy Manager.
- `legacy_proxy_reached`: the proxy was reached, but the running build predates the readiness marker.
- `ingress_route_missing`: nginx returned its own plain-text 404.
- `ingress_upstream_unavailable`: nginx returned 502, 503, or 504.
- `timeout`, `dns_error`, or `tls_error`: failure occurred before the proxy could respond.
