"""OpenAI SDK through Tyr. Start the stack first with `npm run eval:serve`.

    pip install -r eval/sdk/requirements.txt
    python3 eval/sdk/quickstart.py

Against OpenAI (after `npm run eval:serve -- --upstream=openai --model=<model>`),
also set OPENAI_API_KEY and TYR_EVAL_MODEL. Tyr forwards your key; it never stores it.
"""

import json
import os
import urllib.request

from openai import OpenAI

base_url = os.environ.get("TYR_BASE_URL", "http://127.0.0.1:8787/v1")
issuer = os.environ.get("TYR_EVAL_IDENTITY_URL", "http://127.0.0.1:9102")
model = os.environ.get("TYR_EVAL_MODEL", "gpt-mock")

# Tyr authenticates the caller with its own header, separate from the provider
# Authorization header. The token's application selects the admission class.
with urllib.request.urlopen(f"{issuer}/token?app=interactive") as reply:
    token = json.load(reply)["token"]

client = OpenAI(
    base_url=base_url,
    api_key=os.environ.get("OPENAI_API_KEY", "eval-mock-key"),
    default_headers={"x-tyr-identity-token": f"Bearer {token}"},
)

response = client.responses.create(
    model=model,
    input="In one sentence, what does an admission controller do?",
    max_output_tokens=64,
)
print(f"responses.create: {response.output_text}")

raw = client.chat.completions.with_raw_response.create(
    model=model,
    max_completion_tokens=64,
    messages=[{"role": "user", "content": "In one sentence, why protect interactive traffic?"}],
)
completion = raw.parse()
print(f"chat.completions.create: {completion.choices[0].message.content}")
print(
    f"Tyr admission: class={raw.headers.get('x-admission-class')} "
    f"outcome={raw.headers.get('x-admission-outcome')} "
    f"reservedTokens={raw.headers.get('x-admission-reserved-tokens')}"
)
