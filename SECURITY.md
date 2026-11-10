# Security

Blockwork works inside your signed-in WordPress session in the desktop app's
browser. A bug in it can change anything your WordPress account can change, so
security reports are welcome.

## Report a vulnerability

Report it privately with "Report a vulnerability" on this repository's Security
tab. Please don't open a public issue for it. Include the Blockwork and WordPress
versions and steps that reproduce it on a disposable site, such as one from
`pnpm fixture`. Leave out real site content, passwords, cookies, and nonces.

Only the latest release gets fixes.

## What Blockwork can reach

- The WordPress site open in the app's browser, through the editor's data stores
  and the REST API with the signed-in user's cookie and nonce.
- Save receipts in `~/.local/share/blockwork/receipts/` on your computer.

It runs no server, stores no passwords, and talks to no service besides the
desktop app and your site.

## What counts

- A change to a site, post, or shared entity that the request didn't cover.
- A save after Blockwork reported that it hadn't saved, or a save reported as
  verified that WordPress didn't store.
- Getting past WordPress permissions, editor locks, or Blockwork's own refusals.
- Cookies, nonces, or passwords appearing in Blockwork's results or receipts.

Report problems in WordPress, Gutenberg, or the desktop app to those projects.
