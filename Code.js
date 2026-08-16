/**
 * EGRPS Readable Email
 *
 * V1:
 * - Creates trigger/processed/error labels
 * - Stores a hard go-live timestamp
 * - Supports manually requesting conversion of old messages
 * - Verifies that a message authentically originated from egrps.org
 * - Finds likely PDF/document links
 * - Tracks individual Gmail message IDs
 * - Supports dry-run mode
 *
 * Automatic processing starts DISABLED.
 */

const CONFIG = {
  MANUAL_LABEL: 'EGRPS/Make Readable',
  PROCESSED_LABEL: 'EGRPS/Readable',
  ERROR_LABEL: 'EGRPS/Readable Error',

  DRY_RUN: false,

  // How far back the automatic Gmail SEARCH is allowed to look.
  // This is just an optimization/safety net; GO_LIVE_AT is authoritative.
  AUTO_SEARCH_DAYS: 30,

  // Limit how many threads one execution can inspect.
  MAX_THREADS_PER_RUN: 50,
  TEST_RECIPIENT: 'test@example.com',

  // Ignore tiny PDF-conversion artifacts by their rendered pixel area.
  MIN_IMAGE_AREA: 2000,

  // Include the source PDF alongside the readable HTML version.
  ATTACH_PDF: true,

  // Manual sends can be disabled independently. Automatic sends are
  // controlled by AUTO_ENABLED in Script Properties.
  SEND_MANUAL_TESTS: true,
};

// Conservative OCR/PDF extraction repairs. Each pattern is a recognizable
// word with its first letter missing; ambiguous words are intentionally
// omitted so legitimate content is not silently changed.
const MISSING_FIRST_LETTER_RULES = [
  { pattern: /\bchool(s)?\b/gi, letter: 's' },
  { pattern: /\btudent(s)?\b/gi, letter: 's' },
  { pattern: /\beacher(s)?\b/gi, letter: 't' },
  { pattern: /\bmportant\b/gi, letter: 'i' },
  { pattern: /\beminder(s)?\b/gi, letter: 'r' },
  { pattern: /\bttention\b/gi, letter: 'a' },
  { pattern: /\begistration\b/gi, letter: 'r' },
  { pattern: /\bnformation\b/gi, letter: 'i' },
  { pattern: /\bewsletter(s)?\b/gi, letter: 'n' },
  { pattern: /\bistrict(s)?\b/gi, letter: 'd' },
  { pattern: /\blementary\b/gi, letter: 'e' },
];


/**
 * RUN THIS ONCE FIRST.
 *
 * Safe to run repeatedly:
 * - creates labels if missing
 * - records GO_LIVE_AT only if it doesn't already exist
 * - defaults automatic mode to OFF
 */
function setup() {
  getOrCreateLabel_(CONFIG.MANUAL_LABEL);
  getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  getOrCreateLabel_(CONFIG.ERROR_LABEL);

  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty('GO_LIVE_AT')) {
    props.setProperty('GO_LIVE_AT', new Date().toISOString());
  }

  if (props.getProperty('AUTO_ENABLED') === null) {
    props.setProperty('AUTO_ENABLED', 'false');
  }

  console.log('=== EGRPS Readable setup ===');
  console.log(`GO_LIVE_AT: ${props.getProperty('GO_LIVE_AT')}`);
  console.log(`AUTO_ENABLED: ${props.getProperty('AUTO_ENABLED')}`);
  console.log(`DRY_RUN: ${CONFIG.DRY_RUN}`);
  console.log('');
  console.log(`Manual label: ${CONFIG.MANUAL_LABEL}`);
  console.log('');
  console.log('Setup complete.');
}


/**
 * Main entry point.
 *
 * This is what we'll eventually run every 5 minutes.
 */
function scan() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Another scan is already running; skipping this execution.');
    return;
  }

  try {
    console.log('==============================');
    console.log(`EGRPS scan started: ${new Date().toISOString()}`);
    console.log(`DRY_RUN: ${CONFIG.DRY_RUN}`);
    console.log('==============================');

    processManualRequests_();

    const props = PropertiesService.getScriptProperties();

    if (props.getProperty('AUTO_ENABLED') === 'true') {
      processAutomaticRequests_();
    } else {
      console.log('');
      console.log('Automatic processing is DISABLED.');
    }

    console.log('');
    console.log('Scan finished.');
  } finally {
    lock.releaseLock();
  }
}


