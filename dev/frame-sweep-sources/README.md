# Frame sweep source art

Generated with the built-in image_gen tool on 2026-09-10 from e80acf63d rotation references.

- turtle-north.png: eight frames in one transparent row; match ninjaturtle.rot.north; show the rear shell and tied bandana, no eyes or tan chest; alternate legs and arms.
- wizard-northwest.png: eight frames in one transparent row; match voidwizard.rot.north-west; preserve the purple hat and robe; keep the brown staff visible on the right without extending above the hat.

Run python dev/import_frame_sweep.py to stage review sheets, then add --install to import the reviewed frames. The importer preserves each master canvas and idle foot line, applies one reference-derived scale, and normalizes transparent export noise. Run it AFTER the bulk PixelLab importer to retain these two corrections.
