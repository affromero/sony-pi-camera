use std::{
    ffi::{CStr, CString, c_char, c_float, c_int, c_ulong, c_void},
    fs::OpenOptions,
    io,
    os::fd::IntoRawFd,
    path::Path,
    ptr::{self, NonNull},
    slice,
    time::{Duration, Instant},
};

enum ContextRaw {}
enum CameraRaw {}
enum FileRaw {}
enum WidgetRaw {}

#[repr(C)]
#[derive(Clone)]
struct CameraPath {
    name: [c_char; 128],
    folder: [c_char; 1024],
}

impl CameraPath {
    fn parts(&self) -> io::Result<(&CStr, &CStr)> {
        fn field(value: &[c_char]) -> io::Result<&CStr> {
            let bytes = unsafe { slice::from_raw_parts(value.as_ptr().cast(), value.len()) };
            CStr::from_bytes_until_nul(bytes).map_err(io::Error::other)
        }
        Ok((field(&self.folder)?, field(&self.name)?))
    }
}

#[link(name = "gphoto2")]
unsafe extern "C" {
    fn gp_context_new() -> *mut ContextRaw;
    fn gp_context_unref(context: *mut ContextRaw);
    fn gp_camera_new(camera: *mut *mut CameraRaw) -> c_int;
    fn gp_camera_init(camera: *mut CameraRaw, context: *mut ContextRaw) -> c_int;
    fn gp_camera_exit(camera: *mut CameraRaw, context: *mut ContextRaw) -> c_int;
    fn gp_camera_unref(camera: *mut CameraRaw) -> c_int;
    fn gp_file_new(file: *mut *mut FileRaw) -> c_int;
    fn gp_file_new_from_fd(file: *mut *mut FileRaw, fd: c_int) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn free(data: *mut c_void);
    fn gp_file_unref(file: *mut FileRaw) -> c_int;
    fn gp_camera_capture_preview(
        camera: *mut CameraRaw,
        file: *mut FileRaw,
        context: *mut ContextRaw,
    ) -> c_int;
    fn gp_file_get_data_and_size(
        file: *mut FileRaw,
        data: *mut *const c_char,
        size: *mut c_ulong,
    ) -> c_int;
    fn gp_camera_get_single_config(
        camera: *mut CameraRaw,
        name: *const c_char,
        widget: *mut *mut WidgetRaw,
        context: *mut ContextRaw,
    ) -> c_int;
    fn gp_widget_get_type(widget: *mut WidgetRaw, kind: *mut c_int) -> c_int;
    fn gp_widget_get_value(widget: *mut WidgetRaw, value: *mut c_void) -> c_int;
    fn gp_widget_get_readonly(widget: *mut WidgetRaw, readonly: *mut c_int) -> c_int;
    fn gp_widget_set_value(widget: *mut WidgetRaw, value: *const c_void) -> c_int;
    fn gp_widget_count_choices(widget: *mut WidgetRaw) -> c_int;
    fn gp_widget_get_choice(
        widget: *mut WidgetRaw,
        index: c_int,
        value: *mut *const c_char,
    ) -> c_int;
    fn gp_widget_unref(widget: *mut WidgetRaw) -> c_int;
    fn gp_camera_set_single_config(
        camera: *mut CameraRaw,
        name: *const c_char,
        widget: *mut WidgetRaw,
        context: *mut ContextRaw,
    ) -> c_int;
    fn gp_camera_capture(
        camera: *mut CameraRaw,
        kind: c_int,
        path: *mut CameraPath,
        context: *mut ContextRaw,
    ) -> c_int;
    fn gp_camera_file_get(
        camera: *mut CameraRaw,
        folder: *const c_char,
        name: *const c_char,
        kind: c_int,
        file: *mut FileRaw,
        context: *mut ContextRaw,
    ) -> c_int;
    fn gp_camera_wait_for_event(
        camera: *mut CameraRaw,
        timeout: c_int,
        kind: *mut c_int,
        data: *mut *mut c_void,
        context: *mut ContextRaw,
    ) -> c_int;
}

pub(crate) const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

fn check(code: c_int, operation: &str) -> io::Result<()> {
    if code < 0 {
        return Err(io::Error::other(format!("{operation} failed ({code})")));
    }
    Ok(())
}

struct Context(NonNull<ContextRaw>);
impl Drop for Context {
    fn drop(&mut self) {
        unsafe { gp_context_unref(self.0.as_ptr()) };
    }
}

pub(crate) struct Camera {
    raw: NonNull<CameraRaw>,
    context: Context,
    initialized: bool,
}

impl Camera {
    pub(crate) fn open() -> io::Result<Self> {
        let context = Context(
            NonNull::new(unsafe { gp_context_new() })
                .ok_or_else(|| io::Error::other("Could not allocate camera context"))?,
        );
        let mut raw = ptr::null_mut();
        check(unsafe { gp_camera_new(&mut raw) }, "Camera allocation")?;
        let mut session = Self {
            raw: NonNull::new(raw).ok_or_else(|| io::Error::other("Missing camera"))?,
            context,
            initialized: false,
        };
        check(
            unsafe { gp_camera_init(session.raw.as_ptr(), session.context.0.as_ptr()) },
            "USB session open",
        )?;
        session.initialized = true;
        Ok(session)
    }