/**
 * Processes threads on which you've manually applied:
 *
 *   EGRPS/Make Readable
 *
 * Manual mode deliberately ignores GO_LIVE_AT, allowing old emails
 * to be tested.
 */
function processManualRequests_() {
  console.log('');
  console.log('--- Manual requests ---');

  const query = `label:"${CONFIG.MANUAL_LABEL}"`;

  const threads = GmailApp.search(
    query,
    0,
    CONFIG.MAX_THREADS_PER_RUN
  );

  console.log(`Found ${threads.length} manually labeled thread(s).`);

  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const message of messages) {
      if (wasProcessed_(message)) {
        console.log(
          `Skipping already processed message: ${message.getSubject()}`
        );
        continue;
      }

      const inspection = inspectMessage_(message);

      // A labeled thread may contain unrelated messages,
      // so still require authenticated EGRPS origin.
      if (!inspection.isEgrps) {
        continue;
      }

      // Don't do anything unless there's a document-ish link.
      if (inspection.documentLinks.length === 0) {
        continue;
      }

      processCandidate_(message, inspection, {
        mode: 'MANUAL',
      });
    }
  }
}


/**
 * Automatic mode.
 *
 * Note the multiple layers of protection:
 *
 * 1. AUTO_ENABLED must explicitly be true.
 * 2. Gmail search only looks at recent messages.
 * 3. The exact message timestamp must be >= GO_LIVE_AT.
 * 4. Message must authenticate as egrps.org.
 * 5. Message must contain a probable document link.
 * 6. Message ID must not already be processed.
 */
function processAutomaticRequests_() {
  console.log('');
  console.log('--- Automatic requests ---');

  // Do not exclude PROCESSED_LABEL here. Gmail labels belong to threads,
  // so doing so could hide a new message added to an older processed thread.
  // Individual Gmail message IDs are the authoritative idempotency check.
  const query = `newer_than:${CONFIG.AUTO_SEARCH_DAYS}d`;

  const threads = GmailApp.search(
    query,
    0,
    CONFIG.MAX_THREADS_PER_RUN
  );

  console.log(`Automatic search returned ${threads.length} thread(s).`);

  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      if (!isAfterGoLive_(message)) {
        continue;
      }

      if (wasProcessed_(message)) {
        continue;
      }

      const inspection = inspectMessage_(message);

      if (!inspection.isEgrps) {
        continue;
      }

      if (inspection.documentLinks.length === 0) {
        continue;
      }

      processCandidate_(message, inspection, {
        mode: 'AUTOMATIC',
      });
    }
  }
}


/**
 * Inspects one Gmail message.
 *
 * No side effects.
 */
function inspectMessage_(message) {
  const raw = message.getRawContent();
  const headers = getRawHeaders_(raw);

  const authentication = inspectEgrpsAuthentication_(headers);

  const links = extractLinks_(message.getBody());

  const documentLinks = links.filter(isProbableDocumentLink_);

  return {
    isEgrps: authentication.isEgrps,
    authentication,
    links,
    documentLinks,
  };
}


/**
 * This is where PDF downloading/conversion will go next.
 *
 */
