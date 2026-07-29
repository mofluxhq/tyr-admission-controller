import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type TyrRequestIdentity = Readonly<{
  subject: string;
  tenantId?: string;
  applicationId?: string;
  roles: readonly string[];
}>;

export type TyrIdentityAuthenticator = ((
  req: IncomingMessage,
) => TyrRequestIdentity | Promise<TyrRequestIdentity>) &
  Readonly<{ credentialHeader?: string }>;

export type TyrIdentityOptions = Readonly<{
  authenticate: TyrIdentityAuthenticator;
  /** Header carrying identity credentials; Tyr strips it before upstream forwarding. */
  credentialHeader?: string;
  /** Any authenticated identity may invoke when omitted or empty. */
  invokeRoles?: readonly string[];
  /** Any matching role may read /stats and /metrics. */
  operatorRoles?: readonly string[];
  /** Any matching role receives high-priority admission. */
  highPriorityRoles?: readonly string[];
}>;

export type TyrIdentityFailureCode =
  | "identity_required"
  | "identity_invalid"
  | "identity_forbidden";

export class TyrIdentityError extends Error {
  constructor(
    public readonly code: TyrIdentityFailureCode,
    message: string,
    public readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "TyrIdentityError";
  }
}

export type JwtIdentityClaims = Readonly<{
  subject?: string;
  tenantId?: string;
  applicationId?: string;
  roles?: string;
}>;

export type JwtIdentityAuthenticatorOptions = Readonly<{
  jwksUrl: string;
  issuer: string;
  audience: string | readonly string[];
  /** Header containing `Bearer <JWT>`. Default: x-tyr-identity-token. */
  header?: string;
  /** Permitted asymmetric algorithms. Default: [RS256]. */
  algorithms?: readonly JwtRsaAlgorithm[];
  /** JWKS cache lifetime. Default: 300000. */
  cacheTtlMs?: number;
  /** JWKS request deadline. Default: 5000. */
  requestTimeoutMs?: number;
  /** Allowed clock skew for exp/nbf/iat. Default: 30. */
  clockSkewSeconds?: number;
  /** Require an exp claim. Default: true. */
  requireExpiration?: boolean;
  claims?: JwtIdentityClaims;
}>;

export type JwtRsaAlgorithm = "RS256" | "RS384" | "RS512";

type JwtHeader = {
  readonly alg: JwtRsaAlgorithm;
  readonly kid: string;
};

type JwtPayload = Readonly<Record<string, unknown>>;

type CachedJwk = {
  readonly kid: string;
  readonly alg?: string;
  readonly key: KeyObject;
};

export const DEFAULT_TYR_IDENTITY_HEADER = "x-tyr-identity-token";
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 1_048_576;
const MAX_JWKS_KEYS = 128;
const MAX_ROLES = 128;
const SUPPORTED_ALGORITHMS = new Set<JwtRsaAlgorithm>([
  "RS256",
  "RS384",
  "RS512",
]);

function invalid(message: string): TyrIdentityError {
  return new TyrIdentityError("identity_invalid", message, 401);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertSafeInteger(
  value: number | undefined,
  field: string,
  minimum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${field} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function normalizeHeaderName(value: string | undefined): string {
  const header = (value ?? DEFAULT_TYR_IDENTITY_HEADER).trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header)) {
    throw new Error("identity JWT header must be a valid HTTP header name");
  }
  return header;
}

function normalizeAlgorithms(
  value: readonly JwtRsaAlgorithm[] | undefined,
): readonly JwtRsaAlgorithm[] {
  const algorithms = value ?? ["RS256"];
  if (algorithms.length === 0) {
    throw new Error("identity JWT algorithms must not be empty");
  }
  const unique = new Set<JwtRsaAlgorithm>();
  for (const algorithm of algorithms) {
    if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
      throw new Error(`unsupported identity JWT algorithm: ${String(algorithm)}`);
    }
    unique.add(algorithm);
  }
  return Object.freeze([...unique]);
}

function normalizeAudience(value: string | readonly string[]): readonly string[] {
  const audience = Array.isArray(value) ? value : [value];
  if (audience.length === 0) {
    throw new Error("identity JWT audience must not be empty");
  }
  return Object.freeze(
    audience.map((entry, index) =>
      assertNonEmptyString(entry, `identity JWT audience[${index}]`),
    ),
  );
}

function base64UrlDecode(segment: string, field: string): Buffer {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw invalid(`JWT ${field} is not valid base64url`);
  }
  try {
    return Buffer.from(segment, "base64url");
  } catch {
    throw invalid(`JWT ${field} is not valid base64url`);
  }
}

