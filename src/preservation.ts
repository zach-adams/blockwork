import type { BlockSummary, JsonObject } from './contracts';
import type { WordPress } from './wordpress';
import { containsPath, requireCondition } from './inspection';

// These string regions are evidence only. Gutenberg owns the saved serialization.
export function provePreservation(
  wp: WordPress,
  before: BlockSummary[],
  after: BlockSummary[],
  original: string,
  desired: string,
  changes: Map<string, JsonObject>,
): void {
  const targets = before.filter((row) => changes.has(row.clientId));

  const roots = targets.filter((row) => {
    const coveredByAncestor = targets.some(
      (other) => other.path.length < row.path.length && containsPath(other.path, row.path),
    );

    return !coveredByAncestor;
  });

  const region = (row: BlockSummary) => {
    const markup = wp.blocks.serialize([row.block]);
    const start = markup ? original.indexOf(markup) : -1;
    requireCondition(
      start >= 0 && original.indexOf(markup, start + 1) === -1,
      'ambiguous_preservation_region',
    );

    return { row, start, end: start + markup.length };
  };

  const regions = roots.map(region).sort((a, b) => a.start - b.start);
  requireCondition(
    regions.every((item, i) => i === 0 || item.start >= regions[i - 1].end),
    'overlapping_preservation_regions',
  );

  for (const row of before) {
    if (row.support !== 'unsupported') {
      continue;
    }

    const item = region(row);
    requireCondition(
      !regions.some((target) => item.start < target.end && item.end > target.start),
      'overlapping_preservation_regions',
    );
  }

  let expected = '';
  let offset = 0;

  for (const item of regions) {
    const replacement = after.find(
      (row) => row.path.length === item.row.path.length && containsPath(item.row.path, row.path),
    );

    requireCondition(replacement, 'preservation_target_missing');
    expected += original.slice(offset, item.start) + wp.blocks.serialize([replacement.block]);
    offset = item.end;
  }

  requireCondition(desired === expected + original.slice(offset), 'unrelated_content_changed');
}
