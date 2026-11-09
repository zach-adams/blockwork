// Runs in the fixture editor so both active editors and inactive previews are observed.
export async function installDateObserver(ids, target) {
  const core = wp.data.select('core');
  const source = wp.blocks.getBlockBindingsSource('core/post-data');
  const state = { traces: [], ids, target };
  const clone = value => JSON.parse(JSON.stringify(value));

  for (const id of [...ids, target]) await wp.data.resolveSelect('core').getEditedEntityRecord('postType', id === target ? 'page' : 'post', id);

  for (const priority of [1, 1000]) wp.hooks.addFilter('editor.BlockEdit', `blockwork/date-test-${priority}`, Original => props => {
    if (props.name === 'core/post-date') {
      const field = props.attributes.metadata?.bindings?.datetime?.args?.field;
      const context = props.context;
      const record = core.getEditedEntityRecord('postType', context.postType, context.postId);
      const computed = source.getValues({ select: wp.data.select, clientId: props.clientId, context, bindings: { datetime: { args: { field } } } })?.datetime;
      const raw = wp.data.select('core/block-editor').getBlockAttributes(props.clientId)?.datetime;

      if (state.traces.length < 800) state.traces.push(clone({ priority, field, context, computed, received: props.attributes.datetime, expected: record?.[field], raw }));
    }

    return wp.element.createElement(Original, props);
  }, priority);
  window.__blockwork_date_test = state;

  return true;
}

export async function inspectDateRendering(fields, root = false) {
  const state = window.__blockwork_date_test;
  const core = wp.data.select('core');
  const editor = wp.data.select('core/block-editor');
  const actions = wp.data.dispatch('core/block-editor');
  const pause = () => new Promise(resolve => setTimeout(resolve, 75));
  const require = (condition, message) => { if (!condition) throw new Error(message); };

  const docs = () => {
    const result = [];
    const walk = doc => {
      result.push(doc);

      for (const frame of doc.querySelectorAll('iframe')) if (frame.contentDocument) walk(frame.contentDocument);
    };

    walk(document);

    return result;
  };

  const flatten = blocks => blocks.flatMap(block => [block, ...flatten(block.innerBlocks)]);
  const blocks = flatten(editor.getBlocks());
  const dates = blocks.filter(block => block.name === 'core/post-date');
  const template = blocks.find(block => block.name === 'core/post-template');
  const times = () => docs().flatMap(doc => [...doc.querySelectorAll('time[datetime]')].map(node => {
    const li = node.closest('li.wp-block-post');

    return { id: Number(li?.className.match(/(?:^|\s)post-(\d+)(?:\s|$)/)?.[1]) || state.target,
      datetime: node.getAttribute('datetime'), preview: li?.getAttribute('role') === 'button', hidden: li?.style.display === 'none' };
  }));
  const observations = [];

  for (const activeId of state.ids) {
    const preview = docs().flatMap(doc => [...doc.querySelectorAll(`li.wp-block-post.post-${activeId}[role="button"]`)])[0];
    preview?.click();

    if (template) actions.selectBlock(template.clientId, null);
    await pause();

    for (const date of dates) { actions.selectBlock(date.clientId, null); await pause(); }

    let rendered;

    for (let attempt = 0; attempt < 60; attempt++) {
      rendered = times();

      if (state.ids.every(id => fields.every(field => rendered.some(time => !time.hidden && time.id === id && time.preview === (id !== activeId) && time.datetime === wp.date.dateI18n('c', core.getEditedEntityRecord('postType', 'post', id)[field]))))) break;
      await pause();
    }

    for (const id of state.ids) for (const field of fields) {
      const expected = wp.date.dateI18n('c', core.getEditedEntityRecord('postType', 'post', id)[field]);
      require(rendered.some(time => !time.hidden && time.id === id && time.preview === (id !== activeId) && time.datetime === expected), `Missing ${id}.${field} in ${id === activeId ? 'active editor' : 'inactive preview'}`);

      for (const priority of [1, 1000]) require(state.traces.some(trace => trace.context.postId === id && trace.field === field && trace.priority === priority), `Missing computed observer ${id}.${field}.${priority}`);
    }

    observations.push({ active_id: activeId, times: rendered });
  }

  for (const trace of state.traces) require(/^\d{4}-\d\d-\d\dT/.test(trace.expected) && Number.isFinite(Date.parse(trace.expected)) && trace.computed === trace.expected && trace.received === trace.expected && trace.raw !== trace.received, 'Backing getter or actual computed BlockEdit datetime differs');

  if (root) for (const field of fields) require(state.traces.some(trace => trace.context.postId === state.target && trace.field === field && trace.received === trace.expected), `Missing current-post ${field} observation`);

  return { observations, traces: state.traces };
}

export function removeDateObserver() {
  for (const priority of [1, 1000]) wp.hooks.removeFilter('editor.BlockEdit', `blockwork/date-test-${priority}`);
  delete window.__blockwork_date_test;

  return true;
}