function parseJsonObject(segment: string, field: string): Record<string, unknown> {
  const decoded = base64UrlDecode(segment, field);
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalid(`JWT ${field} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`JWT ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseHeader(segment: string, allowed: ReadonlySet<JwtRsaAlgorithm>): JwtHeader {
  const value = parseJsonObject(segment, "header");
  const alg = value["alg"];
  if (typeof alg !== "string" || !SUPPORTED_ALGORITHMS.has(alg as JwtRsaAlgorithm)) {
    throw invalid("JWT alg is unsupported");
  }
  if (!allowed.has(alg as JwtRsaAlgorithm)) {
    throw invalid("JWT alg is not allowed");
  }
  const kid = value["kid"];
  if (typeof kid !== "string" || kid.trim().length === 0) {
    throw invalid("JWT kid is required");
  }
  return { alg: alg as JwtRsaAlgorithm, kid: kid.trim() };
}

function extractBearerToken(req: IncomingMessage, headerName: string): string {
  const value = req.headers[headerName];
  if (value === undefined) {
    throw new TyrIdentityError(
      "identity_required",
      `missing ${headerName} identity header`,
      401,
    );
  }
  if (typeof value !== "string") {
    throw invalid(`${headerName} identity header must have one value`);
  }
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(value.trim());
  if (match?.[1] === undefined) {
    throw invalid(`${headerName} identity header must use Bearer authentication`);
  }
  if (Buffer.byteLength(match[1], "utf8") > MAX_TOKEN_BYTES) {
    throw invalid("JWT exceeds the maximum token size");
  }
  return match[1];
}

function signatureAlgorithm(algorithm: JwtRsaAlgorithm): string {
  switch (algorithm) {
    case "RS256":
      return "RSA-SHA256";
    case "RS384":
      return "RSA-SHA384";
    case "RS512":
      return "RSA-SHA512";
  }
}

function numericDate(payload: JwtPayload, claim: string): number | undefined {
  const value = payload[claim];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`JWT ${claim} must be a numeric date`);
  }
  return value;
}

function validateRegisteredClaims(
  payload: JwtPayload,
  issuer: string,
  audience: readonly string[],
  clockSkewSeconds: number,
  requireExpiration: boolean,
): void {
  if (payload["iss"] !== issuer) {
    throw invalid("JWT issuer does not match");
  }

  const aud = payload["aud"];
  const suppliedAudiences =
    typeof aud === "string"
      ? [aud]
      : Array.isArray(aud) && aud.every((entry) => typeof entry === "string")
        ? aud
        : [];
  if (!audience.some((expected) => suppliedAudiences.includes(expected))) {
    throw invalid("JWT audience does not match");
  }

  const now = Date.now() / 1_000;
  const exp = numericDate(payload, "exp");
  if (requireExpiration && exp === undefined) {
    throw invalid("JWT exp is required");
  }
  if (exp !== undefined && now - clockSkewSeconds >= exp) {
    throw invalid("JWT has expired");
  }
  const nbf = numericDate(payload, "nbf");
  if (nbf !== undefined && now + clockSkewSeconds < nbf) {
    throw invalid("JWT is not active yet");
  }
  const iat = numericDate(payload, "iat");
  if (iat !== undefined && now + clockSkewSeconds < iat) {
    throw invalid("JWT was issued in the future");
  }
}

function claimString(
  payload: JwtPayload,
  claimName: string | undefined,
  required: boolean,
): string | undefined {
  if (claimName === undefined) return undefined;
  const value = payload[claimName];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`JWT ${claimName} claim must be a non-empty string`);
  }
  if (value.length > 1_024) {
    throw invalid(`JWT ${claimName} claim is too long`);
  }
  return value.trim();
}

function claimRoles(payload: JwtPayload, claimName: string): readonly string[] {
  const value = payload[claimName];
  if (value === undefined) return Object.freeze([]);
  const roles =
    typeof value === "string"
      ? value.split(/\s+/).filter(Boolean)
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value
        : undefined;
  if (roles === undefined) {
    throw invalid(`JWT ${claimName} claim must be a string or string array`);
  }
  const normalized = [...new Set(roles.map((role) => role.trim()).filter(Boolean))];
  if (normalized.length > MAX_ROLES) {
    throw invalid(`JWT ${claimName} claim contains too many roles`);
  }
  if (normalized.some((role) => role.length > 256)) {
    throw invalid(`JWT ${claimName} claim contains an oversized role`);
  }
  return Object.freeze(normalized);
}

