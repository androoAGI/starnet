# Third-party notices & credits

StarNet bundles a library of **pure-prompt skill recipes** (`sidecar/skills/library/*.md`).
Many are adaptations of MIT-licensed community skills. This file preserves the attribution
and license notices for that upstream work, as the MIT License requires. The recipe text in
the app is condensed and re-voiced for StarNet's workstation model, but the underlying ideas
and, in places, close paraphrases originate with the authors credited below.

Several recipes reached StarNet through the open-source **Hermes agent project**
(© 2025 Nous Research, MIT) — the harness StarNet's backend was in part ported from — which
had itself collected them from the community authors listed here. Credit is given to the
original authors wherever one is known.

## Community skills (original author credited)

| Recipe | Original author / source | License |
| --- | --- | --- |
| `adversarial-ux-test` | Omni @ Comelse — *adversarial-ux-test* | MIT |
| `architecture-diagram` | Cocoon AI — [architecture-diagram-generator](https://github.com/Cocoon-AI/architecture-diagram-generator) | MIT |
| `ascii-art` | 0xbyt4 — *ascii-art* | MIT |
| `concept-diagrams` | v1k22 — *concept-diagrams* | MIT |
| `creative-ideation` | SHL0MS — *creative-ideation* | MIT |
| `decision-1-3-1` | Willard Moore — *one-three-one-rule* | MIT |
| `humanizer` | Siqi Chen (@blader) — [blader/humanizer](https://github.com/blader/humanizer); based on *Wikipedia: Signs of AI writing* | MIT |
| `meme-generation` | adanaleycio — *meme-generation* | MIT |
| `osint-public-records` | ShinMegamiBoson — *OpenPlanter* | MIT |
| `plan` | [obra/superpowers](https://github.com/obra/superpowers) | MIT |
| `popular-web-designs` | Teknium — design systems via *VoltAgent/awesome-design-md* | MIT |
| `requesting-code-review` | [obra/superpowers](https://github.com/obra/superpowers) + MorAlekss | MIT |
| `research-paper-writing` | Orchestra Research — *research-paper-writing* | MIT |
| `spike` | gsd-build — *get-shit-done* | MIT |
| `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) | MIT |
| `test-driven-development` | [obra/superpowers](https://github.com/obra/superpowers) | MIT |
| `ui-sketch` | gsd-build — *get-shit-done* | MIT |

## Ported from the Hermes agent project (© 2025 Nous Research, MIT)

These recipes were adapted from skills in the Hermes project's own library. Original
copyright holder: **Nous Research**.

`arxiv-research`, `code-review`, `codebase-inspection`, `domain-intel`, `excalidraw`,
`node-inspect-debugger`, `p5js-sketch`, `pdf-document-extraction` (from *ocr-and-documents*),
`python-debugger`, `simplify-code`, `web-research`.

## Authored for StarNet

These recipes were written for StarNet and carry no distinct external upstream. (Some were
previously bylined "Hermes Agent" by convention; that byline has been removed.) They are also
published as **StarNet Originals** in the Skill Market (`skills-catalog/originals.json`).

`accessibility-audit`, `ad-copy-testing`, `adversarial-review-pass`, `announcement-kit`, `application-tailoring`, `browser-operation`, `commitment-tracking`, `content-calendar`, `contract-review`, `cost-audit`, `dataset-harvest`, `deploy-checklist`, `digest-composer`, `email-sequence`, `exposed-secrets-audit`, `exposure-reduction`, `feed-watch`, `file-curation`, `hard-conversation`, `health-record-prep`, `hiring-screen`, `inbox-triage`, `itinerary-planning`, `landing-copy`, `lead-scouting`, `ledger-upkeep`, `marketing-plan`, `meal-planning`, `negotiation-case`, `opportunity-scan`, `pitch-deck`, `price-watch`, `relationship-log`, `schema-and-access`, `security-sweep`, `short-form-script`, `sop-writing`, `source-triangulation`, `spec-drafting`, `study-plan`, `support-replies`, `translation-pass`, `ugc-brief`, `voice-match`, `website-workflow`, `work-splitting`.

## Skill Market (skills-catalog/)

The Skill Market catalog (`website/skills/`, built by `scripts/build-skill-catalog.mjs`) publishes the
**StarNet Originals** listed above plus these market-only originals, written for StarNet:

`address-pr-comments`, `bills-and-subscriptions`, `brand-assets`, `calendar-scheduling`, `changelog-writing`, `channel-updates`, `crew-handoff`, `daily-briefing`, `data-cleanup-and-analysis`, `deliverable-handoff`, `fitness-and-nutrition`, `fix-failing-ci`, `flashcards`, `grounded-citations`, `issue-triage`, `line-design`, `link-and-video-summary`, `meeting-prep`, `notebook-gardening`, `persistent-reminders`, `project-onboarding`, `receipt-organizer`, `routine-craft`, `skill-authoring`, `spend-aware-work`, `station-self-check`, `studio-video`.

and these **community picks**, adapted for StarNet. Each package ships its full license text
(`skills-catalog/skills/<slug>/LICENSE`) naming the original author and StarNet's modifications; Apache-2.0 packages also ship a `NOTICE`.

| Skill | Original author | Upstream | License |
| --- | --- | --- | --- |
| `blocked-page-recovery` | Nous Research | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/web/blocked-page-recovery) (© 2025 Nous Research) | MIT |
| `code-wiki` | Teknium | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/optional-skills/software-development/code-wiki) (© 2025 Nous Research) | MIT |
| `cold-email` | Corey Haines | [Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/cold-email) (© 2025 Corey Haines) | MIT |
| `competitor-news-monitor` | Ben Barclay | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/abd83ab560327c58f17f8e2ecd9be0307d5c9cf9/skills/research/competitor-news-monitor) (© 2025 Nous Research) | MIT |
| `conversion-review` | Corey Haines | [Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/cro) (© 2025 Corey Haines) | MIT |
| `customer-research` | Corey Haines | [Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/customer-research) (© 2025 Corey Haines) | MIT |
| `decision-questionnaire` | Matt Pocock | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/optional-skills/productivity/decision-questionnaire) (© 2025 Nous Research) | MIT |
| `document-to-action-items` | Ben Barclay | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/productivity/document-to-action-items) (© 2025 Nous Research) | MIT |
| `finishing-a-branch` | Jesse Vincent | [Superpowers](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/finishing-a-development-branch) (© 2025 Jesse Vincent) | MIT |
| `frontend-design` | Anthropic | [Anthropic skills](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/frontend-design) (© Anthropic, PBC) | Apache-2.0 |
| `grill-me` | Rafael Zendron, Matt Pocock | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/optional-skills/software-development/grill-me) (© 2025 Nous Research) | MIT |
| `lead-magnets` | Corey Haines | [Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/lead-magnets) (© 2025 Corey Haines) | MIT |
| `llm-wiki` | Nous Research | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/research/llm-wiki) (© 2025 Nous Research) | MIT |
| `maps` | Mibayy | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/productivity/maps) (© 2025 Nous Research) | MIT |
| `mcp-server-building` | Anthropic | [Anthropic skills](https://github.com/anthropics/skills/tree/b9e19e6f44773509fbdd7001d77ff41a49a486c1/skills/mcp-builder) (© Anthropic, PBC) | Apache-2.0 |
| `meeting-action-items` | Ben Barclay | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/productivity/meeting-action-items) (© 2025 Nous Research) | MIT |
| `notes-vault` | Teknium | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/note-taking/obsidian) (© 2025 Nous Research) | MIT |
| `pricing-strategy` | Corey Haines | [Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/pricing) (© 2025 Corey Haines) | MIT |
| `publish-site` | Nous Research | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/034c6ac77ba4b911a121f60cb53245b66c3a4fc9/optional-skills/web-development/publish-site) (© 2025 Nous Research) | MIT |
| `receiving-code-review` | Jesse Vincent | [Superpowers](https://github.com/obra/superpowers/tree/3fb75974186ea7fada621d8ab77b3b02169baf57/skills/receiving-code-review) (© 2025 Jesse Vincent) | MIT |
| `rest-graphql-debug` | eren-karakus0 | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/optional-skills/software-development/rest-graphql-debug) (© 2025 Nous Research) | MIT |
| `seo-audit` | Corey Haines | [Marketing Skills](https://github.com/coreyhaines31/marketingskills/tree/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/seo-audit) (© 2025 Corey Haines) | MIT |
| `simple-english` | AminBlg | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/optional-skills/creative/simple-english) (© 2025 Nous Research) | MIT |
| `songwriting` | Teknium | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/1c9433897c7b8a3b2754a84875e8f86d0a42991a/skills/creative/songwriting-and-ai-music) (© 2025 Nous Research) | MIT |
| `teach-me` | Matt Pocock | [Matt Pocock's skills](https://github.com/mattpocock/skills/tree/321658273cb1d20b76026717d027d505790106d4/skills/productivity/teach) (© 2026 Matt Pocock) | MIT |
| `threat-model` | OpenAI | [OpenAI skills](https://github.com/openai/skills/tree/5c8f1e26803bcfaffeceef1e7accbcf7e388417a/skills/.curated/security-threat-model) (© OpenAI) | Apache-2.0 |
| `verification-before-completion` | Jesse Vincent | [Superpowers](https://github.com/obra/superpowers/tree/3be5aad3dd2400ef23b15680969f4bcd3b6d7b8b/skills/verification-before-completion) (© 2025 Jesse Vincent) | MIT |
| `web-app-qa` | Teknium | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/1c9433897c7b8a3b2754a84875e8f86d0a42991a/skills/software-development/dogfood) (© 2025 Nous Research) | MIT |
| `weekly-review` | Ben Barclay | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/e85706cba780382ef91ba7a38a20ebe95207a795/skills/productivity/weekly-review-planning) (© 2025 Nous Research) | MIT |

## Bundled fonts

StarNet ships the **VT323** typeface locally (`frontend/assets/fonts/vt323.woff2`) so the
CRT terminal look renders on an offline / air-gapped first boot without depending on Google
Fonts. VT323 is provided under the **SIL Open Font License, Version 1.1**.

- **Font:** VT323
- **Copyright:** © 2011 The VT323 Project Authors (peter.hull@oikoi.com)
- **License:** SIL Open Font License 1.1 — <https://openfontlicense.org>

The OFL permits bundling and redistribution of the font (including in an application) provided
the copyright and license notice above are preserved and the font itself is not sold on its
own. The full license text is available at the URL above; its permission notice reads, in
part:

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy of the Font
Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and
unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified
   Versions, may be sold by itself.
2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or
   sold with any software, provided that each copy contains the above copyright notice and
   this license. These can be included either as stand-alone text files, human-readable
   headers or in the appropriate machine-readable metadata fields within text or binary
   files as long as those fields can be easily viewed by the user.

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT.
```

## MIT License

All third-party components listed above are provided under the MIT License. Copyright is held
by the respective authors named above (and, for the Hermes-derived recipes, © 2025 Nous
Research). The MIT permission notice is reproduced once here as it applies to all of them:

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## Bundled Ogg/Opus decoder

StarNet uses [`ogg-opus-decoder`](https://github.com/eshaz/wasm-audio-decoders/tree/main/src/ogg-opus-decoder)
(Copyright Ethan Halsall, MIT) to decode Telegram voice notes for the local speech-recognition engine. Its
transitive [`codec-parser`](https://github.com/eshaz/codec-parser) component is provided under the GNU Lesser
General Public License v3.0 or later. The unmodified packages, their license files, and their corresponding
source locations are preserved in the bundled `node_modules` tree.

## StarNet's own name and artwork

The credits above cover third-party work bundled with StarNet. StarNet's own code is released
under the MIT License (see `LICENSE`) and may be forked, modified, and redistributed, including
commercially.

That license covers the code only. The **StarNet** name, the logo, the station artwork and
sprites, and the rest of the project's brand identity are owned by Andrew Sims and are not
licensed with the code. No trademark or other brand right is granted, expressly or by
implication. A fork or derivative must ship under its own name, logo, and artwork, and must not
present itself as StarNet or as endorsed by it.
