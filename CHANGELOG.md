# Changelog

## 1.1.0 - 2026-07-13

### Fixed

- Episode labels are no longer inferred from AniTube's internal `/video/<id>` value or from the loop index.
- FetchV tab storage is cleared for every capture and retry.
- A downloader tab must acknowledge the exact capture nonce and media URL before its filename is changed.
- Duplicate episode numbers, filenames, sources, and captured media fail closed.

### Added

- Automatic staging/loading of the official uBlock Origin Lite Chrome extension.
- Code-side ad request blocking and ad/media candidate validation.
- Configurable mapping and capture concurrency.
- Per-page media observation that does not rely solely on FetchV's shared tab storage.
- Unit tests for episode identity, ad rejection, media correlation, and ordered concurrency.

### Changed

- Removed per-episode `networkidle` waits in favor of targeted DOM and FetchV storage signals.
- AniTube pagination now reads the known last page and fetches only the required pages.
- FetchV candidate selection waits for a short settle window and prioritizes verified media identity.
- Failed parallel captures are retried in isolation instead of forcing the whole series through a serial pipeline.
- Isolated retries are restricted to tab/storage conflicts, capped, and use one 15-second navigation plus a media wait of at most 10 seconds.
- Pagination links are scoped to the anime path and capped before page arrays are allocated.

### Security

- Ambiguous or unverified media is not renamed by default.
- CSV values that could be interpreted as formulas are escaped.
