# AI Gateway configuration

Cloudflare AI Gateway's core analytics, caching and rate-limiting features are free on all plans according to the [pricing documentation](https://developers.cloudflare.com/ai-gateway/reference/pricing/). Provider inference still has its own costs. Optional guardrails, logging/export products, and Unified Billing can add charges. This application does not enable them.

The first integration retains OpenRouter as the provider. It supports sending an owner-provided provider key through the gateway. Gateway-stored provider keys and per-user key management are not implemented.

## Runtime configuration

| Binding | Purpose |
| --- | --- |
| `AI_GATEWAY_ACCOUNT_ID` | Cloudflare account ID, exactly 32 hexadecimal characters |
| `AI_GATEWAY_ID` | Lowercase gateway ID, proposed `pm-openrouter` |
| `CF_AIG_TOKEN` | Worker secret with AI Gateway Run permission |
| `OPENROUTER_API_KEY` | Worker secret for provider inference |
| `POLYMARKET_MODEL` | Optional OpenRouter model override; retains the existing model when absent |

Without both gateway bindings, requests use the existing direct OpenRouter route. Supplying only one binding, invalid identifiers, or a missing gateway token is an error. A configured gateway failure never falls back to a direct request. Provider credentials are still required.

The gateway route is `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openrouter/chat/completions`. It sends provider authorization separately from `cf-aig-authorization`. Every gateway request disables log collection, payload collection and caching. This does not disable separately configured Logpush exports; inspect gateway/account exports before use. Upstream response bodies are not copied into API errors.

Cloudflare's OpenRouter documentation is inconsistent: the SDK example uses `/openrouter/chat/completions`, while its cURL example includes `/openrouter/v1/chat/completions`. This integration follows the SDK route. No paid inference call has verified it in the target account.

## Provisioning

Create an authenticated gateway with `collect_logs: false` and no paid add-ons. Use a project-prefixed name. Gateway management needs AI Gateway Write; runtime authentication needs AI Gateway Run. The existing Wrangler OAuth credential cannot list gateways in Savage Apps: the API returned authentication error 10000. The Access-management token is intentionally not reused for gateway privileges.

Do not enable the runtime gateway bindings until the gateway and its run token exist. Store keys with Worker secrets, never in source, examples, tests, URLs, or client storage. No provider key is provisioned by this change and no inference spending is authorized by merely enabling routing.

## Later BYOK work

Gateway-stored BYOK requires provider support verification and a dedicated decision about key ownership, rotation, revocation and retention. Cloudflare documents omitting provider Authorization when using a stored key; an explicit Authorization header overrides that stored key. Do not mix both modes silently. The current integration intentionally accepts only the per-request provider-key mode.

## Sources

- [Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
- [OpenRouter provider](https://developers.cloudflare.com/ai-gateway/providers/openrouter/)
- [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Bring your own keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Gateway creation API](https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/)
