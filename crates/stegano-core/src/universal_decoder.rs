use bitstream_io::{BitWrite, BitWriter, LittleEndian};
use enum_dispatch::enum_dispatch;
use std::io::{BufWriter, Read, Result};

use crate::media::MediaPrimitive;

#[allow(unused)]
#[enum_dispatch]
pub enum UnveilAlgorithms {
    OneBitUnveil,
    MultiBitUnveil,
}

/// generic unveil algorithm
#[enum_dispatch(UnveilAlgorithms)]
pub trait UnveilAlgorithm {
    /// how many payload bits a single carrier sample carries
    fn density(&self) -> u8;

    /// the payload bits stored in one carrier sample, least significant first
    fn decode(&self, carrier: MediaPrimitive) -> u8;
}

/// generic stegano decoder
pub struct UniversalDecoder<I, A>
where
    I: Iterator<Item = MediaPrimitive>,
    A: UnveilAlgorithm,
{
    pub input: I,
    pub algorithm: A,
    position: usize,
}

/// generic stegano decoder constructor method
impl<I, A> UniversalDecoder<I, A>
where
    I: Iterator<Item = MediaPrimitive>,
    A: UnveilAlgorithm,
{
    pub fn new(input: I, algorithm: A) -> Self {
        UniversalDecoder {
            input,
            algorithm,
            position: 0,
        }
    }
}

impl<I, A> Read for UniversalDecoder<I, A>
where
    I: Iterator<Item = MediaPrimitive>,
    A: UnveilAlgorithm,
{
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        let bits_per_item = self.algorithm.density().max(1) as usize;
        let bits_wanted = buf.len() * 8;
        let buf_writer = BufWriter::new(buf);
        let mut bit_buffer = BitWriter::endian(buf_writer, LittleEndian);
        let mut bit_read: usize = 0;

        // samples only ever contribute whole groups, which keeps the carrier
        // position aligned with the byte boundary of the buffer
        while bit_read + bits_per_item <= bits_wanted {
            let Some(carrier) = self.input.next() else {
                break;
            };
            let bits = self.algorithm.decode(carrier);
            for shift in 0..bits_per_item {
                bit_buffer.write_bit((bits >> shift) & 0x1 == 1)?;
            }
            bit_read += bits_per_item;
        }

        if !bit_buffer.byte_aligned() {
            bit_buffer.byte_align()?
        }

        self.position += bit_read >> 3;

        Ok(bit_read >> 3)
    }
}

/// default 1 bit unveil strategy
#[derive(Debug)]
pub struct OneBitUnveil;
impl UnveilAlgorithm for OneBitUnveil {
    #[inline]
    fn density(&self) -> u8 {
        1
    }

    #[inline]
    fn decode(&self, carrier: MediaPrimitive) -> u8 {
        match carrier {
            MediaPrimitive::ImageColorChannel(b) => b & 0x1,
            MediaPrimitive::AudioSample(b) => (b & 0x1) as u8,
        }
    }
}

/// reads back what [`MultiBitHide`](crate::universal_encoder::MultiBitHide) wrote
#[derive(Debug)]
pub struct MultiBitUnveil {
    bits: u8,
}

impl MultiBitUnveil {
    /// `bits` is clamped to `1..=8`, mirroring the hiding algorithm
    pub fn new(bits: u8) -> Self {
        Self {
            bits: bits.clamp(1, 8),
        }
    }
}

impl UnveilAlgorithm for MultiBitUnveil {
    #[inline]
    fn density(&self) -> u8 {
        self.bits
    }

    #[inline]
    fn decode(&self, carrier: MediaPrimitive) -> u8 {
        let mask: u8 = if self.bits >= 8 {
            u8::MAX
        } else {
            (1u8 << self.bits) - 1
        };

        match carrier {
            MediaPrimitive::ImageColorChannel(b) => b & mask,
            MediaPrimitive::AudioSample(b) => (b as u8) & mask,
        }
    }
}
