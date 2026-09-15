# Industrial skin rollout — 20 px baseline

The user selected 20 world pixels as the standing height on September 15. Preserve this size while improving anatomy, identity, camera perspective and grounded motion.

The current five animated characters are Ultron, Skeleton, Plague Doctor, Secret Agent and Void Wizard. The next front-pose group is Pepe, Fallout 1 Vault Dweller, Teddy Bear, Ghostface and Morpheus. These five new designs are front studies only; they are available in the actual dev station's **Compare skin** selector, beside real station props. They are not yet animated roster skins.

Each source is packed uniformly to 76 visible pixels in a 144px transparent master, feet at row 112, scale 20/76. Body widths range from 32 to 40 source pixels (8.42–10.53 world pixels); Pepe retains a wider frog face. Teddy Bear was regenerated with a smaller head and human-like torso/leg proportions.

`inputs.json` records selected ImageGen files, copied here as `<id>-source.png`. `build-rollout-fronts.cjs` packs the references and candidates, updates the isolated manifest, and mirrors the assets. `front-comparison.png` shows earlier candidates above the new group at equal standing height.

Remaining catalog treatment should preserve the distinguishing silhouettes of Pikachu, Xenomorph, Crewmate and other nonhuman skins while keeping their baseline and contact stable. Complete each front design before creating its eight rotations, walks and seated poses; inspect every generated loop before selecting it. No old animation may be labelled as the revised skin's finished motion.
