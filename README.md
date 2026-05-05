# MilkRiseAlert Web

MilkRiseAlert is a lightweight phone-friendly web app that uses the rear camera to watch a pot of milk and ring when the visible milk line starts rising.

## What it does

- opens the phone rear camera
- lets you capture a calm baseline
- watches a configurable vertical zone in the frame
- estimates the milk edge by finding the strongest brightness transition
- triggers a loud alarm plus vibration after several rising frames in a row

## Best setup

This works best when:

- the phone is slightly tilted, not perfectly straight overhead
- the milk surface edge is clearly visible in the preview
- the pot interior is darker than the milk
- the lighting is stable and not flickering

## Important limitation

This is a simple computer-vision heuristic, not a trained model. It is practical for a first version, but it is not guaranteed to detect every cookware shape or every lighting condition.

## Files

- `index.html`: app structure
- `styles.css`: mobile-first UI
- `app.js`: camera access, detection, alarm logic
- `manifest.webmanifest` and `sw.js`: installable PWA support
