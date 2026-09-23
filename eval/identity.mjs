// Evaluation-only JWT issuer. It creates an RSA key when it starts, publishes
// the public key as a JWKS, and signs a token for either evaluation
// application. Anyone who can reach it can obtain a token, so it listens on
// loopback only. Never point a production Tyr at it.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    return match ? [match[1], match[2]] : [arg, "true"];
  }),
);
const port = Number(args.get("port") ?? 9102);
const ISSUER = "tyr-eval";
const AUDIENCE = "tyr-eval";
const APPLICATIONS = new Map([
  ["interactive", "eval-interactive"],
  ["batch", "eval-batch"],
]);
const TOKEN_TTL_SECONDS = 3600;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const kid = createHash("sha256").update(publicJwk.n).digest("base64url").slice(0, 16);
const jwks = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(app) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT", kid });
  const payload = base64url({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: `${app}-client`,
    azp: APPLICATIONS.get(app),
    roles: ["tyr.invoke"],
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://identity");
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
  if (url.pathname === "/jwks") return sendJson(res, 200, jwks);
  if (url.pathname === "/token") {
    const app = url.searchParams.get("app") ?? "";
    if (!APPLICATIONS.has(app)) {
      return sendJson(res, 400, { error: "app must be interactive or batch" });
    }
    return sendJson(res, 200, {
      app,
      header: "x-tyr-identity-token",
      token: token(app),
      expiresInSeconds: TOKEN_TTL_SECONDS,
    });
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`evaluation identity issuer on 127.0.0.1:${port} issuer=${ISSUER}`);
});