function buildIdentity(
  payload: JwtPayload,
  claims: Required<JwtIdentityClaims>,
): TyrRequestIdentity {
  const subject = claimString(payload, claims.subject, true);
  if (subject === undefined) throw invalid("JWT subject is required");
  const tenantId = claimString(payload, claims.tenantId, false);
  const applicationId = claimString(payload, claims.applicationId, false);
  const roles = claimRoles(payload, claims.roles);
  return Object.freeze({
    subject,
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(applicationId === undefined ? {} : { applicationId }),
    roles,
  });
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw invalid("JWKS response is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

class JwksCache {
  readonly #url: string;
  readonly #cacheTtlMs: number;
  readonly #requestTimeoutMs: number;
  #expiresAt = 0;
  #keys: readonly CachedJwk[] = [];
  #refreshing: Promise<readonly CachedJwk[]> | undefined;

  constructor(url: string, cacheTtlMs: number, requestTimeoutMs: number) {
    this.#url = url;
    this.#cacheTtlMs = cacheTtlMs;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async find(kid: string, alg: JwtRsaAlgorithm): Promise<KeyObject> {
    const hadFreshCache = Date.now() < this.#expiresAt;
    let keys = hadFreshCache ? this.#keys : await this.#refresh();
    let matches = keys.filter(
      (entry) => entry.kid === kid && (entry.alg === undefined || entry.alg === alg),
    );
    if (matches.length === 0 && hadFreshCache) {
      keys = await this.#refresh();
      matches = keys.filter(
        (entry) => entry.kid === kid && (entry.alg === undefined || entry.alg === alg),
      );
    }
    if (matches.length !== 1) {
      throw invalid(matches.length === 0 ? "JWT signing key was not found" : "JWT signing key is ambiguous");
    }
    return matches[0]!.key;
  }

  async #refresh(): Promise<readonly CachedJwk[]> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    this.#refreshing = this.#load().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #load(): Promise<readonly CachedJwk[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(this.#url, { signal: controller.signal });
    } catch (error) {
      throw invalid(
        `JWKS request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw invalid(`JWKS request returned HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_JWKS_BYTES) {
      throw invalid("JWKS response is too large");
    }
    const bytes = await readBoundedResponseBody(response, MAX_JWKS_BYTES);

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw invalid("JWKS response is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw invalid("JWKS response must be an object");
    }
    const rawKeys = (parsed as Record<string, unknown>)["keys"];
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
      throw invalid("JWKS keys must be a non-empty array");
    }
    if (rawKeys.length > MAX_JWKS_KEYS) throw invalid("JWKS contains too many keys");

    const keys: CachedJwk[] = [];
    for (const raw of rawKeys) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const jwk = raw as Record<string, unknown>;
      if (jwk["kty"] !== "RSA") continue;
      if (jwk["use"] !== undefined && jwk["use"] !== "sig") continue;
      const keyOps = jwk["key_ops"];
      if (
        keyOps !== undefined &&
        (!Array.isArray(keyOps) || !keyOps.includes("verify"))
      ) {
        continue;
      }
      const kid = jwk["kid"];
      if (typeof kid !== "string" || kid.trim().length === 0) continue;
      const alg = typeof jwk["alg"] === "string" ? jwk["alg"] : undefined;
      try {
        const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
        keys.push({ kid: kid.trim(), ...(alg === undefined ? {} : { alg }), key });
      } catch {
        // Ignore malformed or unsupported keys; a missing usable kid is an auth failure.
      }
    }
    if (keys.length === 0) throw invalid("JWKS contains no usable RSA signing keys");
    this.#keys = Object.freeze(keys);
    this.#expiresAt = Date.now() + this.#cacheTtlMs;
    return this.#keys;
  }
}