function processCandidate_(message, inspection, context) {
  console.log('');
  console.log('========================================');
  console.log(CONFIG.DRY_RUN ? 'WOULD PROCESS' : 'PROCESSING');
  console.log('========================================');
  console.log(`Mode:       ${context.mode}`);
  console.log(`Date:       ${message.getDate()}`);
  console.log(`Subject:    ${message.getSubject()}`);
  console.log(`From:       ${message.getFrom()}`);
  console.log(`Reply-To:   ${message.getReplyTo()}`);
  console.log(`Message ID: ${message.getId()}`);

  console.log('');
  console.log('Authentication:');

  for (const reason of inspection.authentication.reasons) {
    console.log(`  ✓ ${reason}`);
  }

  console.log('');
  console.log(
    `Found ${inspection.documentLinks.length} probable document link(s):`
  );

  inspection.documentLinks.forEach((link, index) => {
    console.log(`  ${index + 1}. ${link}`);
  });

  console.log('');
  console.log('--- Resolving documents ---');

  let lastError = null;

  for (const link of inspection.documentLinks) {
    try {
      const document = resolveDocument_(link);

      console.log('');
      console.log(`Document: ${document.name}`);
      console.log(`  Source:    ${document.source}`);
      console.log(`  MIME type: ${document.mimeType}`);
      console.log(`  Size:      ${formatBytes_(document.size)}`);
      console.log(`  PDF:       ${document.isPdf ? 'YES' : 'NO'}`);

      if (!document.isPdf) {
        console.log('  Skipping: resolved document is not a PDF.');
        continue;
      }

      console.log('');
      console.log('  --- Extracting PDF ---');

      const extraction = extractPdfViaGoogleDocs_(
        document.blob,
        document.name
      );

      console.log(
        `  Text characters: ${extraction.text.length}`
      );

      console.log(
        `  HTML characters: ${extraction.html.length}`
      );

      console.log(
        `  Included images: ${extraction.imageCount}`
      );

      console.log(
        `  Skipped tiny images: ${extraction.skippedImages}`
      );

      console.log(
        `  Failed images: ${extraction.failedImages}`
      );

      console.log('');
      console.log('  --- HTML preview ---');
      console.log(
        extraction.html.substring(0, 3000)
      );

      if (extraction.html.length > 3000) {
        console.log('  ...');
      }

      // Everything above here is safe inspection/extraction.

      if (CONFIG.DRY_RUN) {
        console.log('');
        console.log(
          'DRY RUN: no email sent; no processed state recorded.'
        );
        continue;
      }

      const sendingEnabled =
        context.mode === 'AUTOMATIC' ||
        (
          context.mode === 'MANUAL' &&
          CONFIG.SEND_MANUAL_TESTS
        );

      if (sendingEnabled) {
        sendReadableVersion_(
          message,
          document,
          extraction
        );

        markProcessed_(message);

        console.log('');
        console.log(
          `Readable email sent (${context.mode.toLowerCase()} mode).`
        );

        // One successful document is enough for this message
        // for now.
        return;
      }

      throw new Error('Sending is disabled for this processing mode.');

    } catch (error) {
      lastError = error;
      console.error('');
      console.error(`Failed to resolve/process: ${link}`);
      console.error(error);
    }
  }

  if (lastError) {
    markError_(message);
  }
}


/**
 * Determine whether the raw headers provide convincing evidence
 * that the ORIGINAL message authenticated as egrps.org.
 *
 * Important:
 *
 * Your Google Group changes the visible envelope sender, so checking
 * message.getFrom() is insufficient.
 *
 * We're looking only at the RAW HEADER SECTION, not message body text.
 */
function inspectEgrpsAuthentication_(headers) {
  const normalized = unfoldHeaders_(headers).toLowerCase();

  const reasons = [];

  // Example from your actual message:
  //
  // spf=pass (...) smtp.mailfrom=egrpsupdates@egrps.org
  //
  const spfPass =
    /spf=pass\b[^\r\n]*(?:smtp\.mailfrom=[^;\s]*@egrps\.org|spfdomain=egrps\.org)/i
      .test(normalized);

  if (spfPass) {
    reasons.push('SPF passed for egrps.org');
  }

  // Example:
  //
  // dkim=pass header.i=@egrps.org
  //
  const dkimPass =
    /dkim=pass\b[^\r\n]*header\.i=@egrps\.org/i
      .test(normalized);

  if (dkimPass) {
    reasons.push('DKIM passed for egrps.org');
  }

  // Example:
  //
  // dmarc=pass (...) header.from=egrps.org
  //
  const dmarcPass =
    /dmarc=pass\b[^\r\n]*header\.from=egrps\.org/i
      .test(normalized);

  if (dmarcPass) {
    reasons.push('DMARC passed for egrps.org');
  }

  // Also useful with your Google Group forwarding setup.
  const originalSender =
    /^x-original-sender:\s*[^@\r\n]+@egrps\.org$/im
      .test(normalized);

  if (originalSender) {
    reasons.push('X-Original-Sender is egrps.org');
  }

  /**
   * Require:
   *
   *   at least one cryptographic/authentication result
   *
   * X-Original-Sender alone does NOT qualify a message.
   */
  const isEgrps = spfPass || dkimPass || dmarcPass;

  return {
    isEgrps,
    spfPass,
    dkimPass,
    dmarcPass,
    originalSender,
    reasons,
  };
}


