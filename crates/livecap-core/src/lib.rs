//! LiveCap core: audio capture, VAD segmentation, and on-device STT.
//!
//! This crate stays free of Tauri and UI concerns so it can be built and
//! tested headless. The capture/STT pipeline lands with issue #4.
