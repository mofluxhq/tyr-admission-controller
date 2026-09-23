# Evaluating Tyr

A checklist for deciding whether Tyr fits your traffic. Steps 1–3 need only
Node.js 20 or newer. None of it needs Kubernetes or Latchflo.

## 1. See it protect interactive traffic (5 minutes, no API key)

```bash
npm ci
npm run eval
```

The evaluation starts three local processes: a mock OpenAI provider that serves
8 requests at a time and answers 429 beyond that, a local token issuer, and Tyr
with [`eval/tyr.eval.yaml`](eval/tyr.eval.yaml). It then sends the same workload
twice, straight to the provider and through Tyr: 3 interactive callers and a
flood of 24 batch callers.

- [ ] Interactive requests complete far more often through Tyr than directly.
- [ ] The provider rejects nothing behind Tyr, and Tyr rejects only batch work.
- [ ] You can see the cost: batch completes fewer requests, because slots
      reserved for interactive traffic sometimes sit idle.

## 2. Call Tyr from the OpenAI SDK

```bash
npm run eval:serve
```

In another terminal, run either quickstart. Each calls `responses.create` and
Chat Completions through Tyr and prints the admission class Tyr selected.

```bash
npm --prefix eval/sdk install && node eval/sdk/quickstart.mjs
pip install -r eval/sdk/requirements.txt && python3 eval/sdk/quickstart.py
```

- [ ] Your client needs only a new base URL (`http://127.0.0.1:8787/v1`) and an
      `x-tyr-identity-token` header. It keeps sending its own provider key.
- [ ] `curl -s http://127.0.0.1:8787/metrics | grep openai-eval` shows admissions
      and rejections per class.

## 3. Optional: the same workload against OpenAI (billed)

```bash
OPENAI_API_KEY=... npm run eval -- --upstream=openai --model=<model> --confirm-live
```

At most 40 requests reach OpenAI, each limited to 16 output tokens, and the run
stops at the first error that is not a capacity 429. `server.maxOutputTokens`
in the evaluation config rejects any request that asks for more than 256 output
tokens before it reaches the provider. OpenAI's own capacity is large, so here
Tyr's configured pool is the constraint: interactive traffic stays admitted while
batch is held to its ceiling.

## 4. Measure your own traffic before enforcing anything

1. Write a configuration for your models: one pool per shared capacity, sized to
   what you actually have (concurrency and in-flight tokens), with admission
   classes for the workloads that compete. Validate it:
   `node dist/cli.js validate --config ./tyr.yaml`.
2. Set `admissionMode: observe`. Tyr makes every decision but forwards requests
   it would have rejected.
3. Point one service's base URL at Tyr.
4. Watch what enforcement would have done: `/stats`,
   `tyr_pool_observe_bypassed_total`, and `tyr_pool_advisory_would_reject_total`.
5. Switch to `enforce` on a canary only if those trade-offs are acceptable.

## 5. Deployment and readiness

- [ ] Pin a released version or image digest, never a mutable tag.
- [ ] Use `/healthz` for liveness and `/readyz` for readiness. Without Latchflo,
      `/readyz` is ready as soon as Tyr is listening. In managed mode it returns
      503 until every managed pool has a valid grant.
- [ ] Provider credentials stay with the calling application. Tyr forwards them
      and never stores them.
- [ ] Caller identity comes from your identity provider's JWKS, in Tyr's own
      header. The evaluation token issuer is for local evaluation only.
- [ ] Set `server.maxRequestBodyBytes`, `server.maxOutputTokens`, and timeouts for
      your workloads, and scrape `/metrics`.
- [ ] Budgets and statistics are per Tyr process. One replica is fine to start.

## When you would add Latchflo

Several Tyr replicas each enforce their own local limits, so one shared
provider capacity has to be split between them by hand. Latchflo, a separately
licensed control plane, divides one capacity envelope across the fleet, lends
idle protected capacity to other workloads, and takes it back when demand
returns, without sitting in the request path. Contact mofluxhq@gmail.com to
evaluate it.
