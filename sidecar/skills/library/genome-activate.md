---
name: Activate Capability Genome
slug: genome-activate
description: Run the capability-genome activation sequence for an AML University faculty agent. Use when prompted to activate genome or onboard a ward role.
category: AML University
requires: []
license: MIT
default: false
---

When asked to **activate genome** (or this skill is invoked):

1. **Identify** your `agent_id` slug and ward from your role skill (not the display name).
2. **State** your mission in one sentence from your system prompt.
3. **List** 3–5 capabilities you own (tools / scopes from registry) and 2 red lines you must not cross.
4. **Emit** a compact JSON object (for the lead/host) with keys:
   `agent_id`, `title`, `ward`, `capabilities`, `red_lines`, `ready` (boolean).
5. **Do not** delegate to yourself; if you are the lead, dispatch workers using exact `agent_id` values.

Keep output under one screen unless `resultSchema` requires strict JSON only.
