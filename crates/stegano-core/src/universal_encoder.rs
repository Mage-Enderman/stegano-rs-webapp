use bitstream_io::{BitRead, BitReader, LittleEndian};
use enum_dispatch::enum_dispatch;
use std::io::{Cursor, Result, Write};

use crate::media::image::metrics::EncodeStats;
use crate::media::MediaPrimitiveMut;

#[enum_dispatch]
pub enum HideAlgorithms {
    OneBitHide,
    OneBitInLowFrequencyHide,
    MultiBitHide,
}

/// generic hiding algorithm, used for specific ones like LSB
#[enum_dispatch(HideAlgorithms)]
pub trait HideAlgorithm {
    /// how many payload bits this algorithm stores in a single carrier sample
    fn density(&self) -> u8;

    /// hides the payload bits contained in `information` in the carrier sample
    /// and reports how far the sample value had to move, `0` meaning untouched
    fn encode(&self, carrier: MediaPrimitiveMut, information: &Result<u8>) -> u32;
}

/// generic stegano encoder
pub struct UniversalEncoder<'c, C, A>
where
    C: Iterator<Item = MediaPrimitiveMut<'c>>,
    A: HideAlgorithm,
{
    pub carrier: C,
    pub algorithm: A,
    stats: EncodeStats,
}

impl<'c, C, A> UniversalEncoder<'c, C, A>
where
    C: Iterator<Item = MediaPrimitiveMut<'c>>,
    A: HideAlgorithm,
{
    pub fn new(carrier: C, algorithm: A) -> Self {
        UniversalEncoder {
            carrier,
            algorithm,
            stats: EncodeStats::default(),
        }
    }

    /// how many carrier primitives were consumed and how many of them changed
    pub fn stats(&self) -> EncodeStats {
        self.stats
    }
}

impl<'c, C, A> Write for UniversalEncoder<'c, C, A>
where
    C: Iterator<Item = MediaPrimitiveMut<'c>>,
    A: HideAlgorithm,
{
    #[inline]
    fn write(&mut self, buf: &[u8]) -> Result<usize> {
        // the algorithm decides how many bits of the payload fit into one sample
        let bits_per_item = self.algorithm.density().max(1) as u32;
        let bits_available = (buf.len() as u64) << 3;
        let mut bit_iter = BitReader::endian(Cursor::new(buf), LittleEndian);
        let mut bits_written: u64 = 0;
        let mut items_used: usize = 0;

        // only whole groups are consumed, so the carrier position always stays
        // aligned with the payload byte boundary between `write` calls
        while bits_written + u64::from(bits_per_item) <= bits_available {
            let Some(s) = self.carrier.next() else {
                break;
            };
            let information = bit_iter.read_var::<u8>(bits_per_item);

            // count the distortion the algorithm is about to introduce
            let delta = self.algorithm.encode(s, &information);
            if delta > 0 {
                self.stats.bits_changed += 1;
                self.stats.squared_error += u64::from(delta) * u64::from(delta);
                self.stats.max_delta = self.stats.max_delta.max(delta);
            }

            bits_written += u64::from(bits_per_item);
            items_used += 1;
        }

        self.stats.bits_written += items_used;

        Ok((bits_written >> 3) as usize)
    }

    fn flush(&mut self) -> Result<()> {
        Ok(())
    }
}

/// default 1 bit hiding strategy
#[derive(Debug)]
pub struct OneBitHide;
impl HideAlgorithm for OneBitHide {
    #[inline(always)]
    fn density(&self) -> u8 {
        1
    }

    #[inline(always)]
    fn encode(&self, carrier: MediaPrimitiveMut, information: &Result<u8>) -> u32 {
        let Ok(bit) = information else {
            return 0;
        };
        let bit = bit & 0x1 == 1;
        match carrier {
            MediaPrimitiveMut::ImageColorChannel(b) => {
                let old = *b;
                *b = (old & (u8::MAX - 1)) | if bit { 1 } else { 0 };
                old.abs_diff(*b) as u32
            }
            MediaPrimitiveMut::AudioSample(b) => {
                let old = *b;
                *b = (old & (i16::MAX - 1)) | if bit { 1 } else { 0 };
                old.abs_diff(*b) as u32
            }
        }
    }
}

/// 1 bit hiding strategy, but
#[derive(Debug)]
pub struct OneBitInLowFrequencyHide;
impl HideAlgorithm for OneBitInLowFrequencyHide {
    #[inline(always)]
    fn density(&self) -> u8 {
        1
    }

