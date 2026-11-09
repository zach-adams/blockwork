import * as v from 'valibot';
import type { JsonObject, Receipt } from './contracts';
import type { WordPress } from './wordpress';
import { readTree, storedState } from './inspection';
import { hash } from './values';

export function contentlessHash(fields: JsonObject): Promise<string> {
  const { content: _content, ...rest } = fields;

  return hash(rest);
}

export async function blocksHash(wp: WordPress, content: string): Promise<string> {
  return hash(storedState(wp, readTree(wp, wp.blocks.parse(content))));
}

// Matching parsed blocks also accepts PHP re-serialization when every other
// field matches. Comparing blocks needs the site's editor registrations.
export async function receiptMatch(
  wp: WordPress,
  fields: JsonObject,
  receipt: Receipt,
): Promise<'matched' | 'different' | 'unavailable'> {
  // The slug WordPress generated for this save isn't one the receipt could name.
  const forms =
    receipt.generated_slug && fields.slug ? [fields, { ...fields, slug: '' }] : [fields];
  const hashes = await Promise.all(forms.map((form) => hash(form)));

  if (hashes.includes(receipt.desired_hash)) {
    return 'matched';
  }

  const contentless = await Promise.all(forms.map((form) => contentlessHash(form)));

  if (!contentless.includes(receipt.fields_hash) || !v.is(v.string(), fields.content)) {
    return 'different';
  }

  if (!wp.blocks?.parse || !wp.blocks.getBlockType) {
    return 'unavailable';
  }

  return (await blocksHash(wp, fields.content)) === receipt.block_hash ? 'matched' : 'different';
}
