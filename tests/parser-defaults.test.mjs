import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({
  stdin: {
    contents: `export { roundTripMatches, parsedBlockInput, attributes } from './edits';
      export { readTree } from './inspection';
      export { errorHint } from './errors';`,
    resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  define: { BLOCKWORK_DEBUG: 'false' },
  write: false,
  platform: 'node',
  format: 'esm',
});
const { roundTripMatches, parsedBlockInput, attributes, readTree, errorHint } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

function fixture(schema, change = (attrs) => attrs, serialize) {
  const wp = {
    blocks: {
      getBlockType: () => ({ attributes: schema }),
      createBlock(name, attrs, innerBlocks) {
        const defaults = Object.fromEntries(
          Object.entries(schema)
            .filter(([, item]) => 'default' in item)
            .map(([key, item]) => [key, structuredClone(item.default)]),
        );

        return block(change({ ...defaults, ...attrs }), innerBlocks, name);
      },
      serialize:
        serialize ??
        ((blocks) =>
          JSON.stringify(
            blocks.map(({ name, attributes, innerBlocks }) => ({
              name,
              attributes,
              children: wp.blocks.serialize(innerBlocks),
            })),
          )),
    },
  };

  return wp;
}

function block(attributes, innerBlocks = [], name = 'core/test') {
  return { name, attributes, innerBlocks, clientId: 'test', isValid: true };
}

const booleanSchema = {
  type: 'boolean',
  source: 'attribute',
  selector: 'audio',
  attribute: 'autoplay',
};

function matches(schema, expected = {}, actual = { autoplay: false }, serializer = () => 'same') {
  const wp = fixture({ autoplay: schema, other: { type: 'string' } }, undefined, serializer);

  return roundTripMatches(wp, readTree(wp, [block(expected)]), readTree(wp, [block(actual)]));
}

test('omitted sourced boolean false is accepted', () => assert.equal(matches(booleanSchema), true));
test('explicit true and other saved changes are refused', () => {
  assert.equal(matches(booleanSchema, { autoplay: true }), false);
  assert.equal(matches(booleanSchema, {}, { autoplay: false, other: 'changed' }), false);
});
test('boolean addition requires its complete registration', () => {
  for (const field of ['type', 'source', 'selector', 'attribute']) {
    const schema = { ...booleanSchema };
    delete schema[field];
    assert.equal(matches(schema), false, field);
  }

  assert.equal(matches(undefined), false);

  for (const schema of [
    { ...booleanSchema, type: 'string' },
    { ...booleanSchema, source: 'html' },
    { ...booleanSchema, selector: '' },
    { ...booleanSchema, attribute: '' },
  ]) {
    assert.equal(matches(schema), false);
  }
});
test('boolean addition requires identical save bytes', () =>
  assert.equal(matches(booleanSchema, {}, { autoplay: false }, JSON.stringify), false));

for (const [type, value] of [
  ['number', null],
  ['string', null],
  ['object', null],
  ['object', []],
]) {
  test(`parser restores invalid exact default ${type} ${JSON.stringify(value)}`, () => {
    const wp = fixture({ value: { type, default: value } });
    assert.deepEqual(parsedBlockInput(wp, block({ value })).attributes, {});
    assert.throws(() => attributes(wp, 'core/test', { value }));
  });
}

test('non-default invalid values remain refused', () => {
  const wp = fixture({ value: { type: 'number', default: null } });
  assert.throws(() => parsedBlockInput(wp, block({ value: 'invalid' })));
});
test('changed recreation attributes and bytes are refused', () => {
  const schema = { value: { type: 'object', default: [] } };
  assert.throws(() =>
    parsedBlockInput(
      fixture(schema, () => ({ value: {} })),
      block({ value: [] }),
    ),
  );
  let saves = 0;
  assert.throws(() =>
    parsedBlockInput(
      fixture(schema, undefined, () => String(++saves)),
      block({ value: [] }),
    ),
  );
});
test('parser preserves nested children and order', () => {
  const wp = fixture({ value: { type: 'number', default: null }, label: { type: 'string' } });
  const original = block({ value: null }, [
    block({ value: null, label: 'first' }),
    block({ value: null, label: 'second' }),
  ]);
  const input = parsedBlockInput(wp, original);
  assert.deepEqual(
    input.inner_blocks.map((child) => child.attributes),
    [{ label: 'first' }, { label: 'second' }],
  );
});
test('metadata bindings remain refused', () => {
  const wp = fixture({ metadata: { type: 'object' } });
  assert.throws(() => parsedBlockInput(wp, block({ metadata: { bindings: {} } })));
});

test('Post Date context refusal explains the explicit-tree repair', () => {
  const hint = errorHint('post_date_context_unavailable', 'edit');
  assert.match(hint, /core\/post-data/);
  assert.match(hint, /every actual preview post/);
  assert.match(hint, /explicit native children/);
  assert.match(hint, /never invent a datetime/);
});

test('footnote refusals give specific safe repair steps', () => {
  const hint = (constraint) => errorHint('unsupported_structural_edit', 'edit', { constraint });
  assert.match(hint('footnote_request_incomplete'), /paragraph content updates.*bare root Footnotes insert.*complete final/s);
  assert.match(hint('footnote_request_incomplete'), /outside paragraphs.*preserve the draft/i);
  assert.match(hint('footnote_body_order'), /reference order.*repeating/i);
  assert.match(hint('footnote_reference_number'), /content update.*same request.*outside a paragraph/s);
  assert.match(hint('footnote_list_missing'), /bare root Footnotes block insert/);
  assert.match(errorHint('field_changed', 'edit', { editor_result: 'partial' }), /do not replay/);
});
