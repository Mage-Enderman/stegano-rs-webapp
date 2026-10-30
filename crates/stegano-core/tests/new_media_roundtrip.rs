use stegano_core::api::unveil;
use stegano_core::{CodecOptions, Media, OutputFormat, SteganoEncoder};

const CARRIER_PNG: &[u8] = include_bytes!("images/plain/carrier-image.png");
const CARRIER_WAV: &[u8] = include_bytes!("audio/plain/carrier-audio.wav");

fn hide_into(carrier: &[u8], format: OutputFormat) -> Vec<u8> {
    let media = Media::from_bytes(carrier, None).expect("carrier should be readable");
    let mut encoder = SteganoEncoder::default();
    encoder.with_output_format(format);
    encoder.use_media_from_media(media);
    encoder.add_message("a note in the picture").unwrap();
    encoder
        .add_file_from_memory("first.txt", b"first secret")
        .unwrap();
    encoder
        .add_file_from_memory("second.bin", &[0u8, 1, 2, 3, 4, 5])
        .unwrap();
    encoder.hide_to_vec().expect("hiding should work")
}

fn unveil_all(carrier: &[u8], password: Option<&str>) -> Vec<(String, Vec<u8>)> {
    let media = Media::from_bytes(carrier, None).expect("stego media should be readable");
    let mut api = unveil::prepare().from_media(media);
    if let Some(password) = password {
        api = api.using_password(password);
    }
    api.execute_to_memory().expect("unveiling should work")
}

fn find<'a>(files: &'a [(String, Vec<u8>)], name: &str) -> &'a [u8] {
    files
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, data)| data.as_slice())
        .unwrap_or_else(|| {
            panic!(
                "file '{name}' was not unveiled, got: {:?}",
                files.iter().map(|(n, _)| n).collect::<Vec<_>>()
            )
        })
}

#[test]
fn hides_text_and_multiple_files_in_an_image() {
    let stego = hide_into(CARRIER_PNG, OutputFormat::Png);
    let files = unveil_all(&stego, None);

    assert_eq!(find(&files, "first.txt"), b"first secret");
    assert_eq!(find(&files, "second.bin"), &[0u8, 1, 2, 3, 4, 5]);
    assert_eq!(find(&files, "secret-message.txt"), b"a note in the picture");
}

#[test]
fn hides_text_and_multiple_files_in_audio() {
    let stego = hide_into(CARRIER_WAV, OutputFormat::Png);
    assert_eq!(&stego[0..4], b"RIFF", "audio output must stay a wav");

    let files = unveil_all(&stego, None);
    assert_eq!(find(&files, "first.txt"), b"first secret");
    assert_eq!(find(&files, "secret-message.txt"), b"a note in the picture");
}

#[test]
fn encryption_round_trips_through_bytes() {
    let media = Media::from_bytes(CARRIER_PNG, None).unwrap();
    let mut encoder = SteganoEncoder::default();
    encoder.with_encryption("correct horse battery staple");
    encoder.use_media_from_media(media);
    encoder.add_message("top secret").unwrap();
    let stego = encoder.hide_to_vec().unwrap();

    let files = unveil_all(&stego, Some("correct horse battery staple"));
    assert_eq!(find(&files, "secret-message.txt"), b"top secret");

    let media = Media::from_bytes(&stego, None).unwrap();
    let failed = unveil::prepare()
        .from_media(media)
        .using_password("wrong password")
        .execute_to_memory();
    assert!(failed.is_err(), "a wrong password must not unveil data");
}