    pub(crate) fn preview(&self) -> io::Result<Vec<u8>> {
        let mut raw = ptr::null_mut();
        check(unsafe { gp_file_new(&mut raw) }, "Preview file allocation")?;
        let file = File(NonNull::new(raw).ok_or_else(|| io::Error::other("Missing preview file"))?);
        check(
            unsafe {
                gp_camera_capture_preview(
                    self.raw.as_ptr(),
                    file.0.as_ptr(),
                    self.context.0.as_ptr(),
                )
            },
            "Preview capture",
        )?;
        let mut data = ptr::null();
        let mut size = 0;
        check(
            unsafe { gp_file_get_data_and_size(file.0.as_ptr(), &mut data, &mut size) },
            "Preview read",
        )?;
        let size = size as usize;
        if data.is_null() || !(4..=MAX_FRAME_BYTES).contains(&size) {
            return Err(io::Error::other("Invalid preview size"));
        }
        // libgphoto2 owns these bytes. Copy them before releasing the file.
        let bytes = unsafe { slice::from_raw_parts(data.cast::<u8>(), size) };
        if !bytes.starts_with(&[0xff, 0xd8]) {
            return Err(io::Error::other("Preview is not a JPEG"));
        }
        Ok(bytes.to_vec())
    }

    fn widget(&self, name: &CStr) -> io::Result<Widget> {
        let mut raw = ptr::null_mut();
        check(
            unsafe {
                gp_camera_get_single_config(
                    self.raw.as_ptr(),
                    name.as_ptr(),
                    &mut raw,
                    self.context.0.as_ptr(),
                )
            },
            &format!("Read setting {}", name.to_string_lossy()),
        )?;
        Ok(Widget(
            NonNull::new(raw).ok_or_else(|| io::Error::other("Missing setting"))?,
        ))
    }

    pub(crate) fn config_number(&self, name: &CStr) -> io::Result<u32> {
        self.config_value(name)?.parse().map_err(io::Error::other)
    }

    pub(crate) fn config_value(&self, name: &CStr) -> io::Result<String> {
        let widget = self.widget(name)?;
        widget.value(widget.kind()?)
    }

    pub(crate) fn print_config(&self, name: &CStr) -> io::Result<()> {
        let widget = self.widget(name)?;
        let kind = widget.kind()?;
        let mut readonly = 0;
        check(
            unsafe { gp_widget_get_readonly(widget.0.as_ptr(), &mut readonly) },
            "Read setting permissions",
        )?;
        println!("Readonly: {readonly}\nCurrent: {}", widget.value(kind)?);
        if matches!(kind, 5 | 6) {
            let count = unsafe { gp_widget_count_choices(widget.0.as_ptr()) };
            check(count, "Count setting choices")?;
            for index in 0..count {
                println!("Choice: {index} {}", widget.choice(index)?);
            }
        }
        println!("END");
        Ok(())
    }

    pub(crate) fn set_config(&self, name: &CStr, value: &str) -> io::Result<()> {
        let widget = self.widget(name)?;
        let raw = widget.0.as_ptr();
        let code = match widget.kind()? {
            2 | 5 | 6 => {
                let value = CString::new(value)?;
                unsafe { gp_widget_set_value(raw, value.as_ptr().cast()) }
            }
            3 => {
                let value: c_float = value.parse().map_err(io::Error::other)?;
                unsafe { gp_widget_set_value(raw, (&raw const value).cast()) }
            }
            4 | 8 => {
                let value: c_int = value.parse().map_err(io::Error::other)?;
                unsafe { gp_widget_set_value(raw, (&raw const value).cast()) }
            }
            _ => return Err(io::Error::other("Unsupported camera setting type")),
        };
        check(code, "Prepare setting")?;
        check(
            unsafe {
                gp_camera_set_single_config(
                    self.raw.as_ptr(),
                    name.as_ptr(),
                    raw,
                    self.context.0.as_ptr(),
                )
            },
            &format!("Write setting {}", name.to_string_lossy()),
        )
    }

    fn event(&self, timeout: Duration) -> io::Result<(c_int, Option<CameraPath>)> {
        let mut kind = 0;
        let mut data = ptr::null_mut();
        let code = unsafe {
            gp_camera_wait_for_event(
                self.raw.as_ptr(),
                timeout.as_millis() as c_int,
                &mut kind,
                &mut data,
                self.context.0.as_ptr(),
            )
        };
        let path = if code >= 0 && kind == 2 && !data.is_null() {
            Some(unsafe { data.cast::<CameraPath>().read() })
        } else {
            None
        };
        unsafe { free(data) };
        check(code, "Wait for camera event")?;
        Ok((kind, path))
    }

