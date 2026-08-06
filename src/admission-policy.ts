import type { LLMAdmissionClassLimits } from "async-bulkhead-llm";
import type { TyrRequestIdentity } from "./identity.js";

export const MAX_ADMISSION_CLASSES = 64;
export const MAX_ADMISSION_CLASS_RULES = 256;
export const MAX_ADMISSION_RULE_VALUES = 256;
export const MAX_ADMISSION_IDENTIFIER_LENGTH = 256;

const RESERVED_ADMISSION_CLASS_IDS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type AdmissionClassRule = Readonly<{
  admissionClass: string;
  subjects?: readonly string[];
  tenantIds?: readonly string[];
  applicationIds?: readonly string[];
  roles?: readonly string[];
}>;

export type AdmissionClassesConfig = Readonly<{
  defaultClass: string;
  classes: Readonly<Record<string, LLMAdmissionClassLimits>>;
  /** First matching rule wins; selectors within one rule are ANDed. */
  rules?: readonly AdmissionClassRule[];
}>;

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_ADMISSION_IDENTIFIER_LENGTH) {
    throw new Error(
      `${field} must be at most ${MAX_ADMISSION_IDENTIFIER_LENGTH} characters`,
    );
  }
  return normalized;
}

export function normalizeAdmissionClassId(
  value: unknown,
  field: string,
): string {
  const id = nonEmptyString(value, field);
  if (RESERVED_ADMISSION_CLASS_IDS.has(id)) {
    throw new Error(`${field} uses reserved class ID ${JSON.stringify(id)}`);
  }
  return id;
}

function assertKnownKeys(
  value: object,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${field} contains unknown property ${JSON.stringify(key)}`);
    }
  }
}

function optionalMatchValues(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  if (value.length > MAX_ADMISSION_RULE_VALUES) {
    throw new Error(
      `${field} must contain at most ${MAX_ADMISSION_RULE_VALUES} values`,
    );
  }
  const normalized = value.map((entry, index) =>
    nonEmptyString(entry, `${field}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return Object.freeze(normalized);
}

function normalizeLimits(
  value: LLMAdmissionClassLimits,
  field: string,
  tokenBudgetEnabled: boolean,
): LLMAdmissionClassLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(
    value,
    [
      "protectedConcurrent",
      "maxConcurrent",
      "protectedInFlightTokens",
      "maxInFlightTokens",
    ],
    field,
  );
  const protectedConcurrent = value.protectedConcurrent;
  const maxConcurrent = value.maxConcurrent;
  const protectedInFlightTokens = value.protectedInFlightTokens;
  const maxInFlightTokens = value.maxInFlightTokens;
  for (const [name, candidate] of [
    ["protectedConcurrent", protectedConcurrent],
    ["maxConcurrent", maxConcurrent],
    ["protectedInFlightTokens", protectedInFlightTokens],
    ["maxInFlightTokens", maxInFlightTokens],
  ] as const) {
    if (
      candidate !== undefined &&
      (!Number.isSafeInteger(candidate) || candidate < 0)
    ) {
      throw new Error(`${field}.${name} must be a safe integer >= 0`);
    }
  }
  if (
    protectedConcurrent !== undefined &&
    maxConcurrent !== undefined &&
    protectedConcurrent > maxConcurrent
  ) {
    throw new Error(
      `${field}.protectedConcurrent must not exceed ${field}.maxConcurrent`,
    );
  }
  if (
    protectedInFlightTokens !== undefined &&
    maxInFlightTokens !== undefined &&
    protectedInFlightTokens > maxInFlightTokens
  ) {
    throw new Error(
      `${field}.protectedInFlightTokens must not exceed ${field}.maxInFlightTokens`,
    );
  }
  if (!tokenBudgetEnabled && protectedInFlightTokens !== undefined) {
    throw new Error(
      `${field}.protectedInFlightTokens requires an in-flight token budget`,
    );
  }
  if (!tokenBudgetEnabled && maxInFlightTokens !== undefined) {
    throw new Error(`${field}.maxInFlightTokens requires an in-flight token budget`);
  }
  return Object.freeze({
    ...(protectedConcurrent === undefined ? {} : { protectedConcurrent }),
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(protectedInFlightTokens === undefined
      ? {}
      : { protectedInFlightTokens }),
    ...(maxInFlightTokens === undefined ? {} : { maxInFlightTokens }),
  });
}

