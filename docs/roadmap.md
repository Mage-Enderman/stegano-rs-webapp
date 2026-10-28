# Roadmap — known gaps, deliberately not implemented yet

This file records the ideas that were considered but left out, together with
enough context to pick them up later without re-discovering the constraints.

## 1. Steganalysis resistance

**Status:** not implemented. The current embedder writes the payload starting at
the first usable pixel, channel by channel, in a fixed order (see
`crates/stegano-core/src/media/image/encoder.rs` and `universal_encoder.rs`).

That makes the output trivially detectable with a chi-square or RS analysis: a
whole contiguous block of the image has a suspiciously uniform LSB plane.

Roughly in order of effort:

1. **Seeded channel permutation** — wrap the carrier iterator so that the order
   of used channels is a permutation derived from a key. The decoder needs the
   same key, so password-less carriers would have to store the seed in the
   payload header.
2. **Matrix (Hamming) encoding** — embedding 3 payload bits into 4 carrier bits
   changes roughly one channel instead of 1.5, cutting the distortion by about a
   third and making the LSB plane less uniform.
3. **Adaptive region selection** — prefer high-variance blocks (texture, edges)
   over flat areas such as sky, where LSB changes are visually and
   statistically obvious.

The `HideAlgorithm` trait and the iterator layering (`ImageRgbaColorMut`) are
the natural insertion points; `CodecOptions` is the place for a key/seed.

## 2. Format coverage

**Status:** partly done.

- JPEG carriers now decode, because the core's `image` dependency enables the
  `jpeg` feature; the browser build inherits it.
- **Not done:** AVIF (decode or encode) and lossless argument handling for
  exotic formats. `OutputFormat` (`crates/stegano-core/src/media/output.rs`)
  currently knows PNG, WebP, JPEG and JPEG XL.
- JPEG is accepted as *input* only. `OutputFormat::preserves_pixels()` returns
  false for it, and both `Media::save_as` and `SteganoEncoder` refuse to write a
  payload into a lossy container. Keep that behaviour: a "successful" hide into
  JPEG would silently lose the data.

## 3. Decoy password (plausible deniability)

**Status:** not implemented.

Two different passwords, two different payloads in the same carrier; under
duress the second one is revealed. This needs a payload format change: the
current `PayloadCodec` chain (`media/payload/`) derives one ChaCha20Poly1305 key
per password via Argon2, and a decode failure is indistinguishable from "no
data". A decoy scheme needs

- a password-independent index of the slots in the payload header, and
- a way to tell "wrong password for this slot" from "slot empty", which today
  both surface as `SteganoError::DecryptionError`.

Do it as a new message version so existing carriers keep working
(`tests/ensure_old_formats_work.rs` is the compatibility guard).

## 4. Smaller follow-ups that were not part of this round

- **Batch mode** — hide into many carriers in one go. The core API is already
  stateless per operation, this is mostly UI.
- **History** — recent operations in IndexedDB. Note that keeping carriers and
  payloads around has privacy implications; at most keep names and metrics.
- **PWA file handling / share target** — register as a handler for image files
  so "Open with" lands in the app.
- **Streaming progress** — the UI currently reports phases (`decode`, `resize`,
  `embed`, `verify`); a percentage inside `embed` would require a progress
  callback threaded through `UniversalEncoder`.
- **Keyfile support** — derive the Argon2 input from a file in addition to a
  password.
