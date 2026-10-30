---
fingerprint: 12864fae
slug: channel-tools-hides-the-full-power-objects-a-pai
title: Channel /tools hides the Full Power objects a paired owner's DM run gets on Discord, Slack, Matrix, Signal and the dev route
surface: channels
severity: P2
status: fixed
found: 2026-10-30
lane: authority-census-1030
fix: 0e47b8f52
origin: audit
---

# Channel /tools hides the Full Power objects a paired owner's DM run gets on Discord, Slack, Matrix, Signal and the dev route

## Symptom

The paired owner messages a Full Access agent from a Discord, Slack, Matrix or Signal DM, or through the DEV_MODE local channel route. Their runs inherit Full Power and get the workbench (terminal) and the plugin family. /tools in the same chat does not list them, so the readout says the agent cannot do things its runs are doing. A Telegram owner DM was not affected.

## Repro

1. Set an agent to Full Access and pair a Discord (or Slack / Matrix / Signal) owner. Those hubs are built by `sidecar/channels/registry.js` wireChannel, which gives isOwner but no ownerTrusted.
2. From the owner's DM, ask the agent to run a terminal command: the run's room has a workbench (Full Power), and the command is offered.
3. Send /tools in that DM: WORKBENCH is not listed.
The DEV_MODE route (`POST /api/dev/inbound`, ownerSurface) shows the same gap. `test/channel-tools-readout.test.js` executes the readout against the run's room for both.

## Evidence

Source: `sidecar/index.js` runSlashForChannel decided `const hostPowerWithheld = !ctx.ownerTrusted;`. The run decides it with `hostPowerWithheldFor(o)` (`sidecar/run-origin.js`), which withholds only when `channelSender && !channelSenderOwner`. `sidecar/channels/hub.js` sets `channelSenderOwner = ownerSurface || ownerTrusted || (senderIsOwner && dm)`, so the two disagree whenever the owner is named without ownerTrusted. Found by the authority-census review (minor, laws lens). On the previous lane tip (72c0ee5b3), `test/channel-tools-readout.test.js` fails 22 assertions: the registry-owner and dev-route FULL POWER rows, and the hub handing runSlash no sender verdict. On 748b0462595's readout, 7 of its 12 readout rows fail.

## Verdict

Fixed in 0e47b8f52 (authority-census lane). The hub hands runSlash the same channelSender / channelSenderOwner pair it stamps on that chat's runs, on all three slash paths, and runSlashForChannel decides Full Power with hostPowerWithheldFor, as the run does. A caller with no verdict (a routine's slash line) keeps the old withheld-unless-ownerTrusted reading. Readout only: which runs get Full Power, and what they are granted, is unchanged (test/authority-census.test.js still reproduces the 748b0462595 matrix with an empty diff).