export function normalizeAdmissionClassesConfig(
  value: AdmissionClassesConfig,
  field: string,
  tokenBudgetEnabled: boolean,
): AdmissionClassesConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, ["defaultClass", "classes", "rules"], field);
  const defaultClass = normalizeAdmissionClassId(
    value.defaultClass,
    `${field}.defaultClass`,
  );
  const rawClasses = value.classes;
  if (
    typeof rawClasses !== "object" ||
    rawClasses === null ||
    Array.isArray(rawClasses)
  ) {
    throw new Error(`${field}.classes must be an object`);
  }
  const classEntries = Object.entries(rawClasses);
  if (classEntries.length === 0) {
    throw new Error(`${field}.classes must contain at least one class`);
  }
  if (classEntries.length > MAX_ADMISSION_CLASSES) {
    throw new Error(
      `${field}.classes must contain at most ${MAX_ADMISSION_CLASSES} classes`,
    );
  }
  const classes: Record<string, LLMAdmissionClassLimits> = {};
  for (const [rawId, limits] of classEntries) {
    const id = normalizeAdmissionClassId(rawId, `${field} class id`);
    if (Object.hasOwn(classes, id)) {
      throw new Error(
        `${field}.classes contains duplicate normalized class ID ${JSON.stringify(id)}`,
      );
    }
    classes[id] = normalizeLimits(
      limits,
      `${field}.classes[${JSON.stringify(id)}]`,
      tokenBudgetEnabled,
    );
  }
  if (!Object.hasOwn(classes, defaultClass)) {
    throw new Error(`${field}.defaultClass must reference a configured class`);
  }

  const rawRules = value.rules ?? [];
  if (!Array.isArray(rawRules)) {
    throw new Error(`${field}.rules must be an array`);
  }
  if (rawRules.length > MAX_ADMISSION_CLASS_RULES) {
    throw new Error(
      `${field}.rules must contain at most ${MAX_ADMISSION_CLASS_RULES} rules`,
    );
  }
  const rules = rawRules.map((rawRule, index): AdmissionClassRule => {
    if (
      typeof rawRule !== "object" ||
      rawRule === null ||
      Array.isArray(rawRule)
    ) {
      throw new Error(`${field}.rules[${index}] must be an object`);
    }
    assertKnownKeys(
      rawRule,
      ["admissionClass", "subjects", "tenantIds", "applicationIds", "roles"],
      `${field}.rules[${index}]`,
    );
    const admissionClass = normalizeAdmissionClassId(
      rawRule.admissionClass,
      `${field}.rules[${index}].admissionClass`,
    );
    if (!Object.hasOwn(classes, admissionClass)) {
      throw new Error(
        `${field}.rules[${index}].admissionClass references unknown class ${JSON.stringify(admissionClass)}`,
      );
    }
    const subjects = optionalMatchValues(
      rawRule.subjects,
      `${field}.rules[${index}].subjects`,
    );
    const tenantIds = optionalMatchValues(
      rawRule.tenantIds,
      `${field}.rules[${index}].tenantIds`,
    );
    const applicationIds = optionalMatchValues(
      rawRule.applicationIds,
      `${field}.rules[${index}].applicationIds`,
    );
    const roles = optionalMatchValues(
      rawRule.roles,
      `${field}.rules[${index}].roles`,
    );
    if (
      subjects === undefined &&
      tenantIds === undefined &&
      applicationIds === undefined &&
      roles === undefined
    ) {
      throw new Error(`${field}.rules[${index}] must define at least one selector`);
    }
    return Object.freeze({
      admissionClass,
      ...(subjects === undefined ? {} : { subjects }),
      ...(tenantIds === undefined ? {} : { tenantIds }),
      ...(applicationIds === undefined ? {} : { applicationIds }),
      ...(roles === undefined ? {} : { roles }),
    });
  });

  return Object.freeze({
    defaultClass,
    classes: Object.freeze(classes),
    ...(rules.length === 0 ? {} : { rules: Object.freeze(rules) }),
  });
}

function matchesRule(
  rule: AdmissionClassRule,
  identity: TyrRequestIdentity,
): boolean {
  if (rule.subjects !== undefined && !rule.subjects.includes(identity.subject)) {
    return false;
  }
  if (
    rule.tenantIds !== undefined &&
    (identity.tenantId === undefined || !rule.tenantIds.includes(identity.tenantId))
  ) {
    return false;
  }
  if (
    rule.applicationIds !== undefined &&
    (identity.applicationId === undefined ||
      !rule.applicationIds.includes(identity.applicationId))
  ) {
    return false;
  }
  if (
    rule.roles !== undefined &&
    !identity.roles.some((role) => rule.roles!.includes(role))
  ) {
    return false;
  }
  return true;
}

export function resolveAdmissionClass(
  config: AdmissionClassesConfig | undefined,
  identity: TyrRequestIdentity | undefined,
): string | undefined {
  if (config === undefined) return undefined;
  if (identity !== undefined) {
    for (const rule of config.rules ?? []) {
      if (matchesRule(rule, identity)) return rule.admissionClass;
    }
  }
  return config.defaultClass;
}
