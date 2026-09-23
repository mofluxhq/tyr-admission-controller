// OpenAI SDK through Tyr. Start the stack first with `npm run eval:serve`.
//
//   npm --prefix eval/sdk install
//   node eval/sdk/quickstart.mjs
//
// Against OpenAI (after `npm run eval:serve -- --upstream=openai --model=<model>`),
// also set OPENAI_API_KEY and TYR_EVAL_MODEL. Tyr forwards your key; it never stores it.
import OpenAI from "openai";

const baseURL = process.env.TYR_BASE_URL ?? "http://127.0.0.1:8787/v1";
const issuer = process.env.TYR_EVAL_IDENTITY_URL ?? "http://127.0.0.1:9102";
const model = process.env.TYR_EVAL_MODEL ?? "gpt-mock";

// Tyr authenticates the caller with its own header, separate from the provider
// Authorization header. The token's application selects the admission class.
const { token } = await (await fetch(`${issuer}/token?app=interactive`)).json();

const client = new OpenAI({
  baseURL,
  apiKey: process.env.OPENAI_API_KEY ?? "eval-mock-key",
  defaultHeaders: { "x-tyr-identity-token": `Bearer ${token}` },
});

const response = await client.responses.create({
  model,
  input: "In one sentence, what does an admission controller do?",
  max_output_tokens: 64,
});
console.log(`responses.create: ${response.output_text}`);

const { data: completion, response: raw } = await client.chat.completions
  .create({
    model,
    max_completion_tokens: 64,
    messages: [{ role: "user", content: "In one sentence, why protect interactive traffic?" }],
  })
  .withResponse();
console.log(`chat.completions.create: ${completion.choices[0].message.content}`);
console.log(
  `Tyr admission: class=${raw.headers.get("x-admission-class")} ` +
    `outcome=${raw.headers.get("x-admission-outcome")} ` +
    `reservedTokens=${raw.headers.get("x-admission-reserved-tokens")}`,
);
