# Command catalog projection candidates

Eight south-view PNGs plus integration metadata. Native bounds are unchanged; final assets are never stretched. Import records from `integration.json`, resolving images under `frontend/assets/industrial/catalog-command/`. Sources, prompts and alpha/crop proof are preserved.

| ID | Footprint | Native bounds (x,y,w,h) | Actual uniform fit | Ratio residual |
|---|---|---|---|---|
| console | 2×1 | (-3,-11,28,23) | 27.86×23.00 | -0.50% |
| consoleL | 3×1 | (-3,-11,40,23) | 40.00×21.99 | 4.60% |
| bench | 4×1 | (-1,-14,54,26) | 54.00×23.69 | 9.75% |
| bridge_consolebank | 9×1 | (0,-21,108,33) | 106.27×33.00 | -1.61% |
| bridge_equipmentbay | 4×1 | (0,-7,48,19) | 48.00×16.80 | 13.09% |
| bigscreen | 8×1 | (-1,-13,98,25) | 95.51×25.00 | -2.54% |
| holotable | 4×2 | (-1,-10,50,34) | 50.00×27.22 | 24.92% |
| bridge_tacticaltable | 7×4 | (0,-7,84,55) | 82.68×55.00 | -1.57% |

Five match the intended source aspect within4.6%. Bench, equipmentbay and holotable remain shallower than their full native standing envelopes after bounded final edits. In particular holotable fits50×27.22 inside50×34. Do not claim all eight target source proportions were achieved. Its selected source preserves an overhead table plane and bounded generic projection; the rejected guide-derived version has an inappropriate front-on glowing glass face.

The9tile console bank is3.22:1 and the8tile hall screen3.82:1; both are genuinely wide source forms, close to native3.27:1 and3.92:1. The screen sits on two pylons and a cross-tie. ConsoleL is a straight instrument wall; bench has unlike stations and clear middle deck. Operator chairs remain separate.

Run `node dev/industrial-textures/build-catalog-command.cjs` from repository root. It verifies source SHA256, preserves source RGB and retained alpha, removes only loose alpha residue by core180/radius3, tightly crops, measures floor contact and emits proof plus1×/2×/3× native-fit contact sheet. Repeated runs preserve PNG hashes.

All screens contain only generic decorative imagery. Parent integration owns real screenPower gating, screen polygons and assigned-workstation activity. Do not reuse old image-specific effect geometry without remeasurement. Consolebank/equipmentbay/tacticaltable are decorative per native inventory; holotable projection is generic ambient decoration, not actual progress or metrics.

Source images and game-size sheet were inspected. No runtime/main manifest/live save changed and no saved-station acceptance claimed.
