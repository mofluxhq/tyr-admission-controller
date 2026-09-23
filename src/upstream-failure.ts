/**
 * Why an upstream call failed without a usable response.
 *
 * Node's fetch rejects every transport failure with the same
 * `TypeError: fetch failed`; the reason (`ECONNREFUSED`, `ECONNRESET`,
 * `UND_ERR_SOCKET`, ...) is only on its `cause` chain. `name` and `code` are
 * bounded and safe to return to callers. `detail`, `syscall` and `causeName`
 * can carry internal addresses and belong in operator logs only.
 */
export type UpstreamFailure = {
  /** Outermost error name, e.g. `TypeError`. */
  readonly name: string;
  /** Most specific error code on the cause chain, or `unknown`. */
  readonly code: string;
  /** Name of the error that carried `code`, e.g. `SocketError`. */
  readonly causeName?: string;
  readonly syscall?: string;
  /** Innermost message, bounded. Log-only: it may contain host:port. */
  readonly detail: string;
};

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,47}$/u;
const SYSCALL = /^[a-z_]{1,32}$/u;
const MAX_DEPTH = 4;
const MAX_DETAIL_CHARS = 300;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function boundedName(value: unknown): string | undefined {
  return typeof value === "string" && NAME.test(value) ? value : undefined;
}

export function describeUpstreamFailure(err: unknown): UpstreamFailure {
  let code: string | undefined;
  let causeName: string | undefined;
  let syscall: string | undefined;
  let detail = err instanceof Error ? err.message : String(err);
  let current: unknown = err;
  // The deepest code is the most specific: fetch failed -> SocketError
  // (UND_ERR_SOCKET) -> Error (ECONNRESET) names the transport event.
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth += 1) {
    const candidate = field(current, "code");
    if (typeof candidate === "string" && CODE.test(candidate)) {
      code = candidate;
      causeName = boundedName(field(current, "name"));
      const call = field(current, "syscall");
      syscall = typeof call === "string" && SYSCALL.test(call) ? call : undefined;
    }
    const message = field(current, "message");
    if (typeof message === "string" && message.length > 0) detail = message;
    current = field(current, "cause");
  }
  return {
    name: boundedName(field(err, "name")) ?? "Error",
    code: code ?? "unknown",
    ...(causeName === undefined ? {} : { causeName }),
    ...(syscall === undefined ? {} : { syscall }),
    detail: detail.slice(0, MAX_DETAIL_CHARS),
  };
}
