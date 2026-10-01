# Changelog

All notable changes to `@moku-labs/ai` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **ark: Seedream group generation.** `params.images: N` on an `image` item with `provider: ark`
  asks for up to N consistent images from one call (`sequential_image_generation: "auto"`,
  `max_images: N`). N is 1 to 15, and refs plus N is at most 15. A short group logs
  `ark:image:group-short`. Cost is per generated image; the estimate prices N. Without
  `params.images` the body and the artifact key are unchanged.
- **runner: multi-output items.** A handler result with `images` stores every image and journals
  them as the item's ordered `outputs`. `item:done` carries `contentHashes`. A `$ref` to the item is
  the first output. Reuse needs every output in the store.
- **runner: export names for multi-output items.** `<label>.<ext>`, then `<label>-2.<ext>` …
  `<label>-N.<ext>`. The item cost is on the first file.
- **journal:** `items.outputs` column (migrated in place), `DoneOutput` and `DoneResult` types;
  `commitDone`, `findDoneArtifact` and `reuseDone` carry outputs.
- **image:** `ImageOutput` type and `ImageResult.images`.

### Fixed

- **runner: `item:flagged` keeps the failure message.** A content-policy rejection now carries
  `message` like `item:failed`: the handler's `publicMessage`, else our own `[ai]` error text,
  first two lines, max 300 chars, absent otherwise. A dedupe follower of a flagged leader
  carries the leader's message. So a provider refusal such as BytePlus Ark
  `InputImageSensitiveContentDetected.PrivacyInformation` reaches the consumer. The journal
  still keeps no message.
