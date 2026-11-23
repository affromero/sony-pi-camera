mod gphoto;

use gphoto::Camera;
use std::{
    env,
    ffi::CString,
    io::{self, Read, Write},
    sync::mpsc::{RecvTimeoutError, sync_channel},
    thread,
    time::{Duration, Instant},
};

fn write_preview(output: &mut impl Write, frame: &[u8], ratio: u32, point: u32) -> io::Result<()> {
    output.write_all(&(frame.len() as u32).to_le_bytes())?;
    output.write_all(&ratio.to_le_bytes())?;
    output.write_all(&point.to_le_bytes())?;
    output.write_all(frame)?;
    output.flush()
}

fn worker() -> io::Result<()> {
    let (sender, requests) = sync_channel(1);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut request = [0];
        loop {
            match input.read_exact(&mut request) {
                Ok(()) => {
                    if sender.send(Ok(request[0])).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    if error.kind() != io::ErrorKind::UnexpectedEof {
                        let _ = sender.send(Err(error));
                    }
                    break;
                }
            }
        }
    });
    let mut output = io::stdout().lock();
    let mut camera = None;
    loop {
        let request = if camera.is_some() {
            match requests.recv_timeout(Duration::from_secs(5)) {
                Ok(request) => request?,
                Err(RecvTimeoutError::Timeout) => {
                    camera = None;
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        } else {
            match requests.recv() {
                Ok(request) => request?,
                Err(_) => return Ok(()),
            }
        };
        if request != b'P' {
            return Err(io::Error::other("Unrecognized worker command"));
        }
        if camera.is_none() {
            camera = Some(Camera::open()?);
        }
        if let Some(camera) = &camera {
            let frame = camera.preview()?;
            let ratio = camera.config_number(c"d22f")?;
            let point = camera.config_number(c"d230")?;
            write_preview(&mut output, &frame, ratio, point)?;
        }
    }
}

fn jpeg_dimensions(frame: &[u8]) -> Option<(u16, u16)> {
    let mut segment = frame.strip_prefix(&[0xff, 0xd8])?;
    loop {
        segment = segment.strip_prefix(&[0xff])?;
        while segment.first() == Some(&0xff) {
            segment = &segment[1..];
        }
        let (&marker, body) = segment.split_first()?;
        if matches!(marker, 0xda | 0xd9) {
            return None;
        }
        let length = u16::from_be_bytes(body.get(..2)?.try_into().ok()?) as usize;
        if length < 2 {
            return None;
        }
        let payload = body.get(..length)?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let height = u16::from_be_bytes(payload.get(3..5)?.try_into().ok()?);
            let width = u16::from_be_bytes(payload.get(5..7)?.try_into().ok()?);
            return (width > 0 && height > 0).then_some((width, height));
        }
        segment = body.get(length..)?;
    }
}

fn probe(count: usize) -> io::Result<()> {
    let start = Instant::now();
    let camera = Camera::open()?;
    println!("session_ms={:.3}", start.elapsed().as_secs_f64() * 1000.0);
    let mut previous = Vec::new();
    let sequence_start = Instant::now();
    for index in 1..=count {
        let start = Instant::now();
        let frame = camera.preview()?;
        let (width, height) =
            jpeg_dimensions(&frame).ok_or_else(|| io::Error::other("Missing JPEG dimensions"))?;
        println!(
            "frame={index} dimensions={width}x{height} bytes={} elapsed_ms={:.3} identical_to_previous={}",
            frame.len(),
            start.elapsed().as_secs_f64() * 1000.0,
            frame == previous
        );
        previous = frame;
    }
    println!(
        "frames={count} total_ms={:.3}",
        sequence_start.elapsed().as_secs_f64() * 1000.0,
    );
    Ok(())
}

fn main() -> io::Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [] => worker(),
        [mode, count] if mode == "--probe" => {
            let count = count
                .parse::<usize>()
                .ok()
                .filter(|count| (1..=200).contains(count))
                .ok_or_else(|| io::Error::other("Probe frame count must be between 1 and 200"))?;
            probe(count)
        }
        [mode, name, value] if mode == "--update-setting" => {
            update_setting(&CString::new(name.as_str())?, value)
        }
        _ => camera_command(&args),
    }
}

fn update_setting(name: &std::ffi::CStr, value: &str) -> io::Result<()> {
    let camera = Camera::open()?;
    camera.print_config(c"expprogram")?;
    camera.print_config(name)?;
    io::stdout().flush()?;
    // Python validates the current mode and available choices before approving.
    let mut approval = [0];
    if io::stdin().read(&mut approval)? == 0 {
        return Ok(());
    }
    if approval != [b'Y'] {
        return Err(io::Error::other("Invalid setting approval"));
    }
    camera.set_config(name, value)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let actual = camera.config_value(name)?;
        if actual == value {
            println!("{actual}");
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "Camera reports {actual} after requesting {value}"
            )));
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn camera_command(args: &[String]) -> io::Result<()> {
    let camera = Camera::open()?;
    let mut args = args.iter().map(String::as_str);
    while let Some(arg) = args.next() {
        let invalid = || io::Error::other(format!("Invalid camera argument: {arg}"));
        match arg {
            "--get-config" => {
                camera.print_config(&CString::new(args.next().ok_or_else(invalid)?)?)?
            }
            "--set-config-value" => {
                let (name, value) = args
                    .next()
                    .and_then(|item| item.split_once('='))
                    .ok_or_else(invalid)?;
                camera.set_config(&CString::new(name)?, value)?;
            }
            "--wait-event=2s" => camera.wait(Duration::from_secs(2))?,
            "--keep" => {
                if args.next() != Some("--capture-image-and-download")
                    || args.next() != Some("--filename")
                {
                    return Err(invalid());
                }
                let filename = args.next().ok_or_else(invalid)?;
                if args.next().is_some() {
                    return Err(invalid());
                }
                return camera.capture(filename);
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_message_pairs_the_jpeg_with_its_viewport() {
        let mut output = Vec::new();
        let jpeg = [0xff, 0xd8, 0xff, 0xd9];
        write_preview(&mut output, &jpeg, 59, 20_971_734).unwrap();
        assert_eq!(&output[..4], &4_u32.to_le_bytes());
        assert_eq!(&output[4..8], &59_u32.to_le_bytes());
        assert_eq!(&output[8..12], &20_971_734_u32.to_le_bytes());
        assert_eq!(&output[12..], &jpeg);
    }

    #[test]
    fn probe_reports_native_dimensions_and_rejects_truncated_headers() {
        let header = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0x02, 0xa8, 0x04,
            0x00, 1, 1, 0x11, 0,
        ];
        assert_eq!(jpeg_dimensions(&header), Some((1024, 680)));
        assert_eq!(jpeg_dimensions(&header[..16]), None);
    }
}
