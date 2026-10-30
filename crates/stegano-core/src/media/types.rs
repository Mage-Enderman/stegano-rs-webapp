use std::io::{Cursor, Read, Write};
use std::path::Path;

pub use hound::{WavReader, WavSpec, WavWriter};
pub use image::RgbaImage;
use log::error;

use crate::error::SteganoError;
use crate::media::audio::LsbCodec as AudioLsbCodec;
use crate::media::image::jxl;
use crate::media::image::metrics::EncodeStats;
use crate::media::image::{CodecOptions, LsbCodec as ImageLsbCodec};
use crate::media::output::OutputFormat;
use crate::result::Result;

use super::Persist;

pub type WavAudio = (WavSpec, Vec<i16>);

/// The kind of carrier media, independent of its concrete pixel/sample storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Audio,
}

impl MediaKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }
}

/// a media container for steganography
#[derive(Debug)]
pub enum Media {
    Image(RgbaImage),
    Audio(WavAudio),
}

impl Media {
    pub fn from_image(img: RgbaImage) -> Self {
        Self::Image(img)
    }

    pub fn from_audio(audio: WavAudio) -> Self {
        Self::Audio(audio)
    }

    pub fn from_file(f: &Path) -> Result<Self> {
        let Some(ext) = f.extension().and_then(|e| e.to_str()) else {
            return Err(SteganoError::UnsupportedMedia);
        };
        let ext = ext.to_lowercase();
        match ext.as_str() {
            "wav" => {
                let data =
                    std::fs::read(f).map_err(|source| SteganoError::WriteError { source })?;
                Self::from_wav_bytes(&data)
            }
            "jxl" => {
                let data =
                    std::fs::read(f).map_err(|source| SteganoError::WriteError { source })?;
                Ok(Self::Image(jxl::decode(&data)?))
            }
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "pnm" | "tga"
            | "dds" | "ico" | "hdr" | "exr" => Ok(Self::Image(
                image::open(f)
                    .map_err(|_e| SteganoError::InvalidImageMedia)?
                    .to_rgba8(),
            )),
            _ => Err(SteganoError::UnsupportedMedia),
        }
    }

    /// Builds a media from raw bytes, detecting the container by its magic bytes.
    ///
    /// `hint` is the file extension or format name, used as a secondary signal
    /// for formats that share a signature with other containers.
    pub fn from_bytes(data: &[u8], hint: Option<&str>) -> Result<Self> {
        let hint = hint
            .map(|h| h.trim_start_matches('.').to_ascii_lowercase())
            .unwrap_or_default();

        let is_wav = data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE";
        if is_wav || hint == "wav" || hint == "audio/wav" || hint == "audio/x-wav" {
            return Self::from_wav_bytes(data);
        }

        if jxl::is_jxl(data) || hint == "jxl" || hint == "image/jxl" {
            return Ok(Self::Image(jxl::decode(data)?));
        }

        let img = image::load_from_memory(data).map_err(|e| {
            error!("Failed to load image media: {e}");
            SteganoError::InvalidImageMedia
        })?;

        Ok(Self::Image(img.to_rgba8()))
    }

    /// Builds an audio media from WAV bytes.
    ///
    /// Only integer samples of 16 bit are supported, which is what the LSB
    /// codec needs. Other WAV encodings are rejected instead of being silently
    /// reinterpreted.
    pub fn from_wav_bytes(data: &[u8]) -> Result<Self> {
        let reader = WavReader::new(Cursor::new(data)).map_err(|e| {
            error!("Failed to read wav: {e}");
            SteganoError::InvalidAudioMedia
        })?;
        Self::from_wav_reader(reader)
    }

    fn from_wav_reader<R: Read>(mut reader: WavReader<R>) -> Result<Self> {
        let spec = reader.spec();
        if spec.bits_per_sample != 16 || spec.sample_format != hound::SampleFormat::Int {
            error!(
                "Unsupported wav sample format: {} bit, {:?}",
                spec.bits_per_sample, spec.sample_format
            );
            return Err(SteganoError::InvalidAudioMedia);
        }

        let samples: Vec<i16> = reader
            .samples::<i16>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| {
                error!("Failed to read wav samples: {e}");
                SteganoError::InvalidAudioMedia
            })?;

