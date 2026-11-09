import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { JsonValue } from './contracts';
import type { Attribute } from './wordpress';

export function canonical(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item) ?? null);
  }

  if (v.is(JsonObjectSchema, value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]);

    return Object.fromEntries(entries);
  }

  return value;
}

export function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export async function hash(value: JsonValue | undefined): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest('SHA-256', encoded);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Retain PHP object equivalence where the schema leaves shape unspecified.
// An explicit array or object/array union preserves that distinction.
export function stored(value: JsonValue | undefined, schema?: Attribute): JsonValue | undefined {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];

  if (Array.isArray(value)) {
    return value.map((item) => stored(item, schema?.items) ?? null);
  }

  if (v.is(JsonObjectSchema, value)) {
    const keys = Object.keys(value);

    if (!types.includes('array') && keys.every((key, index) => key === String(index))) {
      return keys.map((key) => stored(value[key], schema?.properties?.[key]) ?? null);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stored(item, schema?.properties?.[key])]),
    );
  }

  return value;
}

// Escapes each & that does not start a named or numeric entity.
export function escapeBareAmpersands(text: string): string {
  return text.replace(/&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)/g, '&amp;');
}

// Escapes each < that does not open a complete tag or comment. Left bare, the
// browser drops `b then c` from `a<b then c` as an unfinished tag, and a tag
// name such as `n;i++)` from code.
export function escapeBareLessThan(text: string): string {
  return text.replace(
    /<(?!\/?[a-zA-Z][\w:-]*(?:[\s/](?:"[^"]*"|'[^']*'|[^'"<>])*)?>|!--[\s\S]*?-->|(?!!--)[!?][^<>]*>)/g,
    '&lt;',
  );
}