    pub(crate) fn wait(&self, duration: Duration) -> io::Result<()> {
        let deadline = Instant::now() + duration;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            self.event(remaining)?;
        }
        Ok(())
    }

    pub(crate) fn capture(&self, template: &str) -> io::Result<()> {
        let prefix = template
            .strip_suffix(".%C")
            .ok_or_else(|| io::Error::other("Expected a .%C capture filename"))?;
        let mut path = CameraPath {
            name: [0; 128],
            folder: [0; 1024],
        };
        check(
            unsafe { gp_camera_capture(self.raw.as_ptr(), 0, &mut path, self.context.0.as_ptr()) },
            "Still capture",
        )?;
        self.download(&path, prefix)?;
        let mut downloaded = vec![path];
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut quiet = Instant::now() + Duration::from_secs(3);
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(io::Error::other(
                    "Camera did not finish delivering the capture",
                ));
            }
            let Some(remaining) = quiet.min(deadline).checked_duration_since(now) else {
                return Ok(());
            };
            match self.event(remaining)? {
                (2, Some(path)) => {
                    let parts = path.parts()?;
                    if downloaded
                        .iter()
                        .any(|item| item.parts().ok() == Some(parts))
                    {
                        continue;
                    }
                    self.download(&path, prefix)?;
                    downloaded.push(path);
                    quiet = Instant::now() + Duration::from_secs(3);
                }
                (4, _) => quiet = quiet.min(Instant::now() + Duration::from_millis(100)),
                _ => {}
            }
        }
    }

    fn download(&self, path: &CameraPath, prefix: &str) -> io::Result<()> {
        let (folder, name) = path.parts()?;
        let filename = name.to_string_lossy();
        let extension = Path::new(filename.as_ref())
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 8
                    && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .ok_or_else(|| io::Error::other("Camera returned an invalid file extension"))?
            .to_ascii_lowercase();
        let mut index = 0;
        let fd = loop {
            let target = if index == 0 {
                format!("{prefix}.{extension}")
            } else {
                format!("{prefix}.{index}.{extension}")
            };
            match OpenOptions::new().write(true).create_new(true).open(target) {
                Ok(file) => break file.into_raw_fd(),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => index += 1,
                Err(error) => return Err(error),
            }
        };
        let mut raw = ptr::null_mut();
        let code = unsafe { gp_file_new_from_fd(&mut raw, fd) };
        if code < 0 {
            unsafe { close(fd) };
        }
        check(code, "Allocate download file")?;
        let file =
            File(NonNull::new(raw).ok_or_else(|| io::Error::other("Missing download file"))?);
        check(
            unsafe {
                gp_camera_file_get(
                    self.raw.as_ptr(),
                    folder.as_ptr(),
                    name.as_ptr(),
                    1,
                    file.0.as_ptr(),
                    self.context.0.as_ptr(),
                )
            },
            "Download camera photo",
        )
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        unsafe {
            if self.initialized {
                gp_camera_exit(self.raw.as_ptr(), self.context.0.as_ptr());
            }
            gp_camera_unref(self.raw.as_ptr());
        }
    }
}

struct File(NonNull<FileRaw>);
impl Drop for File {
    fn drop(&mut self) {
        unsafe { gp_file_unref(self.0.as_ptr()) };
    }
}

struct Widget(NonNull<WidgetRaw>);
impl Widget {
    fn kind(&self) -> io::Result<c_int> {
        let mut kind = -1;
        check(
            unsafe { gp_widget_get_type(self.0.as_ptr(), &mut kind) },
            "Read setting type",
        )?;
        Ok(kind)
    }

    fn choice(&self, index: c_int) -> io::Result<String> {
        let mut value = ptr::null();
        check(
            unsafe { gp_widget_get_choice(self.0.as_ptr(), index, &mut value) },
            "Read setting choice",
        )?;
        Self::string(value)
    }

    fn string(value: *const c_char) -> io::Result<String> {
        if value.is_null() {
            return Err(io::Error::other("Camera setting is missing"));
        }
        Ok(unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned())
    }

    fn read<T>(&self, mut value: T) -> io::Result<T> {
        check(
            unsafe { gp_widget_get_value(self.0.as_ptr(), (&raw mut value).cast()) },
            "Read setting value",
        )?;
        Ok(value)
    }

    fn value(&self, kind: c_int) -> io::Result<String> {
        match kind {
            2 | 5 | 6 => Self::string(self.read(ptr::null::<c_char>())?),
            3 => Ok(self.read(0.0 as c_float)?.to_string()),
            4 | 8 => Ok(self.read(0 as c_int)?.to_string()),
            _ => Err(io::Error::other("Unsupported camera setting type")),
        }
    }
}
impl Drop for Widget {
    fn drop(&mut self) {
        unsafe { gp_widget_unref(self.0.as_ptr()) };
    }
}
