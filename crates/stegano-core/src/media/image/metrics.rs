/// Quality statistics of an embedding operation.
///
/// The concealer only ever rewrites the low bits of a sample, so the distortion
/// can be derived directly from the bits that had to be flipped instead of
/// comparing two full copies of the image.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EncodeStats {
    /// number of carrier primitives (samples) that were consumed
    pub bits_written: usize,
    /// number of carrier primitives whose value actually changed
    pub bits_changed: usize,
    /// sum of `delta * delta` over all changed samples, the squared error
    pub squared_error: u64,
    /// the largest change of a single sample
    pub max_delta: u32,
}

impl EncodeStats {
    /// statistics of a one bit per sample embedding, where every change moves a
    /// sample by exactly one step
    pub fn new(bits_written: usize, bits_changed: usize) -> Self {
        Self {
            bits_written,
            bits_changed,
            squared_error: bits_changed as u64,
            max_delta: u32::from(bits_changed > 0),
        }
    }
}

/// Image quality metrics for a carrier that had data embedded into it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageMetrics {
    pub changed_channels: usize,
    pub used_channels: usize,
    pub max_channel_delta: u8,
    /// sum of the squared per channel differences
    pub squared_error: u64,
}

impl ImageMetrics {
    /// derives the metrics of an embedding from its encode statistics
    pub fn from_lsb_stats(stats: EncodeStats) -> Self {
        Self {
            changed_channels: stats.bits_changed,
            used_channels: stats.bits_written,
            max_channel_delta: stats.max_delta.min(u8::MAX as u32) as u8,
            squared_error: stats.squared_error,
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

    /// mean squared error per used channel
    pub fn mse(&self) -> f64 {
        if self.used_channels == 0 {
            0.0
        } else {
            self.squared_error as f64 / self.used_channels as f64
        }
    }

    /// peak signal to noise ratio in dB, `f64::INFINITY` when nothing changed
    pub fn psnr(&self) -> f64 {
        let mse = self.mse();
        if mse == 0.0 {
            return f64::INFINITY;
        }
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

    #[test]
    fn deeper_embeddings_report_a_larger_error() {
        let shallow = ImageMetrics::from_lsb_stats(EncodeStats::new(1000, 500));
        let deep = ImageMetrics::from_lsb_stats(EncodeStats {
            bits_written: 1000,
            bits_changed: 500,
            // four bit embeddings move a channel by up to 15 steps
            squared_error: 500 * 15 * 15,
            max_delta: 15,
        });

        assert_eq!(deep.max_channel_delta, 15);
        assert!(deep.psnr() < shallow.psnr());
        assert!(deep.psnr() > 20.0);
    }
}