/**
 * Extract only the RFC822 headers from raw message content.
 *
 * This is important so text appearing in the email body cannot
 * accidentally satisfy our authentication checks.
 */
function getRawHeaders_(rawMessage) {
  const match = rawMessage.match(/^([\s\S]*?)\r?\n\r?\n/);

  if (!match) {
    return rawMessage;
  }

  return match[1];
}


/**
 * RFC822 headers can wrap onto subsequent lines.
 *
 * Turn:
 *
 * Authentication-Results: blah blah
 *     spf=pass ...
 *
 * into one logical line.
 */
function unfoldHeaders_(headers) {
  return headers.replace(/\r?\n[ \t]+/g, ' ');
}


/**
 * Extract hyperlinks from Gmail's HTML body.
 *
 * We are NOT looking only for ".pdf" endings, because your example
 * is a Google Drive /file/d/.../view URL.
 */
function extractLinks_(html) {
  const links = [];
  const regex = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    let url = decodeHtmlEntities_(match[2]).trim();

    if (!/^https?:\/\//i.test(url)) {
      continue;
    }

    if (!links.includes(url)) {
      links.push(url);
    }
  }

  return links;
}


/**
 * Things we currently consider worth inspecting as documents.
 *
 * This is intentionally permissive. In V2 we'll actually fetch the
 * URL and verify the returned MIME type.
 */
function isProbableDocumentLink_(url) {
  const lower = url.toLowerCase();

  // Direct PDF
  if (/\.pdf(?:[?#]|$)/i.test(lower)) {
    return true;
  }

  // Google Drive file
  if (/^https:\/\/drive\.google\.com\/file\/d\//i.test(lower)) {
    return true;
  }

  // Alternate Drive sharing/download forms
  if (/^https:\/\/drive\.google\.com\/open\?/i.test(lower)) {
    return true;
  }

  if (/^https:\/\/docs\.google\.com\//i.test(lower)) {
    return true;
  }

  return false;
}


/**
 * Enough decoding for href attributes returned by Gmail.
 */
function decodeHtmlEntities_(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}


/**
 * Hard automatic-processing boundary.
 */
function isAfterGoLive_(message) {
  const value =
    PropertiesService
      .getScriptProperties()
      .getProperty('GO_LIVE_AT');

  if (!value) {
    // Fail closed.
    console.log(
      'GO_LIVE_AT is missing. Automatic processing refused.'
    );

    return false;
  }

  const goLive = new Date(value);

  return message.getDate().getTime() >= goLive.getTime();
}


/**
 * Individual-message idempotency.
 *
 * We deliberately don't rely solely on Gmail thread labels.
 */
function wasProcessed_(message) {
  const key = processedKey_(message);

  return (
    PropertiesService
      .getScriptProperties()
      .getProperty(key) !== null
  );
}


function markProcessed_(message) {
  PropertiesService
    .getScriptProperties()
    .setProperty(
      processedKey_(message),
      new Date().toISOString()
    );

  getOrCreateLabel_(CONFIG.PROCESSED_LABEL)
    .addToThread(message.getThread());

  const errorLabel = GmailApp.getUserLabelByName(CONFIG.ERROR_LABEL);

  if (errorLabel) {
    errorLabel.removeFromThread(message.getThread());
  }
}


function markError_(message) {
  getOrCreateLabel_(CONFIG.ERROR_LABEL)
    .addToThread(message.getThread());
}


function processedKey_(message) {
  return `processed:${message.getId()}`;
}


/**
 * Explicit switch for automatic mode.
 *
 * Automatic candidates will be sent when DRY_RUN is false.
 */
function enableAutomatic() {
  PropertiesService
    .getScriptProperties()
    .setProperty('AUTO_ENABLED', 'true');

  console.log('Automatic processing ENABLED.');
}


/**
 * Emergency/off switch.
 */
function disableAutomatic() {
  PropertiesService
    .getScriptProperties()
    .setProperty('AUTO_ENABLED', 'false');

  console.log('Automatic processing DISABLED.');
}


/**
 * Optional recurring scanner.
 *
 * Automatic mode defaults OFF. Check status() before installing.
 */
function installFiveMinuteTrigger() {
  // Avoid creating duplicates if you run this repeatedly.
  const existing = ScriptApp
    .getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'scan');

  if (existing.length > 0) {
    console.log('scan() trigger already exists.');
    return;
  }

  ScriptApp
    .newTrigger('scan')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log('Installed 5-minute scan() trigger.');
}


/**
 * Removes ONLY this project's scan() triggers.
 */
function removeScanTriggers() {
  const triggers = ScriptApp.getProjectTriggers();

  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'scan') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  console.log('Removed scan() triggers.');
}