        Ok(Self::Audio((spec, samples)))
    }

    pub fn kind(&self) -> MediaKind {
        match self {
            Self::Image(_) => MediaKind::Image,
            Self::Audio(_) => MediaKind::Audio,
        }
    }

    /// the pixel dimensions of an image carrier, `None` for audio
    pub fn dimensions(&self) -> Option<(u32, u32)> {
        match self {
            Self::Image(i) => Some(i.dimensions()),
            Self::Audio(_) => None,
        }
    }

    /// how many bytes of payload this carrier can hold with the given options
    pub fn capacity_bytes(&self, opts: &CodecOptions) -> usize {
        match self {
            Self::Image(i) => opts.image_capacity_bytes(i.width(), i.height()),
            Self::Audio((_spec, samples)) => samples.len() / 8,
        }
    }

    /// Scales an image carrier up until `needed_bytes` fit into it.
    ///
    /// Returns `true` when the image was resized. Audio carriers cannot be
    /// resized and yield a capacity error instead. The aspect ratio is kept.
    pub fn resize_to_fit(&mut self, needed_bytes: usize, opts: &CodecOptions) -> Result<bool> {
        match self {
            Media::Image(img) => {
                if opts.image_capacity_bytes(img.width(), img.height()) >= needed_bytes {
                    return Ok(false);
                }
                let (width, height) = img.dimensions();
                let (w, h) = suggested_dimensions(width, height, needed_bytes, opts);
                if w as u32 <= width && h as u32 <= height {
                    return Err(SteganoError::ImageCapacityError(
                        width as _,
                        height as _,
                        w,
                        h,
                    ));
                }
                *img = image::imageops::resize(
                    img,
                    w as u32,
                    h as u32,
                    image::imageops::FilterType::Lanczos3,
                );
                Ok(true)
            }
            Media::Audio((_spec, samples)) => {
                let capacity = samples.len() / 8;
                if needed_bytes > capacity {
                    return Err(SteganoError::AudioCapacityError(capacity, needed_bytes));
                }
                Ok(false)
            }
        }
    }

    pub fn hide_data(&mut self, msg_data: Vec<u8>, opts: &CodecOptions) -> Result<&mut Self> {
        self.hide_data_with_stats(msg_data, opts)?;
        Ok(self)
    }

    /// Embeds the payload and reports how much of the carrier was modified.
    ///
    /// Fails with a capacity error when the payload does not fit, instead of
    /// letting the codec run into a partial write.
    pub fn hide_data_with_stats(
        &mut self,
        msg_data: Vec<u8>,
        opts: &CodecOptions,
    ) -> Result<EncodeStats> {
        match self {
            Media::Image(i) => {
                let (width, height) = i.dimensions();
                let capacity = opts.image_capacity_bytes(width, height);
                if msg_data.len() > capacity {
                    let (w, h) = suggested_dimensions(width, height, msg_data.len(), opts);
                    return Err(SteganoError::ImageCapacityError(
                        width as _,
                        height as _,
                        w,
                        h,
                    ));
                }

                let mut encoder = ImageLsbCodec::stats_encoder(i, opts);
                encoder.write_all(msg_data.as_ref()).map_err(|e| {
                    error!("Error encoding image: {e}, kind {}", e.kind());
                    SteganoError::ImageEncodingError
                })?;

                Ok(encoder.stats())
            }
            Media::Audio((_spec, samples)) => {
                let capacity = samples.len() / 8;
                if msg_data.len() > capacity {
                    return Err(SteganoError::AudioCapacityError(capacity, msg_data.len()));
                }

                let mut encoder = AudioLsbCodec::stats_encoder(samples);
                encoder.write_all(msg_data.as_ref()).map_err(|e| {
                    error!("Error encoding audio: {e}, kind {}", e.kind());
                    SteganoError::AudioEncodingError
                })?;

                Ok(encoder.stats())
            }
        }
    }

    /// Writes the media into a byte buffer in the given output format.
    pub fn save_to_vec(&mut self, format: OutputFormat) -> Result<Vec<u8>> {
        match self {
            Media::Image(img) => match format {
                OutputFormat::Jxl => jxl::encode_lossless(img),
                other => {
                    let image_format = other
                        .to_image_format()
                        .ok_or(SteganoError::UnsupportedOutputFormat(other.name()))?;
                    let mut buf = Cursor::new(Vec::new());
                    img.write_to(&mut buf, image_format).map_err(|e| {
                        error!("Error saving image: {e}");
                        SteganoError::ImageEncodingError
                    })?;
                    Ok(buf.into_inner())
                }
            },
            Media::Audio((spec, samples)) => {
                let mut buf = Cursor::new(Vec::new());
                {
                    let mut writer = WavWriter::new(&mut buf, *spec)
                        .map_err(|_| SteganoError::AudioCreationError)?;
                    for sample in samples.iter() {
                        writer
                            .write_sample(*sample)
                            .map_err(|_| SteganoError::AudioEncodingError)?;
                    }
                    writer
                        .finalize()
                        .map_err(|_| SteganoError::AudioEncodingError)?;
                }
                Ok(buf.into_inner())
            }
        }
    }
}

