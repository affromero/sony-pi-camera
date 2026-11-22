use std::{
    ffi::{CStr, c_char, c_int, c_ulong, c_void},
    io,
    ptr::{self, NonNull},
    slice,
};

enum ContextRaw {}
enum CameraRaw {}
enum FileRaw {}
enum WidgetRaw {}

#[link(name = "gphoto2")]
unsafe extern "C" {
    fn gp_context_new() -> *mut ContextRaw;
    fn gp_context_unref(context: *mut ContextRaw);
    fn gp_camera_new(camera: *mut *mut CameraRaw) -> c_int;
    fn gp_camera_init(camera: *mut CameraRaw, context: *mut ContextRaw) -> c_int;
    fn gp_camera_exit(camera: *mut CameraRaw, context: *mut ContextRaw) -> c_int;
    fn gp_camera_unref(camera: *mut CameraRaw) -> c_int;
    fn gp_file_new(file: *mut *mut FileRaw) -> c_int;
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
    fn gp_widget_unref(widget: *mut WidgetRaw) -> c_int;
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

    pub(crate) fn config_number(&self, name: &CStr) -> io::Result<u32> {
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
            "Viewport read",
        )?;
        let widget = Widget(NonNull::new(raw).ok_or_else(|| io::Error::other("Missing viewport"))?);
        let mut kind = -1;
        check(
            unsafe { gp_widget_get_type(widget.0.as_ptr(), &mut kind) },
            "Viewport type read",
        )?;
        // TEXT, RADIO and MENU store a borrowed NUL-terminated string.
        if !matches!(kind, 2 | 5 | 6) {
            return Err(io::Error::other("Unsupported viewport value type"));
        }
        let mut value: *const c_char = ptr::null();
        check(
            unsafe {
                gp_widget_get_value(widget.0.as_ptr(), (&mut value as *mut *const c_char).cast())
            },
            "Viewport value read",
        )?;
        if value.is_null() {
            return Err(io::Error::other("Missing viewport value"));
        }
        unsafe { CStr::from_ptr(value) }
            .to_str()
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| io::Error::other("Invalid viewport value"))
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
impl Drop for Widget {
    fn drop(&mut self) {
        unsafe { gp_widget_unref(self.0.as_ptr()) };
    }
}
