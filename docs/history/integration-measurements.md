# Fixture measurements

## Measurements on October 4, 2026

Measured on an Apple M3 Max with 36 GiB RAM, Node 26.10.0, PHP 8.4.25, and
WordPress 7.1.2. Each run created a new database. Cached runs reused only the
downloaded WordPress archive, not a populated site. Startup covers `runCLI` and
the PHP call that reads the seeded target. Package installation and module
import time are excluded.

| Measurement | One-worker result |
| --- | --- |
| Startup with WordPress archive absent | 12.98 s |
| Three cached fresh-site startups | 5.81, 5.31, 5.09 s |
| Public REST read | 312 to 330 ms |
| WordPress write and readback | 316 to 334 ms |
| Teardown | 179 to 193 ms |
| Complete three-site integration test command | 18.84 s |
| Sampled server RSS | 0.44 to 0.76 GiB |

The cold measurement temporarily moved the cached archive into an OS temporary
directory and restored it afterward. Its download time depends on the network.
With Playground's default six workers, cached startup took 6.22 to 6.71 seconds
and idle server RSS was about 2.12 GiB.

The installed Blockwork plugin also passed a desktop in-app browser roundtrip
on the one-worker fixture. Inspection took 4.44 seconds, preparation took
3.19 seconds, save with verified server readback took 4.98 seconds, and release
took 0.73 seconds. A fresh editor load confirmed both blocks were valid, the
second paragraph was unchanged, and publication status remained draft.
The existing five-second editor initialization limit was unchanged.

These native checks used the supported desktop CDP API, not the Node test runner.
These original checks established the fixture's suitability for the core
paragraph scenario. The later desktop suite extends that coverage as recorded
in [integration results](integration-results.md). RSS values are samples, not
peak measurements. All test tabs, servers, and temporary site files were
closed or removed after verification.
