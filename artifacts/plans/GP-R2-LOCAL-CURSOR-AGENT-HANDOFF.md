# GP-R2 Local Cursor Agent Handoff

## Purpose

Continue the local `AU-UCR-EP-000001 / GP-R2` approval-evidence work without changing the reviewed Git objects, adopting the proposed manifest, superseding the historical manifest, authorizing preservation, or approving Gate P.

This handoff records completed checks and the remaining blocker. It is not an approval receipt or governance decision.

## Repository binding

- Repository: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch observed: `cursor/populate-authority-readiness-7886`
- Packet commit: `bddfafef7f558084a94b76b9cf38d57e924b05db`
- Packet tree: `a71ef60556304d1d77561affe91f260ec72ad43c`
- Candidate commit: `01b5e02a84fe260558c4ae66d03df91bb7f66c20`
- Candidate tree: `dca22c304034f1662db99230a29d3ccc3ca38889`
- Independently reproduced aggregate: `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`
- Computational review outcome: `REVIEW_PASS`
- Gate P: `NO_CHANGE_BLOCKED_BY_EVIDENCE`

Do not use working-tree renderings as substitutes for committed bytes. Ignore the pre-existing untracked file `artifacts/plans/GP-GOVERNANCE-BACKLOG.md`; it was outside the reviewed packet.

## Completed technical evidence

- Both commits and trees resolved exactly.
- All 54 historical-manifest paths were independently reconstructed from the candidate commit.
- All 54 Git blob OIDs, sizes, SHA-256 values, CRLF-to-LF values, line-ending counts, and preserved historical values matched the committed proposal.
- Independent NUL/LF framing reproduced the expected aggregate.
- The committed generator produced a byte-identical 68,127-byte proposal.
- Required unsafe path classes were rejected, including every C0 control and DEL.
- The historical v1.0.0 manifest remained blob `b50dcb6308c43abd81e336d46975cb1939410402` at both candidate and packet commits.
- No governed evidence file changed between candidate and packet commits.
- Proposed attribute scopes contained 287 blobs, 3,610,362 bytes, zero CRLF, zero lone CR, zero NUL, and no detected binary blobs.
- Review exceptions `E01` through `E10` are embedded in the canonical approval payload in full.

The complete review log is in the originating Codex conversation. Recompute material facts rather than treating this handoff as primary evidence.

## Human identity and signing evidence

- Governed identity: `Hakeem Moore <84290303+mrrobot787@users.noreply.github.com>`
- GitHub account: `mrrobot787`
- Authentication performed: GitHub device login with human-completed MFA
- SSH algorithm: `ssh-ed25519`
- Public-key fingerprint: `SHA256:2pjiz5NEOUQCIVLomZ534+EJjIZNUME8fyUL2xyoYpo`
- GitHub signing-key ID: `1242180`
- GitHub signing-key title: `IMHOTEP GP-R2 approval 2026-10-13`
- GitHub server creation time: `2026-10-13T19:45:08.504-04:00`
- Public GitHub API check: `users/mrrobot787/ssh_signing_keys`

The private key is outside the repository at `C:\Users\hakee\.ssh\imhotep_approval_ed25519`. Never read, copy, print, commit, upload, or request its passphrase. The public key is registered as a GitHub signing-only key.

## Canonical approval package

Package directory, outside the repository:

`C:\Users\hakee\.imhotep-approvals\AU-UCR-EP-000001\GP-R2`

Files:

- Canonical payload: `GP-R2-HUMAN-APPROVAL-e367e9ba-36ff-42c2-82e5-2478e9be72a2.txt`
- SSH signature: `GP-R2-HUMAN-APPROVAL-e367e9ba-36ff-42c2-82e5-2478e9be72a2.txt.sig`
- Narrow allowed-signers record: `allowed_signers`

Observed identities:

- Receipt ID: `urn:uuid:e367e9ba-36ff-42c2-82e5-2478e9be72a2`
- Namespace: `imhotep-gp-r2-human-approval-v1`
- Principal: `github:mrrobot787`
- Payload bytes: `4730`
- Payload SHA-256: `4580f85ac69eb076e11c93c992bfbb14e985d973cb6a0f2112771a2fd26d062f`
- Signature bytes: `330`
- Signature SHA-256: `404d49fc8cb5c0db33c22fadc57c8964e511a189ff67b547596c039de5e7eeb4`
- Encoding: UTF-8, no BOM, LF-only

Independent verification result:

```text
Good "imhotep-gp-r2-human-approval-v1" signature for github:mrrobot787 with ED25519 key SHA256:2pjiz5NEOUQCIVLomZ534+EJjIZNUME8fyUL2xyoYpo
```

## Approval evidence status

`APPROVAL_RECEIPT_STATUS = EVIDENCED`

