# Source ledger

| Source                                                                        | Revision                                      | License                        | Inspection                                                        | Reuse                    |
| ----------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- | ------------------------ |
| [Cataloger](https://github.com/dakewamama/cataloger)                          | `24b8fc6b68b7cd352786c7995472dcaec9a4ab9c`    | No repository license declared | TARGETED SOURCE, EXECUTED LOCALLY                                 | PUBLIC API               |
| [Catalyst SDK](https://github.com/dakewamama/catalyst-sdk)                    | `0bfb3f57c2b4b9c22cf41d582573e8e60352be05`    | MIT package declaration        | TARGETED SOURCE, EXECUTED LOCALLY                                 | DEPEND through Cataloger |
| [Kit addresses](https://github.com/anza-xyz/kit/tree/main/packages/addresses) | `@solana/addresses` 8.4.0, npm lock integrity | MIT                            | TARGETED SOURCE of public types/codecs                            | DEPEND                   |
| [lossless-json](https://github.com/josdejong/lossless-json)                   | 4.3.1, npm lock integrity                     | MIT                            | TARGETED SOURCE of parse/stringify API and installed declarations | DEPEND                   |
| [Bun](https://bun.sh/docs/bundler/fullstack)                                  | 1.3.14 locally                                | MIT                            | Public HTML bundler/server documentation                          | PUBLIC API               |
| [Playwright](https://github.com/microsoft/playwright)                         | 1.64.0, npm lock integrity                    | Apache-2.0                     | Public test/viewport API                                          | DEPEND, development only |

No upstream implementation or fixture source is copied into this repository.
The launcher consumes the existing Cataloger fixture files through its CLI.
Their original source hashes, native execution revisions and account-selection
limits remain in Cataloger's fixture README. The runtime pins ARM 0.1 and the
executed adapter revision. The browser carries wire data, not another policy engine.

Preserved experience: account state and technical authority do not establish human
intent; administrative and direct spend power can survive independently; identical
principals do not imply independent budgets. Observation coverage remains separate
from deployment support. Lossless parsing preserves protocol integers without
inventing a browser-specific amount representation or token-decimal assumption.
