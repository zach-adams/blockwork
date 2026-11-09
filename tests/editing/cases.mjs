import { test as nativeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const finding = (options) =>
  options.todo && String(options.todo).startsWith('finding: ')
    ? options.todo.slice('finding: '.length)
    : undefined;

export function editingTests(url) {
  const entries = [];
  const setup = [];
  const cleanup = [];
  const prefix = [];
  const fullName = (name) => [...prefix, name].join(' ');
  const register = (kind, name, options, body) => {
    if (options instanceof Function) {
      body = options;
      options = {};
    }

    if (kind === 'generated') options = { findings: [], ...options };
    entries.push({ kind, name: fullName(name), options, body });
  };

  return {
    before: (fn) => setup.push(fn),
    after: (fn) => cleanup.push(fn),
    describe(name, fn) {
      prefix.push(name);

      try {
        fn();
      } finally {
        prefix.pop();
      }
    },
    test: (name, options, body) => register('test', name, options, body),
    generated: (name, options, body) => register('generated', name, options, body),
    run({
      collect = process.env.BLOCKWORK_COLLECT === '1',
      findings = JSON.parse(process.env.BLOCKWORK_FINDINGS || '[]'),
      pattern = process.env.BLOCKWORK_PATTERN
        ? new RegExp(process.env.BLOCKWORK_PATTERN)
        : undefined,
      skipPattern = process.env.BLOCKWORK_SKIP_PATTERN
        ? new RegExp(process.env.BLOCKWORK_SKIP_PATTERN)
        : undefined,
    } = {}) {
      const metadata = entries.map(({ kind, name, options }) => ({
        kind,
        name,
        todo: options.todo,
        findings: kind === 'generated' ? options.findings : undefined,
      }));

      if (collect) {
        if (process.env.BLOCKWORK_COLLECT === '1') console.log(JSON.stringify(metadata));

        return metadata;
      }

      const selected = (name, options) =>
        (!findings.length || findings.includes(finding(options))) &&
        (!pattern || pattern.test(name)) &&
        (!skipPattern || !skipPattern.test(name));
      const candidates = entries.filter((entry) =>
        entry.kind === 'test'
          ? selected(entry.name, entry.options)
          : !findings.length || entry.options.findings.some((value) => findings.includes(value)),
      );

      if (!candidates.length) return metadata;
      nativeTest(basename(fileURLToPath(url)), async (t) => {
        for (const fn of cleanup) t.after(fn);

        for (const fn of setup) await fn();

        for (const entry of candidates) {
          if (entry.kind === 'test') {
            await t.test(entry.name, entry.options, entry.body);
          } else {
            await entry.body({
              diagnostic: t.diagnostic.bind(t),
              selected(name, options = {}) {
                return selected(`${entry.name} ${name}`, options);
              },
              async test(name, options, body) {
                if (options instanceof Function) {
                  body = options;
                  options = {};
                }

                const leafFinding = finding(options);

                if (leafFinding && !entry.options.findings.includes(leafFinding)) {
                  throw new Error(`Undeclared finding ${leafFinding} in ${entry.name}`);
                }

                const leafName = `${entry.name} ${name}`;

                if (!selected(leafName, options)) return { selected: false, completed: false };
                let completed = false;
                let value;
                await t.test(leafName, options, async (context) => {
                  value = await body(context);
                  completed = true;
                });

                return { selected: true, completed, value };
              },
            });
          }
        }
      });

      return metadata;
    },
  };
}