The SSH signature authenticates the exact payload and key. The public GitHub record binds that public key to account `mrrobot787`. DigiCert RFC 3161 evidence independently proves that the completed signature existed at or before `2026-10-13T23:52:58Z`.

Timestamp package:

`C:\Users\hakee\.imhotep-approvals\AU-UCR-EP-000001\GP-R2\timestamp`

Key timestamp evidence:

- Request: `GP-R2-SIG-RFC3161.tsq`
- Request SHA-256: `c4d0cb5621b4731a1308c54c76d065a9fd614b69b9fd66b06a12a9d47d891e31`
- Response: `GP-R2-SIG-RFC3161.tsr`
- Response SHA-256: `96aa1cd5aabf2546af48a36d6a07a5e97b1acf4e00ca74a7a9310c82c0f5e1ca`
- Timestamp-token SHA-256: `745d626fb4e4cf72ef2720cc9c98a12c39816c7ea7dbafc7ecd392c7adc25dcc`
- Message imprint: `404d49fc8cb5c0db33c22fadc57c8964e511a189ff67b547596c039de5e7eeb4`
- Request and response nonce: `0x755183B170A26DBD`
- TSA response: `Granted`
- Policy OID: `2.16.840.1.114412.7.1`
- Serial number: `0x88E8AD61C75EF4B81505424F719812B7`
- Generation time: `2026-10-13T23:52:58Z`
- Responder: `CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1`
- CMS and certificate-chain result: `Verification: OK`
- Append-only record: `GP-R2-RFC3161-VERIFICATION-RECORD.md`
- Verification-record SHA-256: `ed10fe7536f4f4f8328b62c589f8976784c7956b49767fe076c2400badf83d15`

The OpenSSL warning that the responder certificate is not a CA certificate describes the expected leaf responder role. The responder has critical Time Stamping EKU, and the chain verified successfully to the configured DigiCert trust chain.

The signed payload's earlier approval-time claim remains a signed claim. The independently established time is the TSA generation time above.

## Next authorized work

1. Preserve the payload, SSH signature, allowed-signers record, RFC 3161 request/response/token, certificate evidence, and append-only verification record together.
2. Recompute all hashes and rerun both SSH and RFC 3161 verification after any transfer.
3. Keep the technical-review approval separate from any later adoption, supersession, preservation-authorization, custody, or Gate P decision.
4. If any receipt evidence is invalidated, retain it unchanged and issue a new append-only invalidation or supersession record.

Public posting, repository commits, pushes, manifest adoption, preservation actions, or governance decisions require separate authorization.

## Verification commands

Run from PowerShell. These commands are read-only.

```powershell
$dir = 'C:\Users\hakee\.imhotep-approvals\AU-UCR-EP-000001\GP-R2'
$payload = Join-Path $dir 'GP-R2-HUMAN-APPROVAL-e367e9ba-36ff-42c2-82e5-2478e9be72a2.txt'
$signature = "$payload.sig"
$allowed = Join-Path $dir 'allowed_signers'

Get-FileHash -Algorithm SHA256 -LiteralPath $payload
Get-FileHash -Algorithm SHA256 -LiteralPath $signature
ssh-keygen -lf 'C:\Users\hakee\.ssh\imhotep_approval_ed25519.pub' -E sha256
gh api users/mrrobot787/ssh_signing_keys --jq '.[] | select(.id == 1242180) | [.id, .title, .key, .created_at] | @tsv'
```

Use byte-preserving stdin for SSH verification. This Node command avoids PowerShell text-pipeline transformations:

```powershell
node -e "const fs=require('fs'),cp=require('child_process');const d='C:/Users/hakee/.imhotep-approvals/AU-UCR-EP-000001/GP-R2',p=d+'/GP-R2-HUMAN-APPROVAL-e367e9ba-36ff-42c2-82e5-2478e9be72a2.txt';const r=cp.spawnSync('ssh-keygen',['-Y','verify','-f',d+'/allowed_signers','-I','github:mrrobot787','-n','imhotep-gp-r2-human-approval-v1','-s',p+'.sig'],{input:fs.readFileSync(p),stdio:['pipe','inherit','inherit']});process.exit(r.status??1)"
```

Expected exit code: `0`.

## Prohibited interpretations and actions

- Do not claim the Codex reviewer became independent of the approving human.
- Do not treat MFA login alone as approval.
- Do not treat key registration alone as approval.
- Do not treat the timestamped approval as manifest adoption, supersession, preservation authorization, or Gate P approval.
- Do not edit or replace the signed payload; create append-only records.
- Do not edit the historical v1.0.0 manifest.
- Do not adopt the v1.1.0 proposal.
- Do not supersede v1.0.0.
- Do not authorize preservation.
- Do not approve Gate P.
- Do not commit, push, merge, or publish without explicit human authorization.
