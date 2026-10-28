# Stegano RS WebApp

A secure, local-first web application for steganography, built with Rust, WebAssembly, and React.

**Live Demo: [https://mage-enderman.github.io/stegano-rs-webapp/](https://mage-enderman.github.io/stegano-rs-webapp/)**

## Overview

This project is a reimagining of the `stegano-rs` CLI tool as a Progressive Web App (PWA). It allows you to:

*   **Hide data** in PNG, WebP, JPEG and JPEG XL images, or in 16 bit PCM WAV audio.
*   **Hide several files and/or a text note** in a single carrier.
*   **Unveil data** and read the extracted files right in the browser.
*   **Encrypt** the payload with a password (Argon2 + ChaCha20Poly1305).
*   **Verify** every result: the app reads the payload back out of the file it just produced and refuses to present a broken carrier as a success.
*   **Judge the visual cost** of an embedding via PSNR and the share of changed color channels.

All processing happens locally in WebAssembly. No data is ever uploaded to a server.

## Features

- **In-browser processing**: powered by `stegano-core` compiled to Wasm, running in a Web Worker so the UI never freezes.
- **Exact capacity numbers**: capacity and payload sizes are computed by the core, not estimated in JavaScript.
- **Lossless by design**: PNG, WebP and JPEG XL output keep the embedded bits intact; lossy output is refused with an explanation.
- **Offline capable**: installable as a PWA, the Wasm module is precached.
- **Share links**: build a `?url=…` deep link (with QR code) that opens the app with a remote stego image ready to unveil.

## Development

### Prerequisites

- **Rust**: `stable` toolchain with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).
- **Node.js**: Version 20+.
- **wasm-pack**: For building the Wasm module (`cargo install wasm-pack`).

### Build & Run

```bash
# build the Wasm module (release, optimized)
cd webapp
npm install
npm run wasm

# run the web app
npm run dev
```

`npm run wasm:dev` builds an unoptimized module for faster iteration; it is
considerably slower at runtime, so do not ship it.

### JPEG XL output

JPEG XL **input** works out of the box (decoded by `jxl-oxide`). JPEG XL
**output** is implemented as lossless (modular) encoding, but it is compiled
out by default because the only pure-Rust encoder, `jxl-encoder`, is licensed
`AGPL-3.0-only OR commercial`. Combining it with this `GPL-3.0-only` project
means the resulting work has to be distributed under AGPL-3.0.

Enable it deliberately, with that in mind:

```bash
npm run wasm:jxl
```

The UI only offers formats the build actually supports, so a default build
simply shows PNG and WebP.

### Wasm optimization

`wasm-opt` runs at `-O1`. `-O2` and above crash on this module (a binaryen
`Precompute` pass bug), see `crates/stegano-wasm/Cargo.toml`.

## Architecture

- `crates/stegano-core`: the core Rust library — media decoding/encoding, LSB codecs, payload formats, capacity computation, quality metrics and JPEG XL support.
- `crates/stegano-wasm`: the Wasm bindings. One call per user action, structured errors with stable codes, progress phases.
- `crates/stegano-seasmoke`: cryptography helper crate.
- `webapp/`: the React + TypeScript frontend.
  - `src/workers/stegano.worker.ts` owns the Wasm module and runs every operation off the main thread.
  - `src/lib/stegano.ts` is the typed client for that worker.
  - `src/components/` contains the hide and unveil panels.

## Documentation

- [docs/roadmap.md](docs/roadmap.md): features that are intentionally not implemented yet.

## License

GPL-3.0. See [LICENSE](LICENSE).

The optional `jxl-encode` feature pulls in `jxl-encoder`, which is licensed
under AGPL-3.0 (or a commercial license from its author). Builds without that
feature contain no AGPL code.