#[test]
fn report_exposes_exact_sizes_and_quality_metrics() {
    let media = Media::from_bytes(CARRIER_PNG, None).unwrap();
    let mut encoder = SteganoEncoder::default();
    encoder.use_media_from_media(media);
    encoder.add_message(&"x".repeat(2_000)).unwrap();

    let capacity = encoder.capacity_bytes().unwrap();
    let payload = encoder.payload_size().unwrap();
    assert!(
        payload <= capacity,
        "payload should fit: {payload} <= {capacity}"
    );
    assert!(encoder.fits().unwrap());

    let report = encoder.hide_to_vec_report().unwrap();
    assert_eq!(report.payload_bytes, payload);
    assert_eq!(report.capacity_bytes, capacity);
    assert_eq!(report.format, OutputFormat::Png);
    assert_eq!(report.kind, stegano_core::MediaKind::Image);
    assert_eq!(report.stats.bits_written, payload * 8);

    let metrics = report.metrics().expect("image metrics");
    assert!(metrics.changed_channels > 0);
    assert!(metrics.psnr() > 40.0, "psnr was {}", metrics.psnr());
    // a compressible payload does not flip exactly half of the bits, but it
    // must never touch more channels than were written to
    assert!(metrics.changed_channels <= metrics.used_channels);
    assert!(metrics.changed_ratio() > 0.0);
    assert!(metrics.changed_ratio() < 1.0);
}

#[test]
fn capacity_is_reported_for_audio() {
    let media = Media::from_bytes(CARRIER_WAV, None).unwrap();
    let mut encoder = SteganoEncoder::default();
    encoder.use_media_from_media(media);
    // stereo? any channel count is fine, the capacity is derived from the samples
    assert!(encoder.capacity_bytes().unwrap() > 0);
}

#[test]
fn lossy_output_is_refused() {
    let media = Media::from_bytes(CARRIER_PNG, None).unwrap();
    let mut encoder = SteganoEncoder::default();
    encoder.with_output_format(OutputFormat::Jpeg);
    encoder.use_media_from_media(media);
    encoder.add_message("hello").unwrap();

    assert!(matches!(
        encoder.hide_to_vec(),
        Err(stegano_core::SteganoError::LossyOutputFormat("jpeg"))
    ));
}

#[test]
fn capacity_matches_the_codec_options() {
    let media = Media::from_bytes(CARRIER_PNG, None).unwrap();
    let (w, h) = media.dimensions().unwrap();
    let opts = CodecOptions::default();
    let expected = ((w as usize - 1) * (h as usize - 1) * 3) / 8;
    assert_eq!(media.capacity_bytes(&opts), expected);
}

#[test]
fn a_deeper_embedding_holds_more_and_is_still_unveiled() {
    let options = |bits_per_channel| CodecOptions {
        bits_per_channel,
        ..CodecOptions::default()
    };

    let media = Media::from_bytes(CARRIER_PNG, None).unwrap();
    let shallow_capacity = media.capacity_bytes(&options(1));
    // integer division rounds every depth down, so the deeper capacities are
    // a multiple of the shallow one or a byte more
    assert!(media.capacity_bytes(&options(2)) >= shallow_capacity * 2);
    assert!(media.capacity_bytes(&options(4)) >= shallow_capacity * 4);

    // a payload that does not fit with the default one bit per channel
    let big = vec![0x5Au8; shallow_capacity + 512];
    let media = Media::from_bytes(CARRIER_PNG, None).unwrap();
    let mut encoder = SteganoEncoder::with_options(options(4));
    encoder.use_media_from_media(media);
    encoder.add_file_from_memory("big.bin", &big).unwrap();
    assert!(encoder.fits().unwrap());

    let report = encoder.hide_to_vec_report().unwrap();
    // the fourfold depth costs fidelity, which the metrics have to reflect
    let metrics = report.metrics().expect("image metrics");
    assert!(
        metrics.max_channel_delta > 1,
        "delta was {}",
        metrics.max_channel_delta
    );
    assert!(metrics.psnr() > 15.0, "psnr was {}", metrics.psnr());

    // unveiling works without knowing the depth it was embedded with
    let files = unveil_all(&report.output, None);
    assert_eq!(find(&files, "big.bin"), big.as_slice());
}

#[cfg(feature = "jxl-encode")]
#[test]
fn hides_data_in_lossless_jpeg_xl() {
    let stego = hide_into(CARRIER_PNG, OutputFormat::Jxl);
    assert!(
        stegano_core::media::image::jxl::is_jxl(&stego),
        "output must be a jxl file"
    );

    let files = unveil_all(&stego, None);
    assert_eq!(find(&files, "first.txt"), b"first secret");
    assert_eq!(find(&files, "secret-message.txt"), b"a note in the picture");
}
