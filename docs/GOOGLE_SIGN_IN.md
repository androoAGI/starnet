# Google account sign-in

Customers use **Sign in with Google**, choose an account, and approve the listed
permissions. No customer creates a Cloud project, enrolls in an MCP preview, or
enters a client ID, client secret, or API key. The default browser handles consent;
the desktop sidecar receives the loopback callback using state and PKCE S256.

StarNet implements MCP tools locally over the stable Gmail, Drive, Calendar, Docs,
and Sheets APIs. In the desktop review candidate, the connector envelope and its
recovery copy are encrypted with AES-256-GCM; the native shell obtains the key from
the OS keychain. Bare-sidecar development without a key remains plaintext. This
does not encrypt retained conversations, memories or exports, and does not establish
Google policy approval. Refresh and reconnect use the existing single-flight OAuth
lifecycle. Agent permission checks still apply to tools, including sending drafts.

## Publisher activation (once for StarNet)

1. Use a StarNet-owned Google Cloud project. Enable Gmail, Drive, Calendar, Docs,
   and Sheets APIs. These are the stable product APIs, not the preview MCP APIs.
2. Configure the Google consent app with StarNet's verified branding, support
   contact, privacy policy, and domains. Select an external audience for public users.
3. Register a **Desktop app** OAuth client. Download its `installed` JSON. A Web
   application client is confidential and must never be embedded in this package;
   staging explicitly rejects that client type. Google native applications cannot
   keep a client secret confidential; PKCE protects each authorization exchange.
4. Request Google's verification for the scopes listed in `sidecar/mcp/catalog.js`.
   Gmail read/compose and broad Drive access have additional verification
   requirements. Testing mode and its limited users/token lifetimes do not establish
   public availability. Complete Google's applicable review before release.
5. Store the installed client JSON in the release repository's Actions secret
   `STARNET_GOOGLE_DESKTOP_CLIENT_JSON`. The public release train stages it into
   `sidecar/mcp/google-client.json`; that generated file is included in the Tauri
   sidecar bundle. Missing/malformed/confidential registrations fail the build.
   This secret setting is a publisher workflow, not a customer setup task.
6. With an approved registration, prove a real external account: sign in, enumerate
   Gmail tools, search and read a known message, create a disposable draft, restart
   StarNet, force expiry in a disposable test workspace, and confirm refresh works.
   Send only to an explicitly authorized test recipient. Test denial, revoked
   access, disconnect, and each Workspace service on the actual signed installer.

For local development, supply the same publisher JSON through the process
environment, or run `node scripts/stage-google-client.mjs`. Do not commit that
generated file. Without a registration, developer builds show a truthful
unavailable state and explain that StarNet must enable the feature. They never
redirect this responsibility to the customer.

## Compatibility and capabilities

Existing manually configured Google Web clients and grants continue to work.
Existing preview MCP connections stay untouched until the user signs in again;
reauthorization moves that catalog connection to the stable API adapter only after
tokens have been durably saved. A failed or cancelled attempt preserves the old grant.
Each service is authorized independently; signing into Gmail does not silently
grant access to Drive or another Google account. Each card can therefore use a
different Google account. Simultaneous accounts within one service remain outside
this change's scope.

Docs and Sheets accept resource IDs and request their own product scope plus
`drive.file` for the minimal account probe. They do not request `drive.readonly`:
searching or exporting arbitrary existing Drive files belongs to the separately
authorized Drive connector. Existing grants are not revoked by a scope reduction;
users can revoke prior access in Google and reconnect for a fresh reduced grant.

Gmail supports search, message/thread/attachment reading, draft creation and draft
sending. Calendar is read-only. Drive supports metadata, file search, text exports
and file metadata creation/update; `drive.file` limits which files StarNet can
modify. Docs and Sheets support read/create/edit. Tools return real API errors;
there is no simulated connection state. Responses are bounded to 8 MiB.

References: [Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Google OAuth verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Evidence boundary

Automated mocked-provider tests establish protocol and persistence behavior; they
cannot establish Google approval or access by arbitrary public accounts. Until
the publisher registration and real signed-installer acceptance are recorded,
public Google sign-in remains unverified.

Current preparation and outstanding release conditions are recorded in
[GOOGLE_VERIFICATION_PACKET.md](GOOGLE_VERIFICATION_PACKET.md).
