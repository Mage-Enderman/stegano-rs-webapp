//! Wasm bindings for `stegano-core`.
//!
//! The exported API is intentionally coarse: one call per user action, so that
//! the whole operation runs inside a Web Worker and the main thread never
//! blocks. Errors are thrown as [`SteganoJsError`] instances carrying a stable
//! `code` so the UI can explain what happened.

use js_sys::{Array, Function, Uint8Array};
use stegano_core::api::unveil;
use stegano_core::media::image::jxl;
use stegano_core::{CodecOptions, Media, OutputFormat, SteganoEncoder, SteganoError};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// A structured error that survives the Wasm boundary.
///
/// `code` is stable and meant for branching in the UI:
/// `no_payload`, `wrong_password`, `capacity`, `unsupported_media`,
/// `lossy_format`, `bad_format`, `no_input`, `internal`.
#[wasm_bindgen]
pub struct SteganoJsError {
    code: String,
    message: String,
    hint: Option<String>,
}

#[wasm_bindgen]
impl SteganoJsError {
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> String {
        self.code.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.message.clone()
    }

    /// a human readable suggestion on how to fix the problem
    #[wasm_bindgen(getter)]
    pub fn hint(&self) -> Option<String> {
        self.hint.clone()
    }
}

impl From<SteganoError> for SteganoJsError {
    fn from(err: SteganoError) -> Self {
        let (code, hint): (&str, Option<String>) = match &err {
            SteganoError::UnsupportedMessageFormat(version) => (
                "no_payload",
                Some(format!(
                    "No readable payload was found (unknown format marker {version}). \
                     Hidden data only survives lossless formats - if this image was \
                     re-saved as JPEG, resized, or sent through a chat app, the data is gone."
                )),
            ),
            SteganoError::NoSecretData => (
                "no_payload",
                Some("This carrier does not contain any hidden data.".to_string()),
            ),
            SteganoError::DecryptionError(_) => (
                "wrong_password",
                Some(
                    "A payload was found but it could not be decrypted. \
                     Check the password - without the correct one the data is unreadable."
                        .to_string(),
                ),
            ),
            SteganoError::ImageCapacityError(w, h, needed_w, needed_h) => (
                "capacity",
                Some(format!(
                    "The carrier is {w}x{h} pixels, but the payload needs about \
                     {needed_w}x{needed_h}. Enable autoscale or pick a larger image."
                )),
            ),
            SteganoError::AudioCapacityError(capacity, needed) => (
                "capacity",
                Some(format!(
                    "The audio carrier holds {capacity} bytes, but the payload is {needed} bytes."
                )),
            ),
            SteganoError::InvalidImageMedia | SteganoError::UnsupportedMedia => (
                "unsupported_media",
                Some(
                    "This file is not a supported carrier. Use PNG, WebP, JPEG or JPEG XL \
                     images, or 16 bit WAV audio."
                        .to_string(),
                ),
            ),
            SteganoError::InvalidAudioMedia => (
                "unsupported_media",
                Some("Only 16 bit PCM WAV files are supported as audio carriers.".to_string()),
            ),
            SteganoError::LossyOutputFormat(format) => (
                "lossy_format",
                Some(format!(
                    "{format} is lossy and would destroy the payload. Use PNG, lossless WebP or JPEG XL."
                )),
            ),
            SteganoError::UnknownOutputFormat(_) => ("bad_format", None),
            SteganoError::UnsupportedOutputFormat(_) => (
                "bad_format",
                Some("This build was compiled without support for that output format.".to_string()),
            ),
            SteganoError::MissingMessage | SteganoError::MissingFiles => (
                "no_input",
                Some("Add a text message or at least one file to hide.".to_string()),
            ),
            _ => ("internal", None),
        };

        Self {
            code: code.to_string(),
            message: err.to_string(),
            hint,
        }
    }
}

fn js_err(err: SteganoError) -> JsValue {
    JsValue::from(SteganoJsError::from(err))
}

fn call_phase(progress: &Option<Function>, phase: &str) {
    if let Some(callback) = progress {
        let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(phase));
    }
}

/// Basic facts about a carrier file, used to build the capacity meter.
#[wasm_bindgen]
pub struct MediaInfo {
    kind: String,
    width: Option<u32>,
    height: Option<u32>,
    capacity_bytes: usize,
    is_jpeg_xl: bool,
}

