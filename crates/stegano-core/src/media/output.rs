use image::ImageFormat;

/// The media format that the steganographic result is written to.
///
/// Only formats that keep the exact pixel values (lossless) are able to carry
/// hidden data, because the least significant bits are destroyed by lossy
/// re-encoding. [`OutputFormat::preserves_pixels`] states that property
/// explicitly so that callers can refuse lossy output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputFormat {
    /// lossless PNG, the historical default
    #[default]
    Png,
    /// lossless WebP, smaller than PNG for photos
    WebP,
    /// lossy JPEG, this destroys hidden data and is therefore not offered for encoding
    Jpeg,
    /// lossless JPEG XL (modular mode)
    Jxl,
}

impl OutputFormat {
    /// Parses a format from a lowercase name or file extension.
    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "webp" => Some(Self::WebP),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "jxl" => Some(Self::Jxl),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::WebP => "webp",
            Self::Jpeg => "jpeg",
            Self::Jxl => "jxl",
        }
    }

    pub fn mime_type(&self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::WebP => "image/webp",
            Self::Jpeg => "image/jpeg",
            Self::Jxl => "image/jxl",
        }
    }

    /// `true` for formats without quantization, i.e. every pixel survives encoding.
    pub fn preserves_pixels(&self) -> bool {
        !matches!(self, Self::Jpeg)
    }

    /// the `image` crate representation, JPEG XL is not handled by that crate
    pub(crate) fn to_image_format(self) -> Option<ImageFormat> {
        match self {
            Self::Png => Some(ImageFormat::Png),
            Self::WebP => Some(ImageFormat::WebP),
            Self::Jpeg => Some(ImageFormat::Jpeg),
            Self::Jxl => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_parse_names_and_extensions() {
        assert_eq!(OutputFormat::from_name("PNG"), Some(OutputFormat::Png));
        assert_eq!(OutputFormat::from_name(" jpg "), Some(OutputFormat::Jpeg));
        assert_eq!(OutputFormat::from_name("jpeg"), Some(OutputFormat::Jpeg));
        assert_eq!(OutputFormat::from_name("webp"), Some(OutputFormat::WebP));
        assert_eq!(OutputFormat::from_name("jxl"), Some(OutputFormat::Jxl));
        assert_eq!(OutputFormat::from_name("gif"), None);
    }

    #[test]
    fn only_lossless_formats_preserve_pixels() {
        assert!(OutputFormat::Png.preserves_pixels());
        assert!(OutputFormat::WebP.preserves_pixels());
        assert!(OutputFormat::Jxl.preserves_pixels());
        assert!(!OutputFormat::Jpeg.preserves_pixels());
    }
}
