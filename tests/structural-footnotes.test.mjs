import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  footnoteRichText,
  footnoteParagraph,
  footnoteBodies,
} from './helpers/footnote-rich-text.mjs';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/structural-footnotes.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  define: { BLOCKWORK_DEBUG: 'false' },
});
const { structuralFootnotes } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const a = footnoteParagraph('a', 1);
const b = footnoteParagraph('b', 2);
const list = { clientId: 'list', name: 'core/footnotes', attributes: {}, innerBlocks: [] };
const original = [a, b, list];
const wp = {
  richText: footnoteRichText,
  blocks: {
    serialize: (blocks) => blocks.map((block) => JSON.stringify(block)).join('\n\n'),
    getBlockType: (name) => ({ name, attributes: { content: { type: 'string' } } }),
  },
  data: { select: () => ({ getBlockEditingMode: () => 'default' }) },
};
const plan = (blocks, declared) =>
  structuralFootnotes(wp, original, blocks, footnoteBodies(['a', 'b']), declared);

test('structural footnote move preserves link attributes and formatting while renumbering', () => {
  const before = structuredClone(original);
  const result = plan([b, a, list]);
  assert.equal(result.footnotes, footnoteBodies(['b', 'a']));
  assert.equal(result.companions.length, 2);
  assert.match(
    result.blocks[0].attributes.content,
    /href="#b" id="b-link"><strong>1<\/strong><\/a>/,
  );
  assert.deepEqual(original, before);
});

test('structural footnote remove drops only removed reference bodies', () => {
  assert.equal(plan([b, list]).footnotes, footnoteBodies(['b']));
  assert.equal(plan([list]).footnotes, '[]');
});

test('structural footnote local copy repeats body records and uses first occurrence numbering', () => {
  const duplicate = { ...footnoteParagraph('a', 3), clientId: 'copy' };
  const result = plan([a, b, duplicate, list]);
  assert.equal(result.footnotes, footnoteBodies(['a', 'b', 'a']));
  assert.match(result.blocks[2].attributes.content, /<strong>1<\/strong>/);
});

test('structural footnote numbering preserves formatting when digit counts change', () => {
  const many = Array.from({ length: 10 }, (_, index) => footnoteParagraph(`n${index}`, index + 1));
  const result = structuralFootnotes(
    wp,
    [...many, list],
    [...many.slice(1), many[0], list],
    footnoteBodies(many.map((block) => block.clientId)),
  );
  assert.match(
    result.blocks[9].attributes.content,
    /href="#n0" id="n0-link"><strong>10<\/strong><\/a>/,
  );
  assert.match(
    result.blocks[8].attributes.content,
    /href="#n9" id="n9-link"><strong>9<\/strong><\/a>/,
  );
});

test('structural footnote cross-document copy requires complete final supplied bodies', () => {
  const result = plan([a, b, footnoteParagraph('c', 1), list], footnoteBodies(['a', 'b', 'c']));
  assert.equal(result.footnotes, footnoteBodies(['a', 'b', 'c']));
  assert.equal(result.footnote_writes.source, 'settings');
  assert.throws(
    () => plan([a, b, footnoteParagraph('c', 1), list]),
    (error) =>
      error.diagnostics.constraint === 'footnote_body_required' &&
      /source paragraph markup and settings/.test(error.diagnostics.next_step),
  );
  assert.throws(() => plan([b, a, list], footnoteBodies(['a', 'b'])));
});

test('structural footnote declaration cannot replace observed bodies or guess missing ones', () => {
  assert.throws(() =>
    plan(
      original,
      JSON.stringify([
        { id: 'a', content: 'Replacement' },
        { id: 'b', content: 'Body b' },
      ]),
    ),
  );
  assert.throws(() => structuralFootnotes(wp, original, original, '[]'));
});

test('structural footnote preserves unrelated headings and nested blocks', () => {
  const heading = {
    ...a,
    name: 'core/heading',
    clientId: 'heading',
    attributes: { content: 'Heading' },
  };
  const group = {
    ...heading,
    name: 'core/group',
    clientId: 'group',
    attributes: {},
    innerBlocks: [heading],
  };
  const result = plan([heading, b, group, a, list]);
  assert.equal(result.blocks[0], heading);
  assert.equal(result.blocks[2], group);
});

test('structural footnote refuses references outside root paragraphs', () => {
  assert.throws(
    () => plan([{ ...a, name: 'core/heading' }, b, list]),
    (error) => error.diagnostics.constraint === 'footnote_root_references',
  );
  assert.throws(() =>
    plan([{ ...a, name: 'core/group', attributes: {}, innerBlocks: [a] }, b, list]),
  );
});

test('structural footnote evidence is bounded and contains no bodies', () => {
  const result = plan([b, a, list]);
  assert.deepEqual(result.footnote_writes.affected_paths, [[0], [1]]);
  assert.equal(result.footnote_writes.order_changed, true);
  assert.doesNotMatch(JSON.stringify(result.footnote_writes), /Body/);
  assert.deepEqual(plan(original).companions, []);
});