export function normalizeRequestIdentity(value: unknown): TyrRequestIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("identity authenticator returned a non-object identity");
  }
  const record = value as Record<string, unknown>;
  const subject = record["subject"];
  if (
    typeof subject !== "string" ||
    subject.trim().length === 0 ||
    subject.length > 1_024
  ) {
    throw invalid("identity subject must be a non-empty bounded string");
  }
  const tenantId = record["tenantId"];
  if (
    tenantId !== undefined &&
    (typeof tenantId !== "string" ||
      tenantId.trim().length === 0 ||
      tenantId.length > 1_024)
  ) {
    throw invalid("identity tenantId must be a non-empty bounded string when provided");
  }
  const applicationId = record["applicationId"];
  if (
    applicationId !== undefined &&
    (typeof applicationId !== "string" ||
      applicationId.trim().length === 0 ||
      applicationId.length > 1_024)
  ) {
    throw invalid("identity applicationId must be a non-empty bounded string when provided");
  }
  const rawRoles = record["roles"];
  if (!Array.isArray(rawRoles) || !rawRoles.every((role) => typeof role === "string")) {
    throw invalid("identity roles must be a string array");
  }
  const roles = [...new Set(rawRoles.map((role) => role.trim()).filter(Boolean))];
  if (roles.length > MAX_ROLES || roles.some((role) => role.length > 256)) {
    throw invalid("identity roles are invalid");
  }
  return Object.freeze({
    subject: subject.trim(),
    ...(tenantId === undefined ? {} : { tenantId: tenantId.trim() }),
    ...(applicationId === undefined
      ? {}
      : { applicationId: applicationId.trim() }),
    roles: Object.freeze(roles),
  });
}

export function hasAnyRole(
  identity: TyrRequestIdentity,
  roles: readonly string[] | undefined,
): boolean {
  if (roles === undefined || roles.length === 0) return false;
  const assigned = new Set(identity.roles);
  return roles.some((role) => assigned.has(role));
}

export function requireAnyRole(
  identity: TyrRequestIdentity,
  roles: readonly string[] | undefined,
): void {
  if (roles === undefined || roles.length === 0) return;
  if (!hasAnyRole(identity, roles)) {
    throw new TyrIdentityError(
      "identity_forbidden",
      "authenticated identity is not authorized",
      403,
    );
  }
}

export function createJwtIdentityAuthenticator(
  options: JwtIdentityAuthenticatorOptions,
): TyrIdentityAuthenticator {
  const jwksUrl = new URL(assertNonEmptyString(options.jwksUrl, "identity JWT jwksUrl"));
  if (jwksUrl.protocol !== "http:" && jwksUrl.protocol !== "https:") {
    throw new Error("identity JWT jwksUrl must use http: or https:");
  }
  const issuer = assertNonEmptyString(options.issuer, "identity JWT issuer");
  const audience = normalizeAudience(options.audience);
  const headerName = normalizeHeaderName(options.header);
  const algorithms = normalizeAlgorithms(options.algorithms);
  const allowedAlgorithms = new Set(algorithms);
  const cacheTtlMs = assertSafeInteger(
    options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    "identity JWT cacheTtlMs",
    0,
  )!;
  const requestTimeoutMs = assertSafeInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "identity JWT requestTimeoutMs",
    1,
  )!;
  const clockSkewSeconds = assertSafeInteger(
    options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
    "identity JWT clockSkewSeconds",
    0,
  )!;
  const requireExpiration = options.requireExpiration ?? true;
  if (typeof requireExpiration !== "boolean") {
    throw new Error("identity JWT requireExpiration must be a boolean");
  }
  const claims: Required<JwtIdentityClaims> = {
    subject: options.claims?.subject ?? "sub",
    tenantId: options.claims?.tenantId ?? "tenant_id",
    applicationId: options.claims?.applicationId ?? "azp",
    roles: options.claims?.roles ?? "roles",
  };
  for (const [name, value] of Object.entries(claims)) {
    assertNonEmptyString(value, `identity JWT claims.${name}`);
  }
  const cache = new JwksCache(jwksUrl.toString(), cacheTtlMs, requestTimeoutMs);

  const authenticate: TyrIdentityAuthenticator = async (req) => {
    const token = extractBearerToken(req, headerName);
    const segments = token.split(".");
    if (segments.length !== 3) throw invalid("JWT must have three segments");
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw invalid("JWT must have three segments");
    }
    const header = parseHeader(encodedHeader, allowedAlgorithms);
    const payload = parseJsonObject(encodedPayload, "payload");
    const signature = base64UrlDecode(encodedSignature, "signature");
    const key = await cache.find(header.kid, header.alg);
    const valid = verify(
      signatureAlgorithm(header.alg),
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      key,
      signature,
    );
    if (!valid) throw invalid("JWT signature is invalid");
    validateRegisteredClaims(
      payload,
      issuer,
      audience,
      clockSkewSeconds,
      requireExpiration,
    );
    return normalizeRequestIdentity(buildIdentity(payload, claims));
  };
  Object.defineProperty(authenticate, "credentialHeader", {
    value: headerName,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return authenticate;
}