/// Estimates the dimensions an image needs so that `needed_bytes` fit into it.
fn suggested_dimensions(
    width: u32,
    height: u32,
    needed_bytes: usize,
    opts: &CodecOptions,
) -> (usize, usize) {
    let channels = if opts.get_skip_alpha_channel() { 3 } else { 4 };
    let step = opts.get_color_channel_step_increment().max(1);
    let bits = opts.get_bits_per_channel() as f64;
    let needed_pixels = (needed_bytes as f64 * 8.0 * step as f64 / (channels as f64 * bits)).ceil();
    let current_pixels = (width.max(1) as f64) * (height.max(1) as f64);
    let scale = (needed_pixels / current_pixels).sqrt();

    let mut w = (width.max(1) as f64 * scale).ceil() as usize;
    let mut h = (height.max(1) as f64 * scale).ceil() as usize;
    if opts.skip_last_row_and_column {
        // the last row and column are reserved and do not carry data
        w += 1;
        h += 1;
    }
    (w, h)
}

impl Persist for Media {
    fn save_as(&mut self, file: &Path) -> Result<()> {
        let format = file
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(OutputFormat::from_name)
            .unwrap_or_default();

        if !format.preserves_pixels() {
            return Err(SteganoError::LossyOutputFormat(format.name()));
        }

        let bytes = self.save_to_vec(format)?;
        std::fs::write(file, bytes).map_err(|source| SteganoError::WriteError { source })
    }
}

impl Media {
    pub fn save_to_writer<W: std::io::Write + std::io::Seek>(
        &mut self,
        mut writer: W,
        format: image::ImageFormat,
    ) -> Result<()> {
        match self {
            Media::Image(i) => i.write_to(&mut writer, format).map_err(|e| {
                error!("Error saving image: {e}");
                SteganoError::ImageEncodingError
            }),
            Media::Audio((spec, samples)) => {
                let mut wav_writer =
                    WavWriter::new(writer, *spec).map_err(|_| SteganoError::AudioCreationError)?;
                if let Some(error) = samples
                    .iter()
                    .map(|s| {
                        wav_writer
                            .write_sample(*s)
                            .map_err(|_| SteganoError::AudioEncodingError)
                    })
                    .filter_map(Result::err)
                    .next()
                {
                    return Err(error);
                }
                wav_writer
                    .finalize()
                    .map_err(|_| SteganoError::AudioEncodingError)?;

                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARRIER: &str = "tests/images/plain/carrier-image.png";

    #[test]
    fn should_report_kind_and_dimensions() {
        let img = image::open(CARRIER).unwrap().to_rgba8();
        let media = Media::from_image(img);
        assert_eq!(media.kind(), MediaKind::Image);
        assert!(media.dimensions().is_some());
    }

    #[test]
    fn capacity_is_three_channels_per_pixel_without_border() {
        let img = image::open(CARRIER).unwrap().to_rgba8();
        let (w, h) = img.dimensions();
        let media = Media::from_image(img);
        let expected = ((w as usize - 1) * (h as usize - 1) * 3) / 8;
        assert_eq!(media.capacity_bytes(&CodecOptions::default()), expected);
    }

    #[test]
    fn should_decode_wav_bytes() {
        let data = std::fs::read("tests/audio/plain/carrier-audio.wav").unwrap();
        let media = Media::from_wav_bytes(&data).unwrap();
        assert_eq!(media.kind(), MediaKind::Audio);
        assert!(media.capacity_bytes(&CodecOptions::default()) > 0);
    }

    #[test]
    fn should_detect_wav_by_magic_bytes() {
        let data = std::fs::read("tests/audio/plain/carrier-audio.wav").unwrap();
        let media = Media::from_bytes(&data, Some("bin")).unwrap();
        assert_eq!(media.kind(), MediaKind::Audio);
    }

    #[test]
    fn should_reject_non_wav_audio_data() {
        assert!(matches!(
            Media::from_wav_bytes(b"not a wav file at all"),
            Err(SteganoError::InvalidAudioMedia)
        ));
    }

    #[test]
    fn should_reject_payloads_that_do_not_fit() {
        let img = image::open(CARRIER).unwrap().to_rgba8();
        let mut media = Media::from_image(img);
        let too_big = vec![0u8; media.capacity_bytes(&CodecOptions::default()) + 1];
        assert!(matches!(
            media.hide_data_with_stats(too_big, &CodecOptions::default()),
            Err(SteganoError::ImageCapacityError(..))
        ));
    }

    #[test]
    fn should_round_trip_audio_through_bytes() {
        let data = std::fs::read("tests/audio/plain/carrier-audio.wav").unwrap();
        let mut media = Media::from_wav_bytes(&data).unwrap();
        let out = media.save_to_vec(OutputFormat::Png).unwrap();
        assert_eq!(&out[0..4], b"RIFF");
    }
}
