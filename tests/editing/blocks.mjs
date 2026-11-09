// Serialized block markup for seeding documents, written the way Gutenberg writes it.
export const paragraph = (text = 'Text', attributes) =>
  block('paragraph', attributes, `<p>${text}</p>`);
export const heading = (text = 'Title', level = 2) =>
  block(
    'heading',
    level === 2 ? undefined : { level },
    `<h${level} class="wp-block-heading">${text}</h${level}>`,
  );
export const group = (...children) =>
  block(
    'group',
    { layout: { type: 'constrained' } },
    `<div class="wp-block-group">${children.join('\n\n')}</div>`,
  );
export const button = (text = 'Go', url) =>
  block(
    'button',
    undefined,
    `<div class="wp-block-button"><a class="wp-block-button__link wp-element-button"${url ? ` href="${url}"` : ''}>${text}</a></div>`,
  );
export const buttons = (...children) =>
  block('buttons', undefined, `<div class="wp-block-buttons">${children.join('\n\n')}</div>`);
export const listItem = (text = 'Item') => block('list-item', undefined, `<li>${text}</li>`);
export const list = (...items) =>
  block('list', undefined, `<ul class="wp-block-list">${items.join('\n\n')}</ul>`);
export const column = (...children) =>
  block('column', undefined, `<div class="wp-block-column">${children.join('\n\n')}</div>`);
export const columns = (...children) =>
  block('columns', undefined, `<div class="wp-block-columns">${children.join('\n\n')}</div>`);
export const doc = (...blocks) => blocks.join('\n\n');

export function block(name, attributes, html) {
  const json = attributes ? ` ${JSON.stringify(attributes)}` : '';

  return html === undefined
    ? `<!-- wp:${name}${json} /-->`
    : `<!-- wp:${name}${json} -->\n${html}\n<!-- /wp:${name} -->`;
}

const olderAccordionItem = (title, body) =>
  block(
    'accordion-item',
    undefined,
    '<div class="wp-block-accordion-item">' +
      block(
        'accordion-heading',
        undefined,
        '<h3 class="wp-block-accordion-heading"><button type="button" class="wp-block-accordion-heading__toggle">' +
          `<span class="wp-block-accordion-heading__toggle-title">${title}</span>` +
          '<span class="wp-block-accordion-heading__toggle-icon" aria-hidden="true">+</span></button></h3>',
      ) +
      '\n\n' +
      block(
        'accordion-panel',
        undefined,
        `<div role="region" class="wp-block-accordion-panel">${paragraph(body)}</div>`,
      ) +
      '</div>',
  );
export const olderAccordion = doc(
  block(
    'accordion',
    undefined,
    `<div role="group" class="wp-block-accordion">${olderAccordionItem('First', 'First body')}\n\n${olderAccordionItem('Second', 'Second body')}</div>`,
  ),
  paragraph('Neighbor'),
);
