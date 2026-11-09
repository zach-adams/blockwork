import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startFixture } from './playground.mjs';

export const integrationVersions = ['7.1.4', '7.0.8', '7.0.0'];
const actions = ['snapshot', 'external_edit', 'lock', 'revoke', 'restrict', 'credentials'];
const controlSource = await readFile(
  new URL('../tests/fixtures/control.php', import.meta.url),
  'utf8',
);

export async function startIntegrationFixture(version = '7.1.4') {
  if (!integrationVersions.includes(version)) {
    throw new Error('Choose one of the pinned integration versions.');
  }

  const fixture = await startFixture(false, version, true);
  const control = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');

    try {
      if (
        request.method !== 'POST' ||
        request.headers.origin ||
        request.headers['content-type'] !== 'application/json'
      ) {
        response
          .writeHead(403)
          .end(JSON.stringify({ error: 'Use the host-side fixture controller.' }));

        return;
      }

      const chunks = [];
      let bytes = 0;

      for await (const chunk of request) {
        bytes += chunk.length;

        if (bytes > 4096) {
          throw new Error('Fixture request too large.');
        }

        chunks.push(chunk);
      }

      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const account = input.account ?? 'admin';
      const document = input.document ?? 'roundtrip';

      if (
        !actions.includes(input.action) ||
        !Object.hasOwn(fixture.state.accounts, account) ||
        !Object.hasOwn(fixture.state.documents, document)
      ) {
        throw new Error('Unknown fixture action, account, or document.');
      }

      if (input.action === 'credentials') {
        input.password = fixture.password;
      }

      const encoded = Buffer.from(JSON.stringify(input)).toString('base64');
      const result = await fixture.cli.playground.run({
        code: `<?php $input = json_decode(base64_decode('${encoded}'), true); ?>${controlSource}`,
      });

      if (result.exitCode !== 0) {
        throw new Error('WordPress fixture control failed.');
      }

      response.end(
        JSON.stringify(
          input.action === 'credentials'
            ? {
                username: account === 'admin' ? 'admin' : `blockwork_${account}`,
                password: fixture.password,
              }
            : result.json,
        ),
      );
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });

  try {
    await new Promise((resolve, reject) => {
      control.once('error', reject);
      control.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await fixture.cli[Symbol.asyncDispose]();

    throw error;
  }

  const descriptor = {
    target: fixture.target,
    state: fixture.state,
    timings: fixture.timings,
    control_url: `http://127.0.0.1:${control.address().port}`,
  };

  return {
    descriptor,
    fixture,
    async [Symbol.asyncDispose]() {
      await new Promise((resolve) => {
        control.close(resolve);
        control.closeAllConnections();
      });
      await fixture.cli[Symbol.asyncDispose]();
    },
  };
}

async function serve() {
  const running = await startIntegrationFixture(process.argv[2]);
  console.log(JSON.stringify(running.descriptor));

  try {
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await running[Symbol.asyncDispose]();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve();
}
