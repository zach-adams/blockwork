export async function fixtureControl(
  descriptor,
  action,
  document = 'roundtrip',
  account = 'admin',
) {
  const response = await fetch(descriptor.control_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, document, account }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error('Fixture controller failed.');
  }

  return response.json();
}
