# Changelog

All notable changes to `@moku-labs/ai` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.14.2 - 2026-10-04

### Added

- **`moku` bin: project config.** The bin loads `moku.config.ts`, `.mts`, `.js` or `.mjs` from the
  working directory, first hit wins, and passes the default export to `createApp`. `--config <path>`
  (or `--config=<path>`) on any command wins and is removed from argv. A config that does not load
  prints `[ai] Could not load <path>.` and exits `3` before the app is created. No file keeps the
  old behaviour.
- **`defineConfig` and `ProjectConfig`.** Typed authoring of `moku.config.ts`: `plugins` and
  `pluginConfigs` only. An unknown `pluginConfigs` key or a wrong value is a type error, also for
  the custom plugins in `plugins` and for the core plugins (`journal`, `store`, `limits`).
- **runner: `export({ flat })`.** `flat: true` writes `<outDir>/<label>.<ext>`, without the
  `<build>/` folder. The same label in two builds keeps the first file; the second is skipped and
  listed. Default `false`: unchanged.
- **cli: `--flat` on `moku run` and `moku export`.** Passed to `runner.export` as `flat`.
- **fal: `params.background` on `gpt-image-2.5`.** `auto`, `transparent` or `opaque`; other values
  are not sent. `transparent` without a known `output_format` sends `png`. `transparent` with
  `output_format: "jpeg"` is a terminal 400 before the key is read or a ref is uploaded. Without
  `background` the body is unchanged (`jpeg`). Nano Banana Pro and Seedream never send it.
- **promptGen: `runToolLoop` conversation prompt cache.** New option
  `cache?: "system" | "conversation" | "off"`, default `"conversation"`. The loop marks the newest
  stable message of each request, and the one of the request before, as cache breakpoints next to
  the system one. At most 4 breakpoints with the caller's `cache: true` parts; rolling marks are
  dropped first. A tool message whose images `keepImages` can still drop is sent after the mark.
  The marks are a pure function of the history and the options, so a resumed run sends the same
  request for the same step. `"system"` is the 0.12.0 behaviour.
- **promptGen: `PromptGenUsage.cachedReadTokens?` and `cachedWriteTokens?`.** Set only when the
  provider reports the count. `fal` reads `cache_read_input_tokens` / `cache_creation_input_tokens`,
  else `prompt_tokens_details.cached_tokens` / `cache_write_tokens`. The `model` event of
  `runToolLoop` carries them. `openai` sets `cachedReadTokens`; `claude` sets both.
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

### Changed

- **`@moku-labs/core` and `@moku-labs/common` are peer dependencies.** `^1.7.1` and `^0.3.4`,
  one copy per project; install them next to the package
  (`bun add @moku-labs/ai @moku-labs/core @moku-labs/common`). Before they were exact
  `dependencies` installed with the package.
- **cli: export skip line.** A skipped item now reads `skipped: unsafe name or duplicate target`.
- **runToolLoop: default request shape.** With the default `cache: "conversation"` up to two
  text parts of each request carry `cache: true`; a marked string content is sent as one text part.
  Pass `cache: "system"` for the 0.12.0 request.
- **fal: `usage.cachedTokens` also reads `cache_read_input_tokens`.** Before it read only
  `prompt_tokens_details.cached_tokens`.
- **fal: cost is unchanged.** `usage.cost` wins. The token fallback has no cache rates and prices
  cached tokens as normal input. The pass-through of `cache_control` by fal's router is not
  confirmed live; the fal README has a one-request check.

### Fixed

- **llms.txt: stale facts.** 19 regular plugins (was 10) and 5 core plugins; 7 CLI commands (was
  6, `export` was missing); `apimodels` added; plugin order matches `createCore`; `ark` image
  handler and models; framework `limits` lanes; `ark.downloadTimeoutMs`; journal API; file tree.
- **runner: `item:flagged` keeps the failure message.** A content-policy rejection now carries
  `message` like `item:failed`: the handler's `publicMessage`, else our own `[ai]` error text,
  first two lines, max 300 chars, absent otherwise. A dedupe follower of a flagged leader
  carries the leader's message. So a provider refusal such as BytePlus Ark
  `InputImageSensitiveContentDetected.PrivacyInformation` reaches the consumer. The journal
  still keeps no message.
