# EGRPS Readable Email

EGRPS Readable Email is a personal Google Apps Script that turns PDF-centric school emails into searchable, mobile-friendly email.

Some school messages contain little useful text in the email itself and put the actual information in a linked Google Drive PDF. That makes the message awkward to read on a phone and prevents Gmail from searching the document's contents. This script finds those messages, converts the linked PDF through Google Docs, and forwards a readable HTML version—with text and useful images—back to a configured inbox.

The original message and PDF are left unchanged.

## Current status

This project supports both manually requested conversions and automatic scanning.

- Manual processing works for messages labeled `EGRPS/Make Readable`.
- Manual results are sent to `CONFIG.TEST_RECIPIENT` when `SEND_MANUAL_TESTS` is `true` and `DRY_RUN` is `false`.
- Automatic scanning and sending must be explicitly enabled through `enableAutomatic()`.
- Only PDFs linked from the HTML message body are handled. PDF attachments are not yet supported.

Review the configuration in `Code.js` before running the project. In particular, replace the personal `TEST_RECIPIENT` value with your own email address.

## How it works

1. `scan()` searches for manually labeled messages and, when enabled, recent automatic candidates.
2. The script checks the message's raw authentication headers for a successful SPF, DKIM, or DMARC result from `egrps.org`. The visible From address alone is not trusted.
3. It extracts likely Google Drive or direct PDF links from the message body.
4. It downloads the PDF and temporarily converts it to a Google Doc using the Advanced Drive service.
5. It cleans common extraction artifacts, including joined camel-case words, repeated whitespace, and a conservative list of recognizable missing-first-letter words.
6. It renders the converted document as responsive HTML, preserving text, headings, lists, tables, and useful inline images where possible. Short ALL-CAPS paragraphs are treated as headings.
7. It trashes the temporary Google Doc and forwards the readable result with a link to—and optionally an attachment of—the original PDF.
8. It records the Gmail message ID in Script Properties and applies `EGRPS/Readable`, preventing duplicate processing. A script lock prevents overlapping trigger executions.

PDF conversion is approximate. The goal is comfortable reading and Gmail searchability, not exact reproduction of the original page layout.

## Requirements

