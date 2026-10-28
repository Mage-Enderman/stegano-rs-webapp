use image::RgbaImage;

use crate::{Result, SteganoError};

/// JPEG XL codestream signature (`0xFF0A`)
const JXL_CODESTREAM_SIGNATURE: [u8; 2] = [0xFF, 0x0A];
/// JPEG XL container signature: 4 byte box length followed by `JXL `
const JXL_CONTAINER_SIGNATURE: [u8; 4] = [0x4A, 0x58, 0x4C, 0x20];

/// Detects a JPEG XL file by its signature, independent of the file name.
pub fn is_jxl(data: &[u8]) -> bool {
    data.starts_with(&JXL_CODESTREAM_SIGNATURE)
        || (data.len() > 12
            && data[0..4] == [0x00, 0x00, 0x00, 0x0C]
            && data[4..8] == JXL_CONTAINER_SIGNATURE)
}

/// Whether this build is able to read JPEG XL images.
pub const fn decoding_supported() -> bool {
    cfg!(feature = "jxl")
}

/// Whether this build is able to write JPEG XL images.
pub const fn encoding_supported() -> bool {
    cfg!(feature = "jxl-encode")
}

/// Decodes a JPEG XL image into an RGBA8 buffer.
///
/// No color transformation is requested, so the pixel values are the ones
/// stored in the file. That is required to keep an embedded payload readable
/// after a decode / encode round trip.
#[cfg(feature = "jxl")]
pub fn decode(data: &[u8]) -> Result<RgbaImage> {
    use jxl_oxide::JxlImage;
    use std::io::Cursor;

    let image = JxlImage::builder()
        .read(Cursor::new(data))
        .map_err(|e| SteganoError::JxlDecodeError(e.to_string()))?;

    let render = image
        .render_frame(0)
        .map_err(|e| SteganoError::JxlDecodeError(e.to_string()))?;

    let mut stream = render.stream();
    let width = stream.width();
    let height = stream.height();
    let channels = stream.channels().max(1) as usize;

    let mut buf = vec![0u8; width as usize * height as usize * channels];
    let mut written = 0;
    while written < buf.len() {
        let n = stream.write_to_buffer::<u8>(&mut buf[written..]);
        if n == 0 {
            break;
        }
        written += n;
    }

    if written < buf.len() {
        return Err(SteganoError::JxlDecodeError(format!(
            "expected {} samples, but only {} could be rendered",
            buf.len(),
            written
        )));
    }

    match channels {
        1 => {
            // grayscale: expand to rgb
            let mut out = Vec::with_capacity(width as usize * height as usize * 4);
            for gray in buf {
                out.extend_from_slice(&[gray, gray, gray, 255]);
            }
            RgbaImage::from_raw(width, height, out).ok_or_else(|| {
                SteganoError::JxlDecodeError("failed to build grayscale image".to_string())
            })
        }
        2 => {
            // grayscale + alpha
            let mut out = Vec::with_capacity(width as usize * height as usize * 4);
            for px in buf.chunks_exact(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
            RgbaImage::from_raw(width, height, out).ok_or_else(|| {
                SteganoError::JxlDecodeError("failed to build grayscale image".to_string())
            })
        }
        3 => {
            let mut out = Vec::with_capacity(width as usize * height as usize * 4);
            for px in buf.chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            RgbaImage::from_raw(width, height, out).ok_or_else(|| {
                SteganoError::JxlDecodeError("failed to build rgb image".to_string())
            })
        }
        _ => RgbaImage::from_raw(width, height, buf.take(channels)).ok_or_else(|| {
            SteganoError::JxlDecodeError("failed to build rgba image".to_string())
        }),
    }
}

#[cfg(not(feature = "jxl"))]
pub fn decode(_data: &[u8]) -> Result<RgbaImage> {
    Err(SteganoError::UnsupportedOutputFormat("jxl"))
}

/// Encodes an image as a lossless (modular) JPEG XL file.
#[cfg(feature = "jxl-encode")]
pub fn encode_lossless(img: &RgbaImage) -> Result<Vec<u8>> {
    use jxl_encoder::{LosslessConfig, PixelLayout};

    LosslessConfig::new()
        .with_effort(5)
        // jxl-oxide cannot decode the ANS entropy coded modular streams that
        // jxl-encoder emits from effort 3 upwards (it fails with an unexpected
        // end of file). Huffman coding keeps the output readable by every
        // decoder we ship, at the cost of roughly a quarter of the file size.
        // Revisit once jxl-oxide supports those streams.
        .with_ans(false)
        .encode(
            img.as_raw(),
            img.width(),
            img.height(),
            PixelLayout::Rgba8,
        )
        .map_err(|e| SteganoError::JxlEncodeError(e.to_string()))
}

#[cfg(not(feature = "jxl-encode"))]
pub fn encode_lossless(_img: &RgbaImage) -> Result<Vec<u8>> {
    Err(SteganoError::UnsupportedOutputFormat(
        "jxl (build without the `jxl-encode` feature)",
    ))
}

/// Drains the first `channels` samples of every pixel into an RGBA buffer.
#[cfg(feature = "jxl")]
trait TakeChannels {
    fn take(self, channels: usize) -> Vec<u8>;
}

#[cfg(feature = "jxl")]
impl TakeChannels for Vec<u8> {
    fn take(self, channels: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len());
        for px in self.chunks_exact(channels) {
            out.extend_from_slice(&px[..4.min(channels)]);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_detect_codestream_signature() {
        assert!(is_jxl(&[0xFF, 0x0A, 0x00, 0x00]));
    }

    #[test]
    fn should_detect_container_signature() {
        let mut data = vec![0x00, 0x00, 0x00, 0x0C];
        data.extend_from_slice(b"JXL ");
        data.extend_from_slice(&[0u8; 8]);
        assert!(is_jxl(&data));
    }

    #[test]
    fn should_not_detect_png_as_jxl() {
        assert!(!is_jxl(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]));
        assert!(!is_jxl(b"RIFF"));
    }
}
