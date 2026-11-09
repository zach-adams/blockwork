import {
  block,
  buttons,
  button,
  column,
  columns,
  doc,
  group,
  heading,
  list,
  listItem,
  paragraph,
} from './blocks.mjs';

const responsiveHeading = (text) =>
  block(
    'heading',
    {
      style: {
        typography: { fontSize: '48px' },
        '@mobile': { typography: { fontSize: '28px' } },
        '@tablet': { typography: { fontSize: '36px' } },
      },
    },
    `<h2 class="wp-block-heading" style="font-size:48px">${text}</h2>`,
  );

const faq = (question, answer) =>
  block(
    'details',
    undefined,
    `<details class="wp-block-details"><summary>${question}</summary>${paragraph(answer)}</details>`,
  );

const stat = (number, label) => group(heading(number, 3), paragraph(label));

// A page shaped like a real marketing page: nesting, repeated items, responsive
// overrides, a table, and repeated text, all from core blocks.
export function landingPage({ heroImage, photo }) {
  return doc(
    block(
      'cover',
      {
        url: heroImage.url,
        id: heroImage.id,
        dimRatio: 50,
        minHeight: 600,
        minHeightUnit: 'px',
        align: 'full',
        style: { '@mobile': { dimensions: { minHeight: '250px' } } },
      },
      `<div class="wp-block-cover alignfull" style="min-height:600px"><img class="wp-block-cover__image-background wp-image-${heroImage.id}" alt="" src="${heroImage.url}" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-background-dim"></span><div class="wp-block-cover__inner-container">${responsiveHeading('Financing That Moves With You')}\n\n${paragraph('Flexible capital for growing companies.')}\n\n${buttons(button('Get Started', '/contact/'), button('Learn More', '/about/'))}</div></div>`,
    ),
    group(
      heading('Our Approach'),
      paragraph('We start by listening. Then we structure a facility around your business.'),
      columns(
        column(
          `<!-- wp:image {"id":${photo.id},"sizeSlug":"large","linkDestination":"none"} -->\n<figure class="wp-block-image size-large"><img src="${photo.url}" alt="${photo.alt}" class="wp-image-${photo.id}"/></figure>\n<!-- /wp:image -->`,
        ),
        column(
          heading('Why Work With Us', 3),
          list(listItem('Fast decisions'), listItem('Clear terms'), listItem('Experienced team')),
          buttons(button('Meet Our Team', '/team/')),
        ),
      ),
    ),
    group(
      heading('By the Numbers'),
      columns(
        column(stat('$10 Million', 'Funded Last Year')),
        column(stat('30 Days', 'Typical Approval Time')),
        column(stat('150+', 'Clients Served')),
      ),
    ),
    group(
      heading('Pricing'),
      block(
        'table',
        undefined,
        '<figure class="wp-block-table"><table class="has-fixed-layout"><thead><tr><th>Plan</th><th>Rate</th></tr></thead><tbody><tr><td>Starter</td><td>5%</td></tr><tr><td>Growth</td><td>4%</td></tr></tbody></table></figure>',
      ),
    ),
    group(
      heading('Frequently Asked Questions'),
      faq('How fast is funding?', 'Most facilities close within 30 days.'),
      faq('Which companies qualify?', 'Established companies with steady revenue.'),
      faq('Is there a minimum size?', 'We work with companies of every size.'),
    ),
    group(
      heading('Ready to grow?'),
      paragraph('Talk to our team today.'),
      buttons(button('Contact Us', '/contact/')),
    ),
  );
}
