// Minimal public rich-text mock. Native rendering remains covered by editing tests.
export const footnoteRichText = {
  create({ html = '', text }) {
    if (text !== undefined)
      return { text, formats: Array(text.length), replacements: Array(text.length) };

    if (html.startsWith('{')) {
      const content = (block) =>
        String(block.attributes.content ?? '') + block.innerBlocks.map(content).join('');
      html = html
        .split('\n\n')
        .map((block) => content(JSON.parse(block)))
        .join('');
    }

    const label = html.match(/^((?:<[^>]+>)*)(\d+)((?:<\/[^>]+>)*)$/);

    if (label)
      return {
        text: label[2],
        formats: Array.from({ length: label[2].length }, () => [
          { open: label[1], close: label[3] },
        ]),
        replacements: Array(label[2].length),
      };
    const replacements = [];
    let value = '';
    let start = 0;

    for (const match of html.matchAll(/<sup data-fn="([^"]+)" class="fn">([\s\S]*?)<\/sup>/g)) {
      value += html.slice(start, match.index);
      replacements[value.length] = {
        type: 'core/footnote',
        attributes: { 'data-fn': match[1] },
        innerHTML: match[2],
      };
      value += '\ufffc';
      start = match.index + match[0].length;
    }

    value += html.slice(start);

    return { text: value, formats: Array(value.length), replacements };
  },
  toHTMLString({ value }) {
    if (/^\d+$/.test(value.text)) {
      const format = value.formats[0]?.[0];

      return `${format?.open ?? ''}${value.text}${format?.close ?? ''}`;
    }

    return value.text
      .split('')
      .map((character, index) => {
        const replacement = value.replacements[index];

        return replacement
          ? `<sup data-fn="${replacement.attributes['data-fn']}" class="fn">${replacement.innerHTML}</sup>`
          : character;
      })
      .join('');
  },
};

export function footnoteParagraph(id, number, text = 'Reference') {
  return {
    clientId: id,
    name: 'core/paragraph',
    innerBlocks: [],
    isValid: true,
    attributes: {
      content: `${text}<sup data-fn="${id}" class="fn"><a href="#${id}" id="${id}-link"><strong>${number}</strong></a></sup>`,
    },
  };
}

export function footnoteBodies(ids) {
  return JSON.stringify(ids.map((id) => ({ id, content: `Body ${id}` })));
}
