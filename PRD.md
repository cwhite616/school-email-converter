# PRD: Readable Mail

Overview

Readable Mail is a Google Apps Script that automatically transforms PDF-centric emails into searchable, mobile-friendly HTML emails.

Many organizations (schools, municipalities, HOAs, employers, etc.) send emails whose body contains little more than a link to a PDF. While printable, these emails are difficult to read on phones and nearly impossible to search in Gmail because the important content exists only inside the linked document.

Readable Mail creates a companion email that preserves the original document while presenting its contents in a format optimized for email.

⸻

Problem Statement

Users receive important information in linked PDF documents that are:

* Difficult to read on mobile devices
* Not searchable using Gmail search
* Slow to skim
* Often require multiple taps to open
* Poorly suited to accessibility features

The original PDF should remain available, but users should not have to rely on it for everyday reading.

⸻

Goals

The system should:

* Detect qualifying emails automatically.
* Download linked PDFs.
* Convert PDFs into responsive HTML.
* Preserve important images.
* Produce searchable Gmail messages.
* Keep the original PDF available.
* Require little or no user interaction after setup.

⸻

Non-Goals

Version 1 will not attempt to:

* Perfectly reproduce PDF layout
* Preserve fonts or typography
* Recreate complex multi-column layouts
* Edit or replace the original email
* Process every PDF ever received

⸻

Primary Use Case

A school district emails:

“Please see the attached newsletter.”

with only a Google Drive PDF link.

Readable Mail automatically generates:

* a readable HTML version
* embedded images
* searchable text
* a link to the original PDF

which is delivered back into the user’s inbox.

⸻

Functional Requirements

Email Detection

The system shall:

* periodically scan Gmail
* detect qualifying emails
* ignore already processed messages
* support manual processing of historical emails

Qualification should be configurable but initially includes:

* authenticated sender domain (egrps.org)
* at least one PDF or Google Drive document link

⸻

Manual Trigger

Users may apply a Gmail label (for example EGRPS/Make Readable) to request processing of any message, regardless of age.

This enables testing and historical conversion.

⸻

Automatic Trigger

Automatic processing shall:

* operate only after an explicit enable action
* ignore messages received before the configured go-live timestamp
* process only new qualifying emails

⸻

PDF Acquisition

The system shall support:

* Google Drive file links
* direct PDF URLs

The downloaded PDF should remain available for later attachment or linking.

⸻

PDF Conversion

Version 1 converts PDFs into temporary Google Docs in order to extract:

* text
* images
* document structure

Temporary conversion documents are automatically deleted after processing.

⸻

HTML Generation

Generated HTML should:

* be responsive
* be readable on phones
* merge wrapped PDF lines into natural paragraphs
* preserve lists
* preserve tables where practical
* embed useful images
* discard tiny decorative artifacts

The HTML is optimized for readability rather than visual fidelity.

⸻

Generated Email

Generated emails include:

* original subject (optionally with a readable indicator)
* explanation that the email was automatically reformatted
* prominent link to the original PDF
* responsive HTML body
* inline images

⸻

Processing Safety

The system shall include multiple safeguards:

* manual trigger label
* processed tracking
* configurable go-live timestamp
* automatic processing disabled by default
* per-message idempotency
* error handling and logging

⸻

User Experience

The generated email should feel like a normal email rather than a PDF viewer.

Users should be able to:

* skim quickly
* search Gmail for document contents
* read comfortably on a phone
* open the original PDF when desired

⸻

Future Enhancements

Content Improvements

* Better heading detection
* Better paragraph reconstruction
* Table improvements
* Automatic table of contents
* Better image placement
* Caption preservation

⸻

Configuration

Support configurable processing rules such as:

* sender domains
* subject matching
* attachment types
* PDF size limits

⸻

AI Enhancements

Optional AI-powered features:

* summarize newsletters
* extract dates
* extract action items
* highlight deadlines
* identify school supply lists
* generate navigation links

⸻

Additional Sources

Support:

* PDF attachments
* Microsoft Office documents
* HTML newsletters
* Image-based PDFs via OCR

⸻

Architecture Evolution

Version 1

Single Google Apps Script.

Responsibilities:

* Gmail scanning
* PDF retrieval
* PDF conversion
* HTML generation
* Email forwarding

Version 2

Split into two components.

Apps Script:

* Gmail integration
* triggers
* labels
* forwarding

Backend service (Go):

* document parsing
* HTML generation
* image processing
* AI integrations
* rendering pipeline

This separation allows richer document processing while keeping Gmail integration simple.

⸻

Success Metrics

* Manual processing succeeds on representative historical emails.
* Automatic processing correctly ignores historical messages.
* Generated emails are searchable in Gmail.
* Generated emails are substantially easier to read on mobile devices than the original PDFs.
* Images and major document structure are preserved well enough that users prefer the generated version for day-to-day reading while retaining the original PDF as the authoritative source.