- A Google account with access to the Gmail messages and linked Drive files
- A Google Apps Script project
- [Node.js](https://nodejs.org/) and [`clasp`](https://github.com/google/clasp) for local development
- The Apps Script Advanced Drive service, configured in `appsscript.json`

The first run will request authorization for Gmail, Drive, external URL fetching, document conversion, and trigger management. Read the requested permissions before approving them; the script operates against the account under which it is authorized.

## Setup

Install and authenticate `clasp` if needed:

```sh
npm install --global @google/clasp
clasp login
```

This checkout is already connected to an Apps Script project through `.clasp.json`. Push the local files and open the project:

```sh
clasp push
clasp open
```

Before running anything, edit `CONFIG` near the top of `Code.js`:

```js
const CONFIG = {
  // ...
  DRY_RUN: true,
  TEST_RECIPIENT: 'you@example.com',
  SEND_MANUAL_TESTS: true,
};
```

Starting with `DRY_RUN: true` is recommended. In dry-run mode, candidate documents are inspected and converted, but no message is sent and no processed state is recorded.

In the Apps Script editor, run `setup()` once. It safely:

- creates the `EGRPS/Make Readable`, `EGRPS/Readable`, and `EGRPS/Readable Error` labels if needed;
- records the current time as `GO_LIVE_AT`; and
- initializes automatic processing as disabled.

Approve the requested permissions, then run `status()` and inspect the execution log to confirm the safety state.

## Try a manual conversion

1. In Gmail, apply the `EGRPS/Make Readable` label to a thread containing an authenticated EGRPS email with a linked PDF.
2. With `DRY_RUN: true`, run `scan()` from the Apps Script editor.
3. Review the execution log, including the detected authentication result, document metadata, extraction counts, and HTML preview.
4. Set `DRY_RUN` to `false`, push the change with `clasp push`, and run `scan()` again when ready to send a test.

A successful manual conversion forwards a message with the original subject to `TEST_RECIPIENT`, records the source message as processed, and applies the `EGRPS/Readable` label to its thread. By default, the original PDF is attached as well as linked from the readable body.

The manual label works for older mail and intentionally ignores `GO_LIVE_AT`. A thread can contain several messages; each message is checked and tracked separately.

## Scheduled scans and safety controls

Run `installFiveMinuteTrigger()` to create a time-based trigger for `scan()`. Re-running it will not create duplicates. Run `removeScanTriggers()` to remove this project's `scan()` triggers.

Automatic candidate discovery is off by default:

- `enableAutomatic()` enables it.
- `disableAutomatic()` disables it.
- `GO_LIVE_AT` prevents automatic processing of messages older than the initial setup time.
- `AUTO_SEARCH_DAYS` limits the search window.
- `MAX_THREADS_PER_RUN` limits work per execution.
- per-message Script Properties provide idempotency independently of thread labels.

When `AUTO_ENABLED` is `true` and `DRY_RUN` is `false`, qualifying automatic candidates are sent to `TEST_RECIPIENT`. Run a dry-run scan first and verify that address before enabling automatic mode.

To activate automatic delivery after completing the manual dry-run test:

1. Confirm `TEST_RECIPIENT` is the inbox that should receive readable messages.
2. Set `DRY_RUN` to `false` and run `clasp push`.
3. Run `enableAutomatic()` in the Apps Script editor.
4. Run `installFiveMinuteTrigger()`.
5. Run `status()` and confirm the recipient, `AUTO_ENABLED: true`, and exactly one `scan()` trigger.

Use `disableAutomatic()` as the immediate off switch. The installed trigger may remain in place; it will continue handling manual labels but skip automatic candidates until automatic mode is enabled again.

## Configuration

The main settings are in `CONFIG` in `Code.js`:

| Setting | Purpose |
| --- | --- |
| `MANUAL_LABEL` | Requests conversion of a Gmail thread |
| `PROCESSED_LABEL` | Marks a thread containing a successfully processed message |
| `ERROR_LABEL` | Marks a thread when all candidate links for a message fail to process |
| `DRY_RUN` | Prevents sending and processed-state writes when `true` |
| `AUTO_SEARCH_DAYS` | Limits how far back automatic Gmail searches look |
| `MAX_THREADS_PER_RUN` | Caps threads inspected during one execution |
| `TEST_RECIPIENT` | Address that receives manual and automatic readable messages |
| `MIN_IMAGE_AREA` | Minimum converted-image area in pixels; smaller artifacts are discarded |
| `ATTACH_PDF` | Attaches the original PDF to the readable email when `true` |
| `SEND_MANUAL_TESTS` | Allows manual-mode sending when dry run is off |

`GO_LIVE_AT`, `AUTO_ENABLED`, and processed message IDs are stored in Apps Script Script Properties rather than source control.

## Supported inputs

Currently recognized candidate links include:

- `drive.google.com/file/d/...`
- `drive.google.com/open?id=...`
- `docs.google.com/...` links, which are inspected and accepted only if they resolve as PDFs
- direct HTTP(S) URLs ending in `.pdf`

Drive links are fetched with the account running the script, so that account must have permission to open the file. Direct web links must return a successful response and PDF content (or have a `.pdf` URL).

## Development workflow

Pull remote editor changes before local work, and push local changes when ready:

```sh
clasp pull
clasp push
```

Useful Apps Script entry points:

| Function | Use |
| --- | --- |
| `setup()` | Create labels and initialize safety properties |
| `status()` | Print the current dry-run, go-live, automatic, and trigger state |
| `scan()` | Process manual requests and inspect automatic candidates when enabled |
| `installFiveMinuteTrigger()` | Schedule `scan()` every five minutes |
| `removeScanTriggers()` | Remove scheduled `scan()` triggers |
| `enableAutomatic()` | Enable automatic candidate discovery |
| `disableAutomatic()` | Disable automatic candidate discovery |

Functions ending in `_` are internal helpers and are not intended to be run directly.

## Limitations and planned work

- Provide clearer failure reporting in the generated email or a dedicated log.
- Accept PDFs attached to incoming messages, in addition to linked PDFs, and support additional document types.
- Improve paragraph, heading, list, table, and image reconstruction.
- Add OCR for image-only PDFs.
- Make sender domains and matching rules configurable.

See [PRD.md](PRD.md) for the broader product goals and possible future architecture.

## Privacy and security

This is a personal automation with broad access to Gmail and Drive. Keep `.clasp.json` and the Apps Script project under appropriate access controls, verify the recipient before disabling dry-run mode, and review logs for document names or message metadata before sharing them. Temporary Google Docs are moved to trash after extraction; if cleanup fails, the execution log includes the temporary document ID for manual removal.