/**
 * Helper.
 */
function getOrCreateLabel_(name) {
  return (
    GmailApp.getUserLabelByName(name) ||
    GmailApp.createLabel(name)
  );
}


/**
 * Useful diagnostic function.
 *
 * Shows current safety state without doing any Gmail searching.
 */
function status() {
  const props = PropertiesService.getScriptProperties();

  console.log('=== EGRPS Readable status ===');
  console.log(`DRY_RUN:      ${CONFIG.DRY_RUN}`);
  console.log(`RECIPIENT:    ${CONFIG.TEST_RECIPIENT}`);
  console.log(`ATTACH_PDF:   ${CONFIG.ATTACH_PDF}`);
  console.log(`MIN_IMG_AREA: ${CONFIG.MIN_IMAGE_AREA}`);
  console.log(`GO_LIVE_AT:   ${props.getProperty('GO_LIVE_AT')}`);
  console.log(`AUTO_ENABLED: ${props.getProperty('AUTO_ENABLED')}`);

  const scanTriggers = ScriptApp
    .getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'scan');

  console.log(`scan() triggers: ${scanTriggers.length}`);
}

/**
 * Resolve a document URL into an actual binary Blob plus metadata.
 *
 * Currently supports:
 * - Google Drive /file/d/... URLs
 * - direct HTTP(S) URLs
 */
function resolveDocument_(url) {
  const driveId = extractGoogleDriveFileId_(url);

  if (driveId) {
    return resolveGoogleDriveDocument_(driveId, url);
  }

  return resolveWebDocument_(url);
}


/**
 * Extract the file ID from common Google Drive URL forms.
 */
