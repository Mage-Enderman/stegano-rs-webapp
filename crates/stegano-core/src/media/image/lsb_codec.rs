use super::decoder::ImageRgbaColor;
use super::encoder::ImageRgbaColorMut;
use crate::universal_decoder::{OneBitUnveil, UniversalDecoder};
use crate::universal_encoder::{
    HideAlgorithms, OneBitHide, OneBitInLowFrequencyHide, UniversalEncoder,
};

use image::RgbaImage;
use std::io::{Read, Write};

#[derive(Debug)]
pub struct CodecOptions {
    /// determines the step with when iterating over the color channels.
    /// For example `2` would move from (R)GBA to RG(B)A.
    /// Depending on if the alpha channel is skipped (`skip_alpha_channel`) it would either
    /// not count alpha at all or it does.
    ///
    /// For example `2` with alpha skipped would move from RG(B)A to R(G)BA on the next pixel because alpha does not count.
    /// Where as when alpha is not skipped it would would move from RG(B)A to (R)GBA on the next pixel.
    ///
    /// Note this number influences the capacity directly.
    pub color_channel_step_increment: usize,

    /// If true no alpha channel would be used for encoding,
    /// this reduces then the capacity by one bit per pixel
    pub skip_alpha_channel: bool,

    /// the concealer strategy, decides on where in a color channel things are going to be stored.
    pub concealer: Concealer,

    /// This limits all iterations to skip the least column and row, in fact it reduces width and height of the image by 1
    pub skip_last_row_and_column: bool,
}

#[derive(Debug, Ord, PartialOrd, Eq, PartialEq)]
pub enum Concealer {
    LeastSignificantBit,
    LowFrequencies,
}

impl Default for CodecOptions {
    /// The good old golden options
    fn default() -> Self {
        Self {
            color_channel_step_increment: 1,
            skip_alpha_channel: true,
            concealer: Concealer::LeastSignificantBit,
            skip_last_row_and_column: true,
        }
    }
}

impl CodecOptions {
    pub fn get_color_channel_step_increment(&self) -> usize {
        self.color_channel_step_increment
    }

    pub fn get_skip_alpha_channel(&self) -> bool {
        self.skip_alpha_channel
    }

    pub fn get_skip_last_row_and_column(&self) -> bool {
        self.skip_last_row_and_column
    }

    /// The dimensions that actually take part in the encoding.
    pub fn usable_dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        if self.skip_last_row_and_column {
            (width.saturating_sub(1), height.saturating_sub(1))
        } else {
            (width, height)
        }
    }

    /// How many payload bytes fit into an image of the given dimensions.
    ///
    /// One bit is stored per used color channel, therefore the capacity is
    /// `used_pixels * channels / step / 8`.
    pub fn image_capacity_bytes(&self, width: u32, height: u32) -> usize {
        let (w, h) = self.usable_dimensions(width, height);
        let channels = if self.skip_alpha_channel { 3 } else { 4 };
        let step = self.color_channel_step_increment.max(1);
        (w as usize * h as usize * channels / step) / 8
    }
}

/// Factory for decoder and encoder
pub struct LsbCodec;

impl LsbCodec {
    /// builds a LSB Image Decoder that implements Read
    pub fn decoder<'i>(input: &'i RgbaImage, opts: &CodecOptions) -> Box<dyn Read + 'i> {
        Box::new(UniversalDecoder::new(
            ImageRgbaColor::new_with_options(input, opts),
            match opts.concealer {
                Concealer::LeastSignificantBit => OneBitUnveil,
                Concealer::LowFrequencies => OneBitUnveil,
            },
        ))
    }

    /// builds a LSB Image Encoder that implements Write
    pub fn encoder<'i>(carrier: &'i mut RgbaImage, opts: &CodecOptions) -> Box<dyn Write + 'i> {
        Box::new(Self::stats_encoder(carrier, opts))
    }

    /// builds a LSB Image Encoder that exposes the embedding statistics
    pub fn stats_encoder<'i>(
        carrier: &'i mut RgbaImage,
        opts: &CodecOptions,
    ) -> UniversalEncoder<'i, ImageRgbaColorMut<'i>, HideAlgorithms> {
        let algorithm: HideAlgorithms = match opts.concealer {
            Concealer::LeastSignificantBit => OneBitHide.into(),
            Concealer::LowFrequencies => OneBitInLowFrequencyHide.into(),
        };
        UniversalEncoder::new(
            ImageRgbaColorMut::new_with_options(carrier, opts),
            algorithm,
        )
    }
}

#[cfg(feature = "benchmarks")]
#[allow(unused_imports)] // clippy false positive, on nightly when `cargo bench` is called
mod benchmarks {
    use super::LsbCodec;
    use super::*;

    /// Benchmark for decoding an image
    #[bench]
    fn image_decoding(b: &mut test::Bencher) {
        let img = image::open("tests/images/with_text/hello_world.png")
            .expect("Input image is not readable.")
            .to_rgba8();
        let mut buf = [0; 13];

        b.iter(|| {
            UniversalDecoder::new(ImageRgbaColor::new(&img), OneBitUnveil)
                .read_exact(&mut buf)
                .expect("Failed to read 13 bytes");
        })
    }

    /// Benchmark for encoding an image
    #[bench]
    fn image_encoding(b: &mut test::Bencher) {
        let mut plain_image = image::open("tests/images/plain/carrier-image.png")
            .expect("Input image is not readable.")
            .to_rgba8();
        let secret_message = b"Hello World!";

        b.iter(|| {
            UniversalEncoder::new(ImageRgbaColorMut::new(&mut plain_image), OneBitHide)
                .write_all(&secret_message[..])
                .expect("Cannot write secret message");
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_skips_the_reserved_border_and_alpha() {
        let opts = CodecOptions::default();
        // 10x10 image: 9 * 9 usable pixels, 3 channels each, 8 bits per byte
        assert_eq!(opts.image_capacity_bytes(10, 10), (9 * 9 * 3) / 8);
        assert_eq!(opts.usable_dimensions(10, 10), (9, 9));
    }

    #[test]
    fn capacity_without_border_reservation_uses_all_pixels() {
        let opts = CodecOptions {
            skip_last_row_and_column: false,
            ..CodecOptions::default()
        };
        assert_eq!(opts.image_capacity_bytes(10, 10), (10 * 10 * 3) / 8);
    }

    #[test]
    fn should_decode() {
        let image_with_secret = image::open("tests/images/secrets/image-with-hello-world.png")
            .expect("Cannot open secret image")
            .to_rgba8();

        let mut buf = vec![0; 13];
        LsbCodec::decoder(&image_with_secret, &CodecOptions::default())
            .read_exact(&mut buf[..])
            .expect("Cannot read 13 bytes from codec");

        let msg = String::from_utf8(buf).expect("Cannot convert result to string");
        assert_eq!(msg, "\u{1}Hello World!");
    }

    #[test]
    fn should_encode() {
        let mut plain_image = image::open("tests/images/plain/carrier-image.png")
            .expect("Cannot open carrier image")
            .to_rgba8();
        let secret_message = "Hello World!".as_bytes();

        {
            LsbCodec::encoder(&mut plain_image, &CodecOptions::default())
                .write_all(secret_message)
                .expect("Cannot write to codec");
        }
        let mut buf = vec![0; secret_message.len()];
        LsbCodec::decoder(&plain_image, &CodecOptions::default())
            .read_exact(&mut buf[..])
            .expect("Cannot read 12 bytes from codec");

        let msg = String::from_utf8(buf).expect("Cannot convert result to string");
        assert_eq!(msg, "Hello World!");
    }
}
