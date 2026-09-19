# Google Workspace verification packet

Prepared 2026-09-19 in `agent/google-oauth-audit-0919`. This is a review candidate,
not a submitted or approved application. Public activation remains source-deferred.

## Console state and prepared fields

Project `starnet-505202`; branding verified and published. Data access unverified.
The preparation page explicitly reports missing intended data usage and demo video.
The Data Access form now has **Drive productivity** and **Email productivity** selected
and revised scope justifications entered. These are **unsaved form changes**: Google's
Save button remains disabled without the YouTube URL. No dummy URL was supplied.

The form is at https://console.cloud.google.com/auth/scopes;verificationMode=true?project=starnet-505202

### Sensitive-scope justification

StarNet is a desktop productivity assistant. Each Google service is connected separately after an in-app data-use disclosure. Calendar event read access supports user-requested scheduling summaries; calendar list and free/busy permissions alone cannot read event details. Docs and Sheets scopes support reading and editing existing documents/spreadsheets identified by the user, plus creating new ones. Read-only scopes cannot perform those edits. The review candidate requests drive.file for its minimal account probe; Docs and Sheets no longer request drive.readonly. Tool content may enter local conversations and requests to the selected model provider; StarNet Credits also relays those requests through its gateway. Public Workspace activation remains deferred pending verification.

### Drive justification

The separate Drive connector supports user-requested file search, metadata reading and text export of existing Drive files. drive.readonly is needed because drive.file alone cannot search/read existing files that have not previously been opened with StarNet. drive.file limits file creation and metadata updates to permitted files; StarNet does not request broad Drive write access. Docs and Sheets no longer request drive.readonly in the review candidate. Returned content may enter local agent conversations and requests to the selected model provider, including the StarNet Credits gateway when selected. Users see this disclosure before sign-in. Public Workspace activation remains deferred pending verification.

### Gmail justification

StarNet provides user-requested email productivity assistance: searching and reading Gmail messages, threads and attachments, composing drafts and sending drafts when authorized by the user. gmail.readonly enables search and content reading; gmail.compose enables draft creation and sending. gmail.send alone cannot create drafts and read-only access cannot compose or send. StarNet does not request mailbox deletion, label modification or settings-management scopes. Returned message content may enter local agent conversations and requests to the selected model provider, including the StarNet Credits gateway when selected. Users see this disclosure before sign-in. Public Workspace activation remains deferred pending verification.

## Candidate scope map

Every service also requests `openid` and `userinfo.email`. The URLs below are suffixes
under `https://www.googleapis.com/auth/`.

| Service | Requested scopes | User-visible operation |
| --- | --- | --- |
| Gmail | gmail.readonly, gmail.compose | Search/read messages and attachments; create/send drafts |
| Drive | drive.readonly, drive.file | Search/read/export existing files; create/update permitted metadata |
| Calendar | calendar.calendarlist.readonly, calendar.events.readonly, calendar.events.freebusy | Read calendars/events/availability |
| Docs | documents, drive.file | Read/create/edit by document ID; minimal Drive account probe |
| Sheets | spreadsheets, drive.file | Read/create/edit by spreadsheet ID; minimal Drive account probe |

The combined scope declaration stays at eleven unique scopes: Drive still needs
drive.readonly, but connecting Docs or Sheets no longer grants whole-Drive read access.
An older grant is not automatically revoked by narrowing a new authorization request.

## Demonstration recording script

Use a private review build and dedicated test data. Never enable unverified scopes in
the public release merely to record the demo. Show the actual account consent screen,
browser address bar/client ID, app name and unverified-app screen as required by Google.
The supplied `Downloads/starnetdemo.mp4` was sampled at 80-second intervals: it shows
onboarding and general station work, not evidence establishing the required Google flows.
It has not been uploaded or represented as a verification demo.

1. Show StarNet's public home/privacy pages, then the in-app Google disclosure. Explain
   the selected model provider and, if used, the credits gateway; identify retained data.
2. Connect each of Gmail, Drive, Calendar, Docs and Sheets. Show account identity,
   distinct consent requests and the granted permissions. Include every applicable OAuth
   client in the project, including the separate StarNet Account web-login client.
3. Gmail: create a draft with a unique test subject; search that exact subject and read
   the returned message. For draft-send proof use a separately authorized test recipient.
4. Drive: search a dedicated pre-existing fixture, read metadata, export text; create
   and rename a dedicated fixture folder. Explain broad read versus file-scoped writes.
5. Docs: read a dedicated existing document, create a test document, insert text and
   read it back. Sheets: read an existing test spreadsheet, create one, write/read a
   range and apply a formatting batch update. Show the persisted results in Google.
6. Calendar: list calendars and a narrow fixture date window, read a fixture event and
   query its availability window. This connector does not create or edit events.
7. Restart the review app and demonstrate continued access. In a disposable test
   workspace prove refresh, denied/partial consent, local removal and revoked-access
   recovery. Removing a connection does not revoke Google consent or erase prior work.
8. Upload the genuine recording as unlisted on YouTube, verify playback, enter its URL,
   save the Data Access form and review the resulting submission summary. Do not claim
   policy compliance or assessment completion until the conditions below are satisfied.

## Security and release conditions

| Condition | Evidence/status |
| --- | --- |
| Native client provisioning | Existing downloaded registration validates as Desktop/installed for this project; GitHub secret metadata confirmed. Contents not committed or printed. |
| Scope minimization | Docs/Sheets whole-Drive permission removed in candidate; HTTP authorization regression tests cover actual request scopes. |
| Credential encryption | Candidate AES-256-GCM envelope; OS-keychain key injection; active/recovery read-back; legacy cleanup only after verified encryption; locked-key preservation. Native and runtime verification results belong in the execution record. |
| Content encryption/retention | **Open:** Google-derived conversations, agent memory, generated/retained artifacts and user exports require a complete data-flow and at-rest treatment. Credential encryption does not cover them. |
| Downstream use | **Open:** establish allowed provider/relay handling, training exclusions and retention for the supported Google workflows. General arbitrary-provider support is not a blanket compliance guarantee. |
| Limited Use statement | **Open:** publish an accurate affirmative statement only after the implementation/provider obligations can be substantiated. Do not treat existing privacy disclosure as proof of compliance. |
| CASA/security review | **External:** establish the applicable assessment scope and complete Google's required review for the actual data flow. No assessment, assessor engagement or payment has been claimed or authorized by this packet. |
| Demo/submission | **Open:** no qualifying unlisted YouTube link supplied; form is prepared but unsaved/unsubmitted. |
| Public activation | **Held:** retain RELEASE_DEFERRED until approval and complete fresh signed Windows/Mac lifecycle acceptance and release gates. |

Official requirements checked on 2026-09-19:

- https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/workspace/gmail/api/auth/scopes

The native credential changes require an installer containing the new shell and sidecar
together. Do not downgrade an encrypted workspace to an older sidecar that cannot read
the envelope. Raw backup portability and key-loss recovery need explicit acceptance;
the ciphertext intentionally cannot be unlocked with a new or missing OS keychain key.
The running app decrypts connector settings in memory for the existing credential-redacted
update backup. Standalone export without the unlocked app refuses the encrypted envelope
instead of silently dropping its settings. Portable backups exclude OAuth grants as before.