#[wasm_bindgen]
impl MediaInfo {
    /// `image` or `audio`
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> Option<u32> {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> Option<u32> {
        self.height
    }

    /// how many payload bytes fit into this carrier
    #[wasm_bindgen(getter)]
    pub fn capacity_bytes(&self) -> usize {
        self.capacity_bytes
    }

    #[wasm_bindgen(getter)]
    pub fn is_jpeg_xl(&self) -> bool {
        self.is_jpeg_xl
    }
}

/// Inspects a carrier without modifying it.
#[wasm_bindgen]
pub fn media_info(data: &[u8], hint: Option<String>) -> Result<MediaInfo, JsValue> {
    let media = Media::from_bytes(data, hint.as_deref()).map_err(js_err)?;
    let (width, height) = match media.dimensions() {
        Some((w, h)) => (Some(w), Some(h)),
        None => (None, None),
    };

    Ok(MediaInfo {
        kind: media.kind().as_str().to_string(),
        width,
        height,
        capacity_bytes: media.capacity_bytes(&CodecOptions::default()),
        is_jpeg_xl: jxl::is_jxl(data),
    })
}

/// The result of a hide operation.
#[wasm_bindgen]
pub struct HideResult {
    bytes: Uint8Array,
    format: String,
    kind: String,
    width: Option<u32>,
    height: Option<u32>,
    capacity_bytes: usize,
    payload_bytes: usize,
    psnr: Option<f64>,
    changed_ratio: Option<f64>,
    max_channel_delta: Option<u8>,
    verified: bool,
    verification: String,
    resized: bool,
}

#[wasm_bindgen]
impl HideResult {
    /// the encoded carrier, ready to be written to a Blob
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Uint8Array {
        self.bytes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.format.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> Option<u32> {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> Option<u32> {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn capacity_bytes(&self) -> usize {
        self.capacity_bytes
    }

    #[wasm_bindgen(getter)]
    pub fn payload_bytes(&self) -> usize {
        self.payload_bytes
    }

    /// peak signal to noise ratio in dB, `Infinity` when nothing changed
    #[wasm_bindgen(getter)]
    pub fn psnr(&self) -> Option<f64> {
        self.psnr
    }

    /// share of the touched color channels that were flipped, `0..1`
    #[wasm_bindgen(getter)]
    pub fn changed_ratio(&self) -> Option<f64> {
        self.changed_ratio
    }

    #[wasm_bindgen(getter)]
    pub fn max_channel_delta(&self) -> Option<u8> {
        self.max_channel_delta
    }

    /// whether the payload could be extracted again from the produced file
    #[wasm_bindgen(getter)]
    pub fn verified(&self) -> bool {
        self.verified
    }

    #[wasm_bindgen(getter)]
    pub fn verification(&self) -> String {
        self.verification.clone()
    }

    /// whether the carrier had to be scaled up
    #[wasm_bindgen(getter)]
    pub fn resized(&self) -> bool {
        self.resized
    }
}

/// Hides a text message and/or files inside a carrier.
///
/// * `names` / `blobs` are parallel arrays of file names and `Uint8Array` data.
/// * `progress` is called with `decode`, `resize`, `embed`, `encode`, `verify`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn hide(
    carrier: &[u8],
    carrier_hint: Option<String>,
    names: Array,
    blobs: Array,
    text: Option<String>,
    password: Option<String>,
    should_resize: bool,
    output_format: Option<String>,
    progress: Option<Function>,
) -> Result<HideResult, JsValue> {
    if names.length() != blobs.length() {
        return Err(js_err(SteganoError::InvalidFileName));
    }

    let format = match output_format.as_deref() {
        Some(name) => OutputFormat::from_name(name)
            .ok_or_else(|| js_err(SteganoError::UnknownOutputFormat(name.to_string())))?,
        None => OutputFormat::Png,
    };

    call_phase(&progress, "decode");
    let media = Media::from_bytes(carrier, carrier_hint.as_deref()).map_err(js_err)?;
    let options = CodecOptions::default();

    let password = password.filter(|p| !p.is_empty());
    let mut expected: Vec<(String, Vec<u8>)> = Vec::new();

    let mut encoder = SteganoEncoder::default();
    encoder.with_output_format(format);
    if let Some(password) = password.as_deref() {
        encoder.with_encryption(password);
    }

    if let Some(text) = text.filter(|t| !t.is_empty()) {
        encoder.add_message(&text).map_err(js_err)?;
        expected.push(("secret-message.txt".to_string(), text.into_bytes()));
    }

    for i in 0..names.length() {
        let name = names
            .get(i)
            .as_string()
            .ok_or_else(|| js_err(SteganoError::InvalidFileName))?;
        let data = Uint8Array::new(&blobs.get(i)).to_vec();

        encoder.add_file_from_memory(&name, &data).map_err(js_err)?;
        expected.push((name, data));
    }

    if expected.is_empty() {
        return Err(js_err(SteganoError::MissingMessage));
    }

    let payload_bytes = encoder.payload_size().map_err(js_err)?;

    let mut media = media;
    let mut resized = false;
    if should_resize && media.capacity_bytes(&options) < payload_bytes {
        call_phase(&progress, "resize");
        resized = media.resize_to_fit(payload_bytes, &options).map_err(js_err)?;
    }

    encoder.use_media_from_media(media);

    call_phase(&progress, "embed");
    let report = encoder.hide_to_vec_report().map_err(js_err)?;

    call_phase(&progress, "verify");
    let (verified, verification) = verify(&report.output, password.as_deref(), &expected);

    let metrics = report.metrics();

    Ok(HideResult {
        bytes: Uint8Array::from(report.output.as_slice()),
        format: report.format.name().to_string(),
        kind: report.kind.as_str().to_string(),
        width: report.width,
        height: report.height,
        capacity_bytes: report.capacity_bytes,
        payload_bytes: report.payload_bytes,
        psnr: metrics.map(|m| m.psnr()),
        changed_ratio: metrics.map(|m| m.changed_ratio()),
        max_channel_delta: metrics.map(|m| m.max_channel_delta),
        verified,
        verification,
        resized,
    })
}

/// Reads the payload back out of the produced carrier and compares it with the
/// input, so a broken output is never handed to the user as a success.
fn verify(
    carrier: &[u8],
    password: Option<&str>,
    expected: &[(String, Vec<u8>)],
) -> (bool, String) {
    let above = || "could not be read back".to_string();

    let media = match Media::from_bytes(carrier, None) {
        Ok(media) => media,
        Err(err) => return (false, format!("the produced file {}: {err}", above())),
    };

    let mut api = unveil::prepare().from_media(media);
    if let Some(password) = password {
        api = api.using_password(password);
    }

    match api.execute_to_memory() {
        Ok(files) => {
            let mismatched: Vec<&str> = expected
                .iter()
                .filter(|(name, data)| {
                    !files
                        .iter()
                        .any(|(found_name, found_data)| found_name == name && found_data == data)
                })
                .map(|(name, _)| name.as_str())
                .collect();

            if mismatched.is_empty() {
                (
                    true,
                    format!(
                        "{} payload item(s) read back intact",
                        expected.len()
                    ),
                )
            } else {
                (
                    false,
                    format!("read back but mismatched: {}", mismatched.join(", ")),
                )
            }
        }
        Err(err) => (false, format!("the produced file {}: {err}", above())),
    }
}

/// One file that was unveiled from a carrier.
#[wasm_bindgen]
pub struct UnveiledFile {
    name: String,
    data: Uint8Array,
}

#[wasm_bindgen]
impl UnveiledFile {
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// zero copy access to the bytes, the buffer is handed to JS once
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Uint8Array {
        self.data.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> u32 {
        self.data.length()
    }
}

/// The result of an unveil operation.
#[wasm_bindgen]
pub struct UnveilResult {
    files: Array,
}

#[wasm_bindgen]
impl UnveilResult {
    /// array of [`UnveiledFile`]
    #[wasm_bindgen(getter)]
    pub fn files(&self) -> Array {
        self.files.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn count(&self) -> u32 {
        self.files.length()
    }
}

/// Extracts the hidden data from a carrier.
#[wasm_bindgen]
pub fn unveil(
    carrier: &[u8],
    carrier_hint: Option<String>,
    password: Option<String>,
) -> Result<UnveilResult, JsValue> {
    let media = Media::from_bytes(carrier, carrier_hint.as_deref()).map_err(js_err)?;

    let mut api = unveil::prepare().from_media(media);
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        api = api.using_password(Some(password));
    }

    let files = api.execute_to_memory().map_err(js_err)?;
    let result = Array::new();

    for (name, data) in files {
        let file = UnveiledFile {
            name,
            data: Uint8Array::from(data.as_slice()),
        };
        result.push(&JsValue::from(file));
    }

    Ok(UnveilResult { files: result })
}

/// Output formats this build can produce.
#[wasm_bindgen]
pub fn supported_output_formats() -> Array {
    let formats = Array::new();
    formats.push(&JsValue::from_str("png"));
    formats.push(&JsValue::from_str("webp"));
    if jxl::encoding_supported() {
        formats.push(&JsValue::from_str("jxl"));
    }
    formats
}

/// Whether this build can read JPEG XL carriers.
#[wasm_bindgen]
pub fn supports_jxl_input() -> bool {
    jxl::decoding_supported()
}

/// Whether this build can write JPEG XL carriers.
#[wasm_bindgen]
pub fn supports_jxl_output() -> bool {
    jxl::encoding_supported()
}

/// The version of the core library that is compiled into this module.
#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
