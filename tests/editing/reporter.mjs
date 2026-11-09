export function summarize(results, children, findings) {
  const leaves = results.filter(
    ({ data }) =>
      !children.has(`${data.entryFile}:${data.testId}`) && !data.skip && data.nesting > 0,
  );
  const errors = [];

  if (results.some(({ type, data }) => type === 'test:fail' && !data.todo)) {
    errors.push('A test or its setup or cleanup failed');
  }

  for (const { type, data } of leaves) {
    if (type === 'test:pass' && String(data.todo).startsWith('finding: ')) {
      errors.push(`Stale finding passed: ${data.todo} (${data.name})`);
    }
  }

  if (!leaves.length) errors.push('No test cases matched the selection');

  for (const slug of new Set(findings)) {
    if (!leaves.some(({ data }) => data.todo === `finding: ${slug}`)) {
      errors.push(`No test case produced finding: ${slug}`);
    }
  }

  return { errors, count: leaves.length };
}
