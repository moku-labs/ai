# Changelog

All notable changes to `@moku-labs/ai` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Fixed

- **runner: `item:flagged` keeps the failure message.** A content-policy rejection now carries
  `message` like `item:failed`: the handler's `publicMessage`, else our own `[ai]` error text,
  first two lines, max 300 chars, absent otherwise. A dedupe follower of a flagged leader
  carries the leader's message. So a provider refusal such as BytePlus Ark
  `InputImageSensitiveContentDetected.PrivacyInformation` reaches the consumer. The journal
  still keeps no message.
