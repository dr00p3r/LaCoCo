export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : asString(value, path);
}

export function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

export function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

export function asStringRecord(value: unknown, path: string): Record<string, string> {
  const source = asRecord(value, path);
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [key, asString(entry, `${path}.${key}`)]),
  );
}

export function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value.map((entry, index) => asString(entry, `${path}[${index}]`));
}
