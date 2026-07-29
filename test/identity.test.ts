import {
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJwtIdentityAuthenticator,
  TyrIdentityError,
} from "../src/identity.js";

const servers: Server[] = [];

afterEach(async () => {
  const closing = servers.splice(0).map(
    (server) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  await Promise.all(closing);
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jwt(
  privateKey: KeyObject,
  kid: string,
  claims: Readonly<Record<string, unknown>>,
): string {
  const header = encode({ alg: "RS256", kid, typ: "JWT" });
  const payload = encode(claims);
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function requestWithToken(token?: string): IncomingMessage {
  return {
    headers:
      token === undefined
        ? {}
        : { "x-tyr-identity-token": `Bearer ${token}` },
  } as IncomingMessage;
}

async function startJwks(
  keys: readonly JsonWebKey[],
): Promise<{
  url: string;
  setKeys: (next: readonly JsonWebKey[]) => void;
  setAvailable: (available: boolean) => void;
}> {
  let current = keys;
  let available = true;
  const server = createServer((_req, res) => {
    if (!available) {
      res.writeHead(503, { "content-length": "0" });
      res.end();
      return;
    }
    const body = JSON.stringify({ keys: current });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks`,
    setKeys: (next) => {
      current = next;
    },
    setAvailable: (next) => {
      available = next;
    },
  };
}

function keyPair(kid: string): {
  privateKey: KeyObject;
  jwk: JsonWebKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" },
  };
}

describe("JWT request identity", () => {
  it("verifies the JWT and maps immutable identity claims", async () => {
    const pair = keyPair("primary");
    const jwks = await startJwks([pair.jwk]);
    const authenticate = createJwtIdentityAuthenticator({
      jwksUrl: jwks.url,
      issuer: "https://issuer.example/",
      audience: "tyr",
    });
    const now = Math.floor(Date.now() / 1_000);
    const identity = await authenticate(
      requestWithToken(
        jwt(pair.privateKey, "primary", {
          iss: "https://issuer.example/",
          aud: ["other", "tyr"],
          sub: "user-123",
          tenant_id: "tenant-a",
          azp: "app-web",
          roles: ["tyr.invoke", "tyr.priority.high", "tyr.invoke"],
          iat: now,
          exp: now + 60,
        }),
      ),
    );

    expect(identity).toEqual({
      subject: "user-123",
      tenantId: "tenant-a",
      applicationId: "app-web",
      roles: ["tyr.invoke", "tyr.priority.high"],
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.roles)).toBe(true);
  });

  it("requires a bearer token and rejects expired or wrongly scoped JWTs", async () => {
    const pair = keyPair("primary");
    const jwks = await startJwks([pair.jwk]);
    const authenticate = createJwtIdentityAuthenticator({
      jwksUrl: jwks.url,
      issuer: "https://issuer.example/",
      audience: "tyr",
      clockSkewSeconds: 0,
    });
    await expect(authenticate(requestWithToken())).rejects.toMatchObject({
      code: "identity_required",
      status: 401,
    });

    const now = Math.floor(Date.now() / 1_000);
    for (const claims of [
      {
        iss: "https://issuer.example/",
        aud: "wrong",
        sub: "user",
        exp: now + 60,
      },
      {
        iss: "https://issuer.example/",
        aud: "tyr",
        sub: "user",
        exp: now - 1,
      },
    ]) {
      await expect(
        authenticate(requestWithToken(jwt(pair.privateKey, "primary", claims))),
      ).rejects.toBeInstanceOf(TyrIdentityError);
    }
  });

  it("distinguishes verifier unavailability from invalid credentials", async () => {
    const pair = keyPair("primary");
    const jwks = await startJwks([pair.jwk]);
    const authenticate = createJwtIdentityAuthenticator({
      jwksUrl: jwks.url,
      issuer: "issuer",
      audience: "tyr",
      cacheTtlMs: 60_000,
    });
    const now = Math.floor(Date.now() / 1_000);
    const token = jwt(pair.privateKey, "primary", {
      iss: "issuer",
      aud: "tyr",
      sub: "user",
      exp: now + 60,
    });

    jwks.setAvailable(false);
    await expect(authenticate(requestWithToken(token))).rejects.toMatchObject({
      code: "identity_unavailable",
      status: 503,
    });

    jwks.setAvailable(true);
    await expect(authenticate(requestWithToken(token))).resolves.toMatchObject({
      subject: "user",
    });

    jwks.setAvailable(false);
    await expect(authenticate(requestWithToken(token))).resolves.toMatchObject({
      subject: "user",
    });
  });

  it("returns verifier unavailable when an unknown kid cannot be refreshed", async () => {
    const first = keyPair("first");
    const second = keyPair("second");
    const jwks = await startJwks([first.jwk]);
    const authenticate = createJwtIdentityAuthenticator({
      jwksUrl: jwks.url,
      issuer: "issuer",
      audience: "tyr",
      cacheTtlMs: 60_000,
    });
    const now = Math.floor(Date.now() / 1_000);
    await authenticate(
      requestWithToken(
        jwt(first.privateKey, "first", {
          iss: "issuer",
          aud: "tyr",
          sub: "one",
          exp: now + 60,
        }),
      ),
    );

    jwks.setAvailable(false);
    await expect(
      authenticate(
        requestWithToken(
          jwt(second.privateKey, "second", {
            iss: "issuer",
            aud: "tyr",
            sub: "two",
            exp: now + 60,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "identity_unavailable",
      status: 503,
    });
  });

  it("refreshes a fresh JWKS cache once when a rotated kid appears", async () => {
    const first = keyPair("first");
    const second = keyPair("second");
    const jwks = await startJwks([first.jwk]);
    const authenticate = createJwtIdentityAuthenticator({
      jwksUrl: jwks.url,
      issuer: "issuer",
      audience: "tyr",
      cacheTtlMs: 60_000,
    });
    const now = Math.floor(Date.now() / 1_000);
    await authenticate(
      requestWithToken(
        jwt(first.privateKey, "first", {
          iss: "issuer",
          aud: "tyr",
          sub: "one",
          exp: now + 60,
        }),
      ),
    );

    jwks.setKeys([second.jwk]);
    const rotated = await authenticate(
      requestWithToken(
        jwt(second.privateKey, "second", {
          iss: "issuer",
          aud: "tyr",
          sub: "two",
          exp: now + 60,
        }),
      ),
    );
    expect(rotated.subject).toBe("two");
  });
});