    #[inline(always)]
    fn encode(&self, carrier: MediaPrimitiveMut, information: &Result<u8>) -> u32 {
        let Ok(bit) = information else {
            return 0;
        };
        let bit = bit & 0x1 == 1;
        match carrier {
            MediaPrimitiveMut::ImageColorChannel(b) => {
                let old = *b;
                *b = (old & 0b11110000) | if bit { 0b00001111 } else { 0 };
                old.abs_diff(*b) as u32
            }
            MediaPrimitiveMut::AudioSample(b) => {
                let old = *b;
                *b = (old & (0b11111111 << 8)) | if bit { 0b000000011111111 } else { 0 };
                old.abs_diff(*b) as u32
            }
        }
    }
}

/// hides several payload bits in every carrier sample.
///
/// One bit per channel is invisible, every additional bit doubles the capacity
/// and eats one more bit of the sample, which quickly becomes visible noise.
/// This is the counterpart of [`OneBitHide`] for carriers where capacity
/// matters more than the fidelity of the image.
#[derive(Debug)]
pub struct MultiBitHide {
    bits: u8,
}

impl MultiBitHide {
    /// `bits` is clamped to `1..=8`, one bit being the classic LSB embed
    pub fn new(bits: u8) -> Self {
        Self {
            bits: bits.clamp(1, 8),
        }
    }
}

impl HideAlgorithm for MultiBitHide {
    #[inline(always)]
    fn density(&self) -> u8 {
        self.bits
    }

    #[inline(always)]
    fn encode(&self, carrier: MediaPrimitiveMut, information: &Result<u8>) -> u32 {
        let Ok(bits) = information else {
            return 0;
        };
        let mask: u8 = if self.bits >= 8 {
            u8::MAX
        } else {
            (1u8 << self.bits) - 1
        };

        match carrier {
            MediaPrimitiveMut::ImageColorChannel(b) => {
                let old = *b;
                *b = (old & !mask) | (bits & mask);
                old.abs_diff(*b) as u32
            }
            MediaPrimitiveMut::AudioSample(b) => {
                let old = *b;
                // `bits` holds at most 8 bits, the 16 bit sample keeps its sign
                let new = (old & !i16::from(mask)) | i16::from(bits & mask);
                *b = new;
                old.abs_diff(new) as u32
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_encode_in_lower_frequencies() {
        let encoder = OneBitInLowFrequencyHide;
        let mut data = 0b11001101;
        {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(mp, &Ok(1));
        }
        assert_eq!(data, 0b11001111);
    }

    #[test]
    fn should_not_harm_on_error() {
        let encoder = OneBitHide;
        let mut data = 0b00001110;
        {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(
                mp,
                &Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
            );
        }
        assert_eq!(data, 0b00001110);
    }

    #[test]
    fn should_encode_one_bit() {
        let encoder = OneBitHide;
        let mut data = 0b00001110;
        {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(mp, &Ok(1));
        }
        assert_eq!(data, 0b00001111);

        let mut data = 0b00001110;
        {
            let mp = MediaPrimitiveMut::AudioSample(&mut data);
            encoder.encode(mp, &Ok(1));
        }
        assert_eq!(data, 0b00001111);

        let mut data = 0b00001110;
        {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(mp, &Ok(0));
        }
        assert_eq!(data, 0b00001110);

        let mut data = 0b00001110;
        {
            let mp = MediaPrimitiveMut::AudioSample(&mut data);
            encoder.encode(mp, &Ok(0));
        }
        assert_eq!(data, 0b00001110);
    }

    #[test]
    fn multi_bit_hides_the_low_bits_and_reports_the_change() {
        let encoder = MultiBitHide::new(2);
        assert_eq!(encoder.density(), 2);

        let mut data = 0b1010_0000;
        let delta = {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(mp, &Ok(0b11))
        };
        assert_eq!(data, 0b1010_0011);
        assert_eq!(delta, 3);

        // an already matching sample is left alone
        let mut data = 0b1010_0011;
        let delta = {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(mp, &Ok(0b11))
        };
        assert_eq!(data, 0b1010_0011);
        assert_eq!(delta, 0);
    }

    #[test]
    fn multi_bit_leaves_the_high_bits_of_a_sample_alone() {
        let encoder = MultiBitHide::new(4);
        let mut data = 0b1100_1010;
        {
            let mp = MediaPrimitiveMut::ImageColorChannel(&mut data);
            encoder.encode(mp, &Ok(0b0101));
        }
        assert_eq!(data, 0b1100_0101);
    }
}