function extractGoogleDriveFileId_(url) {
  // https://drive.google.com/file/d/FILE_ID/view
  let match = url.match(
    /^https:\/\/drive\.google\.com\/file\/d\/([^/?#]+)/i
  );

  if (match) {
    return match[1];
  }

  // https://drive.google.com/open?id=FILE_ID
  match = url.match(/[?&]id=([^&#]+)/i);

  if (match && /drive\.google\.com/i.test(url)) {
    return decodeURIComponent(match[1]);
  }

  return null;
}


/**
 * Fetch a Google Drive file using the account running this script.
 */
function resolveGoogleDriveDocument_(fileId, originalUrl) {
  const file = DriveApp.getFileById(fileId);

  const mimeType = file.getMimeType();
  const blob = file.getBlob();

  return {
    source: 'Google Drive',
    sourceUrl: originalUrl,
    fileId,

    name: file.getName(),
    mimeType,
    size: blob.getBytes().length,

    isPdf: mimeType === MimeType.PDF,

    blob,
  };
}


/**
 * Fallback for ordinary web URLs.
 *
 * We'll eventually make this smarter about redirects/content-disposition,
 * but this is sufficient for basic direct PDF links.
 */
function resolveWebDocument_(url) {
  const response = UrlFetchApp.fetch(url, {
    followRedirects: true,
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();

  if (status < 200 || status >= 300) {
    throw new Error(
      `HTTP ${status} while downloading ${url}`
    );
  }

  const blob = response.getBlob();

  const mimeType =
    normalizeMimeType_(blob.getContentType()) ||
    normalizeMimeType_(
      getHeaderCaseInsensitive_(
        response.getAllHeaders(),
        'Content-Type'
      )
    );

  return {
    source: 'Web',
    sourceUrl: url,

    name: inferFilename_(url, response),
    mimeType,
    size: blob.getBytes().length,

    isPdf:
      mimeType === 'application/pdf' ||
      /\.pdf(?:[?#]|$)/i.test(url),

    blob,
  };
}


function normalizeMimeType_(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .split(';')[0]
    .trim()
    .toLowerCase();
}


function getHeaderCaseInsensitive_(headers, name) {
  const target = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }

  return null;
}


function inferFilename_(url, response) {
  const disposition = getHeaderCaseInsensitive_(
    response.getAllHeaders(),
    'Content-Disposition'
  );

  if (disposition) {
    const match = String(disposition).match(
      /filename\*?=(?:UTF-8''|["']?)([^"';]+)/i
    );

    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch (_) {
        return match[1];
      }
    }
  }

  try {
    const path = new URL(url).pathname;
    const filename = path.split('/').pop();

    if (filename) {
      return decodeURIComponent(filename);
    }
  } catch (_) {
    // Ignore URL parsing failure.
  }

  return 'document';
}


function formatBytes_(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function safeGetImageDimension_(getter) {
  try {
    return getter();
  } catch (_) {
    return null;
  }
}

/**
 * Convert a PDF to a temporary Google Doc, render its content,
 * then trash the temporary document.
 */
function extractPdfViaGoogleDocs_(pdfBlob, originalName) {
  let tempDocId = null;

  try {
    const metadata = {
      name: `[TEMP] ${originalName}`,
      mimeType: 'application/vnd.google-apps.document',
    };

    const created = Drive.Files.create(
      metadata,
      pdfBlob,
      {
        fields: 'id,name,mimeType',
      }
    );

    tempDocId = created.id;

    console.log(`  Temporary Google Doc: ${created.name}`);
    console.log(`  Temporary Doc ID: ${tempDocId}`);

    Utilities.sleep(1000);

    const doc = DocumentApp.openById(tempDocId);
    const body = doc.getBody();

    const rendering = renderGoogleDocToHtml_(body);

    return {
      text: body.getText(),
      html: rendering.html,
      inlineImages: rendering.inlineImages,
      imageCount: rendering.imageCount,
      skippedImages: rendering.skippedImages,
      failedImages: rendering.failedImages,
    };

  } finally {
    if (tempDocId) {
      try {
        DriveApp
          .getFileById(tempDocId)
          .setTrashed(true);

        console.log('  Temporary Google Doc trashed.');
      } catch (cleanupError) {
        console.error(
          `  WARNING: Could not trash temp Doc ${tempDocId}: ${cleanupError}`
        );
      }
    }
  }
}

function renderGoogleDocToHtml_(body) {
  const state = {
    inlineImages: {},
    imageCount: 0,
    skippedImages: 0,
    failedImages: 0,
    nextImageId: 1,
  };

  const parts = [];
  let textBuffer = [];

  function flushTextBuffer() {
    if (textBuffer.length === 0) {
      return;
    }

    const text = textBuffer
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) {
      parts.push(`
        <p style="
          font-family:Arial,sans-serif;
          font-size:16px;
          line-height:1.5;
          margin:0 0 16px;
        ">${escapeHtml_(text)}</p>
      `);
    }

    textBuffer = [];
  }

  for (let i = 0; i < body.getNumChildren(); i++) {
    const element = body.getChild(i);
    const type = element.getType();

    if (type === DocumentApp.ElementType.PARAGRAPH) {
      const paragraph = element.asParagraph();
      const text = cleanupExtractedText_(paragraph.getText()).trim();

      const heading = paragraph.getHeading();

      const isHeading =
        heading !== DocumentApp.ParagraphHeading.NORMAL;

      const isAllCapsHeading = isAllCapsHeading_(text);

      const hasImage = paragraphContainsImage_(paragraph);

      // Blank paragraph = meaningful separation.
      if (!text && !hasImage) {
        flushTextBuffer();
        continue;
      }

      // Headings and image-containing paragraphs keep their
      // own structural position.
      if (isHeading || isAllCapsHeading || hasImage) {
        flushTextBuffer();

        parts.push(
          renderParagraph_(
            paragraph,
            state,
            isAllCapsHeading
          )
        );

        continue;
      }

      // Ordinary PDF text line.
      if (text) {
        textBuffer.push(text);

        /**
         * Google PDF conversion frequently creates one paragraph
         * per VISUAL line.
         *
         * Ending a buffer when a line appears to end a complete
         * sentence gives us decent semantic paragraphs without
         * preserving 8.5x11 line wrapping.
         *
         * Require a little content first so things like:
         *
         *   Go East!
         *
         * don't cause pathological behavior.
         */
        const bufferedLength =
          textBuffer.join(' ').length;

        if (
          bufferedLength >= 120 &&
          /[.!?]["'”’)]?$/.test(text)
        ) {
          flushTextBuffer();
        }
      }

      continue;
    }

    // Anything structural ends the current prose block.
    flushTextBuffer();

    parts.push(
      renderDocElement_(element, state)
    );
  }

  flushTextBuffer();

  return {
    html: parts.join('\n'),
    inlineImages: state.inlineImages,
    imageCount: state.imageCount,
    skippedImages: state.skippedImages,
    failedImages: state.failedImages,
  };
}

function renderDocElement_(element, state) {
  const type = element.getType();

  switch (type) {

    case DocumentApp.ElementType.PARAGRAPH:
      return renderParagraph_(
        element.asParagraph(),
        state
      );

    case DocumentApp.ElementType.LIST_ITEM:
      return renderListItem_(
        element.asListItem(),
        state
      );

    case DocumentApp.ElementType.TABLE:
      return renderTable_(
        element.asTable(),
        state
      );

    case DocumentApp.ElementType.INLINE_IMAGE:
      return renderInlineImage_(
        element.asInlineImage(),
        state
      );

    case DocumentApp.ElementType.HORIZONTAL_RULE:
      return `
        <hr style="
          border:0;
          border-top:1px solid #ddd;
          margin:24px 0;
        ">
      `;

    case DocumentApp.ElementType.PAGE_BREAK:
      // Page boundaries are irrelevant in the email version.
      return '';

    default:
      return renderChildren_(element, state);
  }
}

function renderParagraph_(paragraph, state, forceHeading) {
  const content = renderChildren_(paragraph, state)
    .replace(/\s+/g, ' ')
    .trim();

  if (!content) {
    return '';
  }

  const heading = paragraph.getHeading();

  const headingMap = {};

  headingMap[DocumentApp.ParagraphHeading.TITLE] = 'h1';
  headingMap[DocumentApp.ParagraphHeading.HEADING1] = 'h1';
  headingMap[DocumentApp.ParagraphHeading.HEADING2] = 'h2';
  headingMap[DocumentApp.ParagraphHeading.HEADING3] = 'h3';
  headingMap[DocumentApp.ParagraphHeading.HEADING4] = 'h4';
  headingMap[DocumentApp.ParagraphHeading.HEADING5] = 'h5';
  headingMap[DocumentApp.ParagraphHeading.HEADING6] = 'h6';

  const tag = headingMap[heading] || (forceHeading ? 'h2' : null);

  if (tag) {
    return `
      <${tag} style="
        font-family:Arial,sans-serif;
        line-height:1.25;
        margin:24px 0 10px;
      ">${content}</${tag}>
    `;
  }

  return `
    <p style="
      font-family:Arial,sans-serif;
      font-size:16px;
      line-height:1.5;
      margin:0 0 16px;
    ">${content}</p>
  `;
}

function renderText_(textElement) {
  const text = cleanupExtractedText_(textElement.getText());

  if (!text) {
    return '';
  }

  // For V1, preserve content, not typography.
  return escapeHtml_(text);
}

function cleanupExtractedText_(value) {
  let text = String(value || '');

  // Google PDF conversion sometimes joins camel-cased words together.
  text = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  for (const rule of MISSING_FIRST_LETTER_RULES) {
    text = text.replace(rule.pattern, match => {
      const prefix =
        match === match.toUpperCase()
          ? rule.letter.toUpperCase()
          : rule.letter;

      return `${prefix}${match}`;
    });
  }

  // Preserve one leading/trailing space when it separates adjacent styled
  // text runs. The paragraph renderer trims the completed content.
  return text.replace(/\s+/g, ' ');
}

function isAllCapsHeading_(text) {
  if (!text || text.length > 120 || /[a-z]/.test(text)) {
    return false;
  }

  const letters = text.match(/[A-Z]/g);

  return Boolean(letters && letters.length >= 3);
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineImage_(image, state) {
  try {
    const width = safeGetImageDimension_(
      () => image.getWidth()
    );

    const height = safeGetImageDimension_(
      () => image.getHeight()
    );

    // Throw away the weird 2px PDF layout artifacts.
    if (
      width &&
      height &&
      width * height < CONFIG.MIN_IMAGE_AREA
    ) {
      state.skippedImages++;
      return '';
    }

    const blob = image.getBlob();

    const cid = `egrpsImage${state.nextImageId++}`;

    state.inlineImages[cid] = blob;
    state.imageCount++;

    return `
      <div style="
        margin:20px 0;
        text-align:center;
      ">
        <img
          src="cid:${cid}"
          style="
            display:block;
            max-width:100%;
            height:auto;
            margin:0 auto;
          "
        >
      </div>
    `;

  } catch (error) {
    state.failedImages++;

    console.warn(
      `Could not render image: ${error}`
    );

    return '';
  }
}

function renderListItem_(item, state) {
  const content = renderChildren_(item, state).trim();

  if (!content) {
    return '';
  }

  return `
    <div style="
      font-family:Arial,sans-serif;
      font-size:16px;
      line-height:1.5;
      margin:4px 0 4px 20px;
    ">
      • ${content}
    </div>
  `;
}

function renderTable_(table, state) {
  const rows = [];

  for (let r = 0; r < table.getNumRows(); r++) {
    const row = table.getRow(r);
    const cells = [];

    for (let c = 0; c < row.getNumCells(); c++) {
      const cell = row.getCell(c);

      cells.push(`
        <td style="
          vertical-align:top;
          padding:8px;
          border:1px solid #ddd;
          font-family:Arial,sans-serif;
          font-size:15px;
          line-height:1.4;
        ">
          ${renderChildren_(cell, state)}
        </td>
      `);
    }

    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  return `
    <table
      role="presentation"
      width="100%"
      cellspacing="0"
      cellpadding="0"
      style="
        border-collapse:collapse;
        margin:20px 0;
        width:100%;
      "
    >
      ${rows.join('\n')}
    </table>
  `;
}

function renderChildren_(element, state) {
  if (
    typeof element.getNumChildren !== 'function' ||
    typeof element.getChild !== 'function'
  ) {
    if (element.getType() === DocumentApp.ElementType.TEXT) {
      return renderText_(element.asText());
    }

    return '';
  }

  const parts = [];

  for (let i = 0; i < element.getNumChildren(); i++) {
    const child = element.getChild(i);

    if (child.getType() === DocumentApp.ElementType.TEXT) {
      parts.push(
        renderText_(child.asText())
      );

    } else if (
      child.getType() === DocumentApp.ElementType.INLINE_IMAGE
    ) {
      parts.push(
        renderInlineImage_(
          child.asInlineImage(),
          state
        )
      );

    } else {
      parts.push(
        renderDocElement_(child, state)
      );
    }
  }

  return parts.join('');
}

function paragraphContainsImage_(paragraph) {
  for (let i = 0; i < paragraph.getNumChildren(); i++) {
    if (
      paragraph.getChild(i).getType() ===
      DocumentApp.ElementType.INLINE_IMAGE
    ) {
      return true;
    }
  }

  return false;
}

function sendReadableVersion_(message, document, extraction) {
  const recipient = CONFIG.TEST_RECIPIENT;

  const subject = message.getSubject();

  const originalUrl = escapeHtml_(document.sourceUrl);

  const html = `
    <div style="
      max-width:700px;
      margin:0 auto;
      font-family:Arial,sans-serif;
      color:#222;
    ">

      <div style="
        background:#f4f6f8;
        border:1px solid #ddd;
        border-radius:8px;
        padding:16px;
        margin-bottom:24px;
        font-size:14px;
        line-height:1.5;
      ">
        <strong>Readable version generated automatically</strong>
        <br>
        This email has been reformatted from an EGRPS PDF
        for easier reading and searching.
        <br><br>

        <a
          href="${originalUrl}"
          style="
            display:inline-block;
            padding:8px 12px;
            background:#333;
            color:#fff;
            text-decoration:none;
            border-radius:4px;
          "
        >
          View original PDF
        </a>
      </div>

      ${extraction.html}

      <hr style="
        border:0;
        border-top:1px solid #ddd;
        margin:32px 0 16px;
      ">

      <div style="
        font-size:12px;
        color:#777;
        line-height:1.4;
      ">
        Automatically reformatted from:
        ${escapeHtml_(document.name)}
      </div>

    </div>
  `;

  const plainText =
    `Readable version of ${message.getSubject()}\n\n` +
    `Original PDF: ${document.sourceUrl}\n\n` +
    extraction.text;

  const options = {
    subject,
    htmlBody: html,
    inlineImages: extraction.inlineImages,
  };

  if (CONFIG.ATTACH_PDF) {
    options.attachments = [
      document.blob.copyBlob().setName(document.name),
    ];
  }

  message.forward(recipient, options);
}
