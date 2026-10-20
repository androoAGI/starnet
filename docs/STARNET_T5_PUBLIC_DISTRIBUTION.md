# StarNet T5 Public Distribution Gate

T5 answers the public-launch question that T0 through T4 intentionally defer:

> Can StarNet be offered as a public Windows download/update without relying on private trust, manual warnings, or unverified release hosting?

T5 is stricter than invited beta. T0 through T4 can make StarNet safe for a trusted cohort, but public distribution also needs signed Windows artifacts, signed updater packages, hosted HTTPS release metadata, and a stable channel discipline.

## Done Condition

T5 is complete only when `.dogfood/t5-public-distribution-latest/t5-public-distribution-status.json` reports `publicDistributionReady=true`.

That requires:

- T0 clean install, T2 state safety, T3 live release smoke, and T4 update delivery are green.
- T1 public signing mode is green, not merely invited-beta green.
- The current NSIS installer is discoverable and hash-recorded.
- The NSIS installer has a non-empty Tauri updater `.sig` artifact generated for the
  current installer build.
- A production `latest.json` updater manifest exists, is valid JSON, uses HTTPS URLs, has a `windows-x86_64` platform entry, and embeds the same signature as the `.sig` file.
- A public distribution proof is imported with `schema=starnet.t5-public-distribution-proof.v1`.
- The imported proof records hosted HTTPS `latest.json` and installer checks, successful HTTP status, manifest/package URL agreement, and installer hash/byte agreement.
- The imported proof records release channel discipline: a single stable public channel, a daily-driver install pinned to stable, and dev work kept separate from the stable install.
- Evidence packs remain redacted and safe to share.

## Loop

Run:

```powershell
npm.cmd run t5:public-distribution:loop
```

The loop records evidence in `.dogfood/t5-public-distribution-<stamp>` and copies the latest run to `.dogfood/t5-public-distribution-latest`.

If public cert procurement, Authenticode signing, updater signing, or hosted proof is missing, the loop must stay blocked. That is the intended behavior; public distribution has external lead-time dependencies that code cannot honestly fake.
If a rebuilt installer is newer than the `.sig` next to it, the loop must also stay blocked until the updater signature is regenerated.

## Importing Public Distribution Proof

After publishing a release manifest and installer to the public update host, import a JSON file with this shape:

```json
{
  "schema": "starnet.t5-public-distribution-proof.v1",
  "generatedAt": "2026-06-28T00:00:00.000Z",
  "release": {
    "version": "0.2.0",
    "channel": "stable",
    "installerSha256": "<current installer SHA-256>",
    "installerBytes": 34826840
  },
  "hosting": {
    "latestJsonUrl": "https://updates.starnet.app/desktop/latest.json",
    "installerUrl": "https://updates.starnet.app/desktop/StarNet_0.2.0_x64-setup.exe",
    "latestStatus": 200,
    "installerStatus": 200,
    "manifestInstallerUrlMatches": true,
    "installerHashMatches": true,
    "installerBytesMatch": true
  },
  "channels": {
    "publicChannel": "stable",
    "singlePublicChannel": true,
    "dailyDriverPinnedStable": true,
    "devTreeSeparate": true
  },
  "notes": []
}
```

Then run:

```powershell
$env:STARNET_T5_DISTRIBUTION_EVIDENCE = "C:\path\to\public-distribution-proof.json"
npm.cmd run t5:public-distribution:loop
```

Malformed imported proof fails red. Missing external proof blocks.

## Scope Boundary

T5 does not promise instant SmartScreen trust. Even a valid OV Authenticode certificate can require reputation buildup. T5 proves the release pipeline is structured correctly for public distribution; reputation is tracked as an operational launch risk, not a code-green assertion.
