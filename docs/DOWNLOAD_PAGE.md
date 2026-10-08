# StarNet

**A real desktop station where AI agents do real work — and you watch it happen.**

StarNet is a local-first desktop app. You spawn into one shabby starter room of a living
pixel-art station and expand outward: place rooms, run hallways, summon specialists. The catch
is that the station isn't decoration — the way you build it **is** the way your real
multi-agent org is wired. A room is a capability-scoped team; a hallway is an authorized
handoff lane; a placed object is a real tool grant. Behind the glass, the agents make real
model calls, run real tools, spend real money, and produce real output. Nothing on the screen
is faked: the station only ever shows you what the machine underneath is actually doing.

## Download

> **Windows and macOS.** Both are built by the same release pipeline and update through the
> same signed feed.

**[Download the latest release →](https://github.com/androoAGI/starnet-releases/releases/latest)**

Pick the asset for your platform:

| Platform | Download this asset |
| --- | --- |
| **Windows** (10/11, 64-bit) | `StarNet_<version>_x64-setup.exe` |
| **macOS — Apple Silicon** (M1 or later) | `StarNet_<version>_aarch64.dmg` |
| **macOS — Intel** | `StarNet_<version>_x64.dmg` |

> **Apple Silicon Macs: use the native `aarch64` DMG.** Avoid the `x64` DMG on Apple Silicon:
> it runs under Rosetta 2 rather than using the native architecture.

> **macOS honesty note:** the macOS build is produced by the same CI and is cryptographically
> signed for updates, but it's had **less real-world testing than the Windows build** at
> launch. Hit a bug? Tell us: **androo.agi@gmail.com**.

### System requirements

- **Windows 10 or 11 (64-bit)** or **macOS 10.15+** (Apple Silicon or Intel).
- A few hundred MB of disk space (grows with your agents' history and voice cache).
- An internet connection — for your AI provider, not for StarNet itself.
- Either an **API key** (OpenRouter / OpenAI / Anthropic / others) **or** a **ChatGPT
  subscription** to sign in with. See "Bring your own key" below.

## Installing (the honest version)

The public release train supports Windows and macOS and fails closed unless Windows passes
Authenticode publisher/timestamp checks, both Mac builds pass Developer ID and Apple
notarization checks, and every updater artifact has a valid updater signature. Linux packages
are internal build artifacts, not supported public downloads.

Those checks are a pipeline contract, not installed proof for the asset on your machine.
Windows SmartScreen can still warn while a signing certificate builds reputation; inspect the
publisher before proceeding. A public Mac DMG should pass Gatekeeper normally. If it reports an
unknown developer, missing notarization, or a damaged app, stop and report the exact release and
asset instead of clearing quarantine or bypassing Gatekeeper.

The full platform steps and the distinction between public and intentionally unsigned internal
test builds are in **[INSTALL.md](../INSTALL.md)**.

The built-in updater supports Windows and both Mac architectures. It verifies updater signatures
independently of Authenticode, Developer ID, and notarization. Installed update evidence still has
to be captured for the specific release; the build contract alone is not that evidence.

## Bring your own key (BYOK)

StarNet does not resell AI access and has no account system. You connect **your own** provider:

- **Bring your own API key** — OpenRouter, OpenAI, Anthropic, and other OpenAI-compatible
  providers. Paste your key and go.
- **Or sign in with ChatGPT** — use an existing ChatGPT subscription instead of a raw key.

**Your key, your machine, your data.** The key lives on your computer (in the OS keychain on
the desktop build), the agents run on your computer, and your conversations and files stay on
your computer. StarNet never sees a copy. See **[PRIVACY.md](../PRIVACY.md)** for the full,
audited breakdown — including the fact that there is **no telemetry, no analytics, and no
phone-home**.

## What it costs

**The app is free**, and using your own provider key is free forever. On that path you pay only
your own AI provider for the tokens your agents use — directly, at their prices, with no StarNet
markup. You set the budget: StarNet has per-run, per-day, and global spend caps, and
a Stop control in each conversation for stopping its active run.

StarNet Credits are an optional alternative for people who would rather not hold a provider
account: a prepaid balance you buy from us and spend on model runs through StarNet's own gateway.
Bringing your own key stays free either way, and is never nagged into a subscription.

## Support

Email only, best-effort: androo.agi@gmail.com.

## Legal

- **[Privacy](../PRIVACY.md)** — what stays local, what leaves, and why (nothing is telemetry).
- **[Terms of Use](../TERMS.md)** — free, as-is, you own your provider spend and your agents'
  actions.

<!-- ===================== SCREENSHOTS / CLIP PLACEHOLDER =====================
     TODO before launch: drop in real media of the running station.
       - Hero screenshot: the pixel-art station with agents at work.
       - Short clip/GIF: an agent walking to its desk and running a real task
         (COMMS beat + world reacting to a real tool call).
       - 2-3 supporting shots: recruitment bay, room/hallway building, spend ledger.
     Keep captions truthful — show real runs, not staged frames.
     ========================================================================= -->

_Screenshots and a demo clip go here._
