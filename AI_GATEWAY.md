# AI Gateway configuration

Cloudflare AI Gateway's core analytics, caching and rate-limiting features are free on all plans according to the [pricing documentation](https://developers.cloudflare.com/ai-gateway/reference/pricing/). Provider inference still has its own costs. Optional guardrails, logging/export products, and Unified Billing can add charges. This application does not enable them.

The first integration retains OpenRouter as the provider. It supports sending an owner-provided provider key through the gateway. Gateway-stored provider keys and per-user key management are not implemented.

## Runtime configuration

| Binding | Purpose |
| --- | --- |
| `AI_GATEWAY_ACCOUNT_ID` | Cloudflare account ID, exactly 32 hexadecimal characters |
| `AI_GATEWAY_ID` | Lowercase gateway ID, `pm-openrouter` |
| `CF_AIG_TOKEN` | Worker secret with AI Gateway Run permission |
| `OPENROUTER_API_KEY` | Worker secret for provider inference |
| `POLYMARKET_MODEL` | Optional OpenRouter model override; retains the existing model when absent |

Without both gateway bindings, requests use the existing direct OpenRouter route. Supplying only one binding, invalid identifiers, or a missing gateway token is an error. A configured gateway failure never falls back to a direct request. Provider credentials are still required.

The gateway route is `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openrouter/chat/completions`. It sends provider authorization separately from `cf-aig-authorization`. Every gateway request disables log collection, payload collection and caching. This does not disable separately configured Logpush exports; inspect gateway/account exports before use. Upstream response bodies are not copied into API errors.

Cloudflare's OpenRouter documentation is inconsistent: the SDK example uses `/openrouter/chat/completions`, while its cURL example includes `/openrouter/v1/chat/completions`. This integration follows the SDK route. No paid inference call has verified it in the target account.

## Provisioning

Gateway `pm-openrouter` was provisioned in Savage Apps on 2026-11-16. Its API configuration has authentication enabled, `byok_only: true`, `collect_logs: false`, Logpush off, no multi-provider routing, and a sliding rate limit configured with interval 60 and limit 10. The public schema does not explicitly document interval units. Requests also skip caching; no assumption depends on zero-TTL disabling semantics.

Gateway management uses a separate seven-day AI Gateway Write token, not the Access-management token. The Worker holds only an AI Gateway Run token in `CF_AIG_TOKEN`. That runtime token is account-scoped because Cloudflare does not support gateway-specific Run scope. Both tokens expire on 2026-11-23 and require rotation before then. They are stored privately outside the repository.

A no-provider-credential probe to the configured route returned HTTP 400, code 2044, requesting customer-provided provider credentials. This verifies gateway routing and authentication without an inference request. It does not validate model output or provider billing. No provider key is provisioned, and inference remains unavailable until the owner supplies one.

Store keys with Worker secrets, never in source, examples, tests, URLs, or client storage. BYOK-only configuration forbids Unified Billing fallback; upstream inference can still incur provider charges after a key is supplied.

## Later BYOK work

Gateway-stored BYOK requires provider support verification and a dedicated decision about key ownership, rotation, revocation and retention. Cloudflare documents omitting provider Authorization when using a stored key; an explicit Authorization header overrides that stored key. Do not mix both modes silently. The current integration intentionally accepts only the per-request provider-key mode.

## Sources

- [Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
- [OpenRouter provider](https://developers.cloudflare.com/ai-gateway/providers/openrouter/)
- [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Bring your own keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Gateway creation API](https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/)
