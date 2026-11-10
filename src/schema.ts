import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { JsonObject, JsonValue } from './contracts';
import type { Attribute } from './wordpress';
import { requireCondition as assert } from './inspection';
import { same } from './values';

export function safeValue(value: JsonValue | undefined, depth = 0): void {
  assert(depth < 16, 'attribute_too_deep');

  if (Array.isArray(value)) {
    for (const item of value) {
      safeValue(item, depth + 1);
    }
  } else if (v.is(JsonObjectSchema, value)) {
    for (const [key, item] of Object.entries(value)) {
      assert(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsupported_attribute');
      safeValue(item, depth + 1);
    }
  } else if (v.is(v.number(), value)) {
    assert(Number.isFinite(value), 'unsupported_attribute_type');
  }
}

export interface SchemaIssue extends JsonObject {
  path: string;
  constraint: string;
  expected_type?: string | string[];
}

// The types WordPress's REST validation applies rules for.
const restTypes = ['string', 'boolean', 'integer', 'number', 'object', 'array', 'null'];

// The first place a value breaks a schema, or nothing when it fits.
//
// `lenient` is for a schema WordPress will validate itself, where a refusal
// here should be one WordPress would make too. It skips `pattern`, which PHP
// reads with another regex engine. Like WordPress, it applies no rule for a
// missing or unknown type, ignores an empty `enum`, leaves undeclared keys
// alone when `patternProperties` is present, and stops at the depth limit
// instead of refusing. It still asks for native JSON types, where WordPress
// would also take "5" for an integer, so it can be stricter than WordPress for
// a schema that combines types or compares arrays with objects.
export function schemaIssue(
  value: JsonValue | undefined,
  schema: Attribute,
  lenient = false,
  path = 'value',
  depth = 0,
): SchemaIssue | undefined {
  const issue = (constraint: string, at = path): SchemaIssue => ({
    path: at.slice(0, 200),
    constraint,
  });
  const within = (item: JsonValue | undefined, child: Attribute, at = path) =>
    schemaIssue(item, child, lenient, at, depth + 1);

  if (depth >= 16) {
    return lenient ? undefined : issue('too_deep');
  }

  let types: string[] = [];

  if (Array.isArray(schema.type)) {
    types = schema.type;
  } else if (schema.type) {
    types = [schema.type];
  }

  const matches = (type: string): boolean => {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'rich-text':
        // A block attribute type, which REST validation does not know.
        return lenient || typeof value === 'string';
      case 'boolean':
        return typeof value === 'boolean';
      case 'integer':
        // WordPress takes an integer of any size.
        return lenient ? Number.isInteger(value) : Number.isSafeInteger(value);
      case 'number':
        return v.is(v.pipe(v.number(), v.finite()), value);
      case 'object':
        return v.is(JsonObjectSchema, value);
      case 'array':
        return Array.isArray(value);
      case 'null':
        return value === null;
      default:
        return lenient;
    }
  };

  if (types.length && !types.some(matches)) {
    return { ...issue('type'), expected_type: schema.type };
  }

  const typed = !lenient || (types.length > 0 && types.every((type) => restTypes.includes(type)));
  const listed = schema.enum && (schema.enum.length > 0 || !lenient);

  if (listed && !schema.enum?.some((item) => same(item, value))) {
    return issue('enum');
  }

  if (schema.oneOf) {
    const alternatives = schema.oneOf.filter((item) => !within(value, item));

    // A skipped rule may be what tells two alternatives apart.
    if (!alternatives.length || (alternatives.length > 1 && !lenient)) {
      return issue('one_of');
    }
  }

  if (schema.anyOf && !schema.anyOf.some((item) => !within(value, item))) {
    return issue('any_of');
  }

  if (typed && v.is(v.number(), value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return issue('minimum');
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      return issue('maximum');
    }
  }

  if (typed && typeof value === 'string') {
    // WordPress counts characters, where `length` counts UTF-16 units.
    const characters = [...value].length;

    if (schema.minLength !== undefined && characters < schema.minLength) {
      return issue('min_length');
    }

    if (schema.maxLength !== undefined && characters > schema.maxLength) {
      return issue('max_length');
    }

    if (schema.pattern && !lenient) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          return issue('pattern');
        }
      } catch {
        return issue('pattern');
      }
    }
  }

  if (typed && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return issue('min_items');
    }

    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return issue('max_items');
    }

    if (schema.uniqueItems) {
      const hasDuplicates = value.some((item, index) => {
        const previousItems = value.slice(0, index);

        return previousItems.some((other) => same(item, other));
      });

      if (hasDuplicates) {
        return issue('unique_items');
      }
    }

    const itemSchema = schema.items;

    if (itemSchema) {
      for (const [index, item] of value.entries()) {
        const found = within(item, itemSchema, `${path}.${index}`);

        if (found) {
          return found;
        }
      }
    }
  }

  if (typed && v.is(JsonObjectSchema, value)) {
    const missing = Array.isArray(schema.required)
      ? schema.required.find((key) => !Object.hasOwn(value, key))
      : undefined;

    if (missing !== undefined) {
      return issue('required', `${path}.${missing}`);
    }

    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      const at = `${path}.${key}`;
      const extra = schema.additionalProperties;

      if (property) {
        const found = within(item, property, at);

        if (found) {
          return found;
        }
      } else if (lenient && schema.patternProperties) {
        // WordPress tries such a key against the patterns first.
        continue;
      } else if (extra === false) {
        return issue('additional_properties', at);
      } else if (extra && extra !== true) {
        const found = within(item, extra, at);

        if (found) {
          return found;
        }
      }
    }
  }

  return undefined;
}

export function schemaAllows(value: JsonValue | undefined, schema: Attribute): boolean {
  return !schemaIssue(value, schema);
}
