# Approved readability style: first crew batch

User approved Secret Agent readability-v1 on 2026-09-15 and requested applying the style to the other skins. This batch extends that approved reference to Ultron, Skeleton, Plague Doctor and Void Wizard.

Each source was generated with built-in ImageGen using the approved Secret Agent as the proportions/style reference and the corresponding old skin as the identity reference. Prompt requested broad crisp matte industrial pixel clusters, clear heads and hands, slim adult body proportions, and fewer noisy fine details. Sources and exact generation paths are preserved in inputs.json.

All four are south-facing standing poses only. They are not full animation replacements. The existing five animated roster bodies still use their original tracks; the explicitly labeled front-pose comparison shows the revisions through the real station entity/light pass.

Packing uses uniform resize to76 visible pixels, padding to144x144, feet112; runtime scale18/76. Ultron and Plague Doctor widths34; Skeleton and Void Wizard widths36. No independent width stretch. All are18 world pixels tall, widths8.05 or8.53.

Live verification: all four selectable comparisons were drawn using their actual readability_<id>.rot.south tracks, visually inspected at camera4x alongside desks/chairs, and Ultron also checked at normal2x. Secret Agent remains the approved reference. Selector uses the same comparison position and matching light sample for both sprites. Frontend and website assets mirrored.
