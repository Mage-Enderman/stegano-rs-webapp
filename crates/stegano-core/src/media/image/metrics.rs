/// Quality statistics of an embedding operation.
///
/// The LSB concealers change a sample by at most one step, so the distortion
/// can be derived directly from the number of bits that had to be flipped
/// instead of comparing two full copies of the image.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EncodeStats {
    /// number of carrier primitives (bits) that were consumed
    pub bits_written: usize,
    /// number of carrier primitives whose value actually changed
    pub bits_changed: usize,
}

impl EncodeStats {
    pub fn new(bits_written: usize, bits_changed: usize) -> Self {
        Self {
            bits_written,
            bits_changed,
        }
    }
}

/// Image quality metrics for a carrier that had data embedded into it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageMetrics {
    pub changed_channels: usize,
    pub used_channels: usize,
    pub max_channel_delta: u8,
}

impl ImageMetrics {
    /// derives the metrics of an LSB embedding from its encode statistics
    pub fn from_lsb_stats(stats: EncodeStats) -> Self {
        Self {
            changed_channels: stats.bits_changed,
            used_channels: stats.bits_written,
            // an LSB embed changes a channel by exactly one step or not at all
            max_channel_delta: if stats.bits_changed > 0 { 1 } else { 0 },
        }
    }

    /// share of the used channels that were modified, `0.0..=1.0`
    pub fn changed_ratio(&self) -> f64 {
        if self.used_channels == 0 {
            0.0
        } else {
            self.changed_channels as f64 / self.used_channels as f64
        }
    }

    /// peak signal to noise ratio in dB, `f64::INFINITY` when nothing changed
    pub fn psnr(&self) -> f64 {
        if self.changed_channels == 0 || self.used_channels == 0 {
            return f64::INFINITY;
        }
        // every changed 8 bit channel contributes a squared error of 1
        let mse = self.changed_channels as f64 / self.used_channels as f64;
        10.0 * (255.0f64 * 255.0 / mse).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_carrier_has_infinite_psnr() {
        let m = ImageMetrics::from_lsb_stats(EncodeStats::new(1000, 0));
        assert!(m.psnr().is_infinite());
        assert_eq!(m.changed_ratio(), 0.0);
        assert_eq!(m.max_channel_delta, 0);
    }

    #[test]
    fn half_of_the_channels_changed_yields_about_51_db() {
        let m = ImageMetrics::from_lsb_stats(EncodeStats::new(2000, 1000));
        assert_eq!(m.changed_ratio(), 0.5);
        // mse = 0.5 -> psnr = 10 * log10(65025 / 0.5) ~= 51.1 dB
        assert!((m.psnr() - 51.13).abs() < 0.05, "was {}", m.psnr());
    }

    #[test]
    fn all_channels_changed_yields_about_48_db() {
        let m = ImageMetrics::from_lsb_stats(EncodeStats::new(500, 500));
        assert!((m.psnr() - 48.13).abs() < 0.05, "was {}", m.psnr());
    }
}
