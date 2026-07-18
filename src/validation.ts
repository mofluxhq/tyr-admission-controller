/**
 * Shared, provider-agnostic request-shape validation primitives.
 *
 * These are intentionally conservative: they validate *shape* (types,
 * bounds, required fields), not business semantics. Provider adapters
 * compose these into their own `validate()` to decide which fields are
 * required/optional for their wire format.
 */

/** True for a non-null, non-array object (i.e. a JSON "object" value). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for a non-empty string. */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * A multimodal content block: a plain object with a non-empty string
 * `type`. `{ type: "text" }` blocks additionally require a string `text`
 * field; other block types (image, tool_use, tool_result, document, etc.)
 * are accepted as opaque as long as `type` is present — the gateway does
 * not need to understand every provider-specific block shape to know it's
 * *structurally* valid.
 */
export function isContentBlock(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v["type"])) return false;
  if (v["type"] === "text" && typeof v["text"] !== "string") return false;
  return true;
}

export type ContentOptions = {
  /** Allow `content` to be `null` (e.g. OpenAI assistant tool-call messages). */
  allowNull?: boolean;
};

/**
 * Validates a message's `content` field: a non-empty string, or an array
 * of valid content blocks (may be empty), or — when `allowNull` is set —
 * `null`.
 */
export function isValidContent(v: unknown, opts: ContentOptions = {}): boolean {
  if (opts.allowNull && v === null) return true;
  if (typeof v === "string") return true;
  if (Array.isArray(v)) return v.every(isContentBlock);
  return false;
}

export type MessageValidationOptions = {
  /** Roles permitted for this provider's message array. */
  allowedRoles: readonly string[];
  /** Roles for which `content: null` is accepted (e.g. tool-call turns). */
  nullableContentRoles?: readonly string[];
};

/**
 * Validates an array of messages, returning a list of human-readable
 * error strings (empty when valid). Checks:
 *  - `messages` is a non-empty array.
 *  - each element is a plain object with an allowed `role`.
 *  - each element has valid `content` per `isValidContent`.
 */
export function validateMessages(
  messages: unknown,
  opts: MessageValidationOptions,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(messages)) {
    errors.push("messages must be an array");
    return errors;
  }
  if (messages.length === 0) {
    errors.push("messages must not be empty");
    return errors;
  }
  messages.forEach((m, i) => {
    if (!isPlainObject(m)) {
      errors.push(`messages[${i}] must be an object`);
      return;
    }
    const role = m["role"];
    if (typeof role !== "string" || !opts.allowedRoles.includes(role)) {
      errors.push(
        `messages[${i}].role must be one of ${opts.allowedRoles.join(", ")}`,
      );
    }
    const allowNull =
      typeof role === "string" &&
      (opts.nullableContentRoles?.includes(role) ?? false);
    if (!isValidContent(m["content"], { allowNull })) {
      errors.push(
        `messages[${i}].content must be a string or an array of content blocks${
          allowNull ? " (or null)" : ""
        }`,
      );
    }
  });
  return errors;
}

/**
 * Validates an optional output-limit field (e.g. `max_tokens`,
 * `max_completion_tokens`): when present, must be a non-negative safe
 * integer not exceeding `ceiling`. Absence is not an error here — callers
 * decide whether the field is required.
 */
export function validateOutputLimit(
  value: unknown,
  fieldName: string,
  ceiling: number,
): string[] {
  if (value === undefined) return [];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return [`${fieldName} must be a non-negative integer`];
  }
  if (value > ceiling) {
    return [`${fieldName} must not exceed ${ceiling}`];
  }
  return [];
}

/** Validates an optional boolean flag field. */
export function validateOptionalBoolean(value: unknown, fieldName: string): string[] {
  if (value === undefined) return [];
  if (typeof value !== "boolean") return [`${fieldName} must be a boolean`];
  return [];
}

/**
 * Validates an optional `system` prompt field: a string, or an array of
 * content blocks (Anthropic allows both shapes).
 */
export function validateSystemPrompt(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value) && value.every(isContentBlock)) return [];
  return ["system must be a string or an array of content blocks"];
}

/**
 * Validates an optional `stream_options` field (OpenAI): a plain object
 * whose `include_usage`, if present, is a boolean.
 */
export function validateStreamOptions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return ["stream_options must be an object"];
  if (
    value["include_usage"] !== undefined &&
    typeof value["include_usage"] !== "boolean"
  ) {
    return ["stream_options.include_usage must be a boolean"];
  }
  return [];
}

/**
 * Validates an optional `tools` array against a per-tool shape predicate.
 * The predicate encapsulates provider-specific tool schema differences.
 */
export function validateTools(
  value: unknown,
  isValidTool: (tool: unknown) => boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ["tools must be an array"];
  const errors: string[] = [];
  value.forEach((t, i) => {
    if (!isValidTool(t)) errors.push(`tools[${i}] has an invalid shape`);
  });
  return errors;
}
