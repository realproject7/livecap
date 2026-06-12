//! System-audio capture.
//!
//! macOS: Core Audio process tap routed through a private aggregate device,
//! ported from Meetily `src/audio/capture/core_audio.rs` (MIT). The tap is a
//! global mono tap — it captures everything the system plays, regardless of
//! which output device is current.
//!
//! Two deliberate deviations from Meetily:
//! - Meetily used the `cidre` Apple bindings; cidre's build script requires a
//!   full Xcode install, so LiveCap uses the equivalent CoreAudio API surface
//!   via the pure-Rust `objc2-core-audio` bindings instead.
//! - Meetily forwarded samples through an async `Stream` with waker plumbing;
//!   LiveCap pumps the same lock-free ring buffer from a dedicated thread.
//!
//! Other platforms: returns [`CoreError::SystemAudioUnavailable`]. A real
//! implementation would need WASAPI (Windows) or PulseAudio monitor sources
//! (Linux).

use anyhow::Result;
use tokio::sync::mpsc;

use super::device::AudioDevice;
use super::AudioChunk;
#[cfg(not(target_os = "macos"))]
use crate::error::CoreError;

/// Handle to a running system-audio capture. Dropping it stops the capture.
pub struct SystemAudioCapture {
    #[cfg(target_os = "macos")]
    inner: macos::MacSystemAudioCapture,
}

impl SystemAudioCapture {
    /// Start capturing system audio, sending mono chunks to `out`.
    ///
    /// `device` is accepted for API symmetry with microphone capture: on
    /// macOS the underlying tap is global (anchored at the default output
    /// device), so a specific output device cannot be isolated; when one is
    /// supplied it is only logged. On non-macOS platforms this returns a
    /// typed [`CoreError::SystemAudioUnavailable`] error.
    pub fn start(
        device: Option<&AudioDevice>,
        out: mpsc::UnboundedSender<AudioChunk>,
    ) -> Result<Self> {
        #[cfg(target_os = "macos")]
        {
            if let Some(d) = device {
                log::info!(
                    "System capture requested for '{}' — note: the macOS tap is global \
                     (anchored at the default output device), so all system audio is captured",
                    d.name
                );
            }
            Ok(Self {
                inner: macos::MacSystemAudioCapture::start(out)?,
            })
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (device, out);
            Err(CoreError::SystemAudioUnavailable {
                platform: std::env::consts::OS,
                reason: "LiveCap currently implements system-audio capture only via the \
                         macOS Core Audio process tap"
                    .to_string(),
            }
            .into())
        }
    }

    /// Initial sample rate reported by the capture device.
    pub fn sample_rate(&self) -> u32 {
        #[cfg(target_os = "macos")]
        {
            self.inner.sample_rate()
        }
        #[cfg(not(target_os = "macos"))]
        {
            0
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;

    use anyhow::{anyhow, Result};
    use log::{error, info, warn};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AllocAnyThread;
    use objc2_core_audio::{
        kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey,
        kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
        kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
        kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
        kAudioDevicePropertyNominalSampleRate, kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        kAudioSubTapUIDKey, kAudioTapPropertyFormat, kAudioTapPropertyUID,
        AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceStart, AudioDeviceStop,
        AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
        AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
        AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress,
        AudioObjectPropertySelector, CATapDescription,
    };
    use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
    use objc2_core_foundation::{CFDictionary, CFString};
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    use ringbuf::{
        traits::{Consumer, Producer, Split},
        HeapProd, HeapRb,
    };
    use tokio::sync::mpsc;

    use crate::audio::AudioChunk;

    /// How many samples the pump thread forwards per chunk at most.
    const PUMP_CHUNK: usize = 2048;
    /// Ring buffer size between the realtime IO proc and the pump thread.
    const RING_CAPACITY: usize = 1024 * 128;
    /// 'lpcm'
    const FORMAT_LINEAR_PCM: u32 = 0x6c70_636d;
    /// kAudioFormatFlagIsFloat
    const FLAG_IS_FLOAT: u32 = 1;

    /// Context shared with the realtime Core Audio IO proc.
    struct AudioContext {
        producer: HeapProd<f32>,
        /// Scratch buffer for downmixing, reused to avoid realtime allocs.
        scratch: Vec<f32>,
        consecutive_drops: AtomicU32,
        should_terminate: Arc<AtomicBool>,
    }

    pub(super) struct MacSystemAudioCapture {
        stop: Arc<AtomicBool>,
        join: Option<std::thread::JoinHandle<()>>,
        sample_rate: u32,
    }

    impl MacSystemAudioCapture {
        pub(super) fn start(out: mpsc::UnboundedSender<AudioChunk>) -> Result<Self> {
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32>>();

            // All Core Audio objects (tap, aggregate device, IO proc context)
            // are created, used, and destroyed on this thread.
            let join = std::thread::Builder::new()
                .name("livecap-system-audio".into())
                .spawn(move || run_capture(thread_stop, out, ready_tx))?;

            let sample_rate = ready_rx.recv().map_err(|_| {
                anyhow!("System-audio capture thread exited before reporting status")
            })??;

            Ok(Self {
                stop,
                join: Some(join),
                sample_rate,
            })
        }

        pub(super) fn sample_rate(&self) -> u32 {
            self.sample_rate
        }
    }

    impl Drop for MacSystemAudioCapture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    fn global_address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    /// Read a fixed-size property value from a Core Audio object.
    fn get_property<T: Copy>(
        object: AudioObjectID,
        selector: AudioObjectPropertySelector,
        mut initial: T,
    ) -> Result<T> {
        let mut address = global_address(selector);
        let mut size = std::mem::size_of::<T>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new_unchecked(&mut initial as *mut T as *mut c_void),
            )
        };
        if status != 0 {
            return Err(anyhow!(
                "AudioObjectGetPropertyData({:#x}) failed with OSStatus {}",
                selector,
                status
            ));
        }
        Ok(initial)
    }

    /// Read a CFString-valued property and convert it to an NSString
    /// (toll-free bridged). The Get rule hands us a +1 reference.
    fn get_string_property(
        object: AudioObjectID,
        selector: AudioObjectPropertySelector,
    ) -> Result<Retained<NSString>> {
        let raw: *const CFString = get_property(object, selector, std::ptr::null())?;
        if raw.is_null() {
            return Err(anyhow!(
                "AudioObjectGetPropertyData({:#x}) returned a null string",
                selector
            ));
        }
        unsafe {
            Retained::from_raw(raw as *mut NSString)
                .ok_or_else(|| anyhow!("Failed to take ownership of CFString property"))
        }
    }

    fn ns_key(key: &std::ffi::CStr) -> Retained<NSString> {
        NSString::from_str(key.to_str().expect("CoreAudio keys are ASCII"))
    }

    /// Create the tap + aggregate device, start IO, and pump the ring buffer
    /// until asked to stop. (Setup mirrors Meetily's CoreAudioCapture.)
    fn run_capture(
        stop: Arc<AtomicBool>,
        out: mpsc::UnboundedSender<AudioChunk>,
        ready_tx: std::sync::mpsc::Sender<Result<u32>>,
    ) {
        struct Devices {
            tap_id: AudioObjectID,
            agg_id: AudioObjectID,
        }

        let setup = (|| -> Result<_> {
            info!("CoreAudio: starting system-audio capture initialization");

            // Note: Audio Capture permission ("System Audio Recording",
            // NSAudioCaptureUsageDescription) is required on macOS 14.4+.
            // The permission dialog is triggered when the tap is created; if
            // permission is denied the tap yields silence (all zeros).
            let output_device: AudioObjectID = get_property(
                kAudioObjectSystemObject as AudioObjectID,
                kAudioHardwarePropertyDefaultOutputDevice,
                0,
            )?;
            let output_uid = get_string_property(output_device, kAudioDevicePropertyDeviceUID)?;
            info!(
                "CoreAudio: default output device {} (UID: {})",
                output_device, output_uid
            );

            // Create a process tap: mono global tap, excluding no processes.
            // Mono is more reliable for system audio capture on macOS.
            let mut tap_id: AudioObjectID = 0;
            let status = unsafe {
                let desc = CATapDescription::initMonoGlobalTapButExcludeProcesses(
                    CATapDescription::alloc(),
                    &NSArray::new(),
                );
                AudioHardwareCreateProcessTap(Some(&desc), &mut tap_id)
            };
            if status != 0 || tap_id == 0 {
                return Err(anyhow!(
                    "AudioHardwareCreateProcessTap failed with OSStatus {} — is \
                     System Audio Recording permission granted?",
                    status
                ));
            }

            let tap_uid = get_string_property(tap_id, kAudioTapPropertyUID)?;
            let asbd: AudioStreamBasicDescription = get_property(
                tap_id,
                kAudioTapPropertyFormat,
                AudioStreamBasicDescription {
                    mSampleRate: 0.0,
                    mFormatID: 0,
                    mFormatFlags: 0,
                    mBytesPerPacket: 0,
                    mFramesPerPacket: 0,
                    mBytesPerFrame: 0,
                    mChannelsPerFrame: 0,
                    mBitsPerChannel: 0,
                    mReserved: 0,
                },
            )?;
            info!(
                "CoreAudio: tap format — {} Hz, {} channels, format {:#x}, flags {:#x}",
                asbd.mSampleRate, asbd.mChannelsPerFrame, asbd.mFormatID, asbd.mFormatFlags
            );
            if asbd.mFormatID != FORMAT_LINEAR_PCM || asbd.mFormatFlags & FLAG_IS_FLOAT == 0 {
                unsafe { AudioHardwareDestroyProcessTap(tap_id) };
                return Err(anyhow!(
                    "Unsupported tap format: id {:#x}, flags {:#x} (expected float32 PCM)",
                    asbd.mFormatID,
                    asbd.mFormatFlags
                ));
            }

            // Aggregate device descriptor.
            // IMPORTANT (from Meetily): include ONLY the tap, NOT the output
            // device + tap — including both captures the audio twice (echo).
            let sub_tap: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
                &[&*ns_key(kAudioSubTapUIDKey)],
                &[&*tap_uid as &NSString as &AnyObject],
            );
            let tap_list = NSArray::from_retained_slice(&[sub_tap]);

            let agg_uid = NSString::from_str(&format!(
                "livecap-audio-tap-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            let agg_name = NSString::from_str("livecap-audio-tap");
            let yes = NSNumber::new_bool(true);
            let no = NSNumber::new_bool(false);

            let keys = [
                ns_key(kAudioAggregateDeviceIsPrivateKey),
                ns_key(kAudioAggregateDeviceIsStackedKey),
                ns_key(kAudioAggregateDeviceTapAutoStartKey),
                ns_key(kAudioAggregateDeviceNameKey),
                ns_key(kAudioAggregateDeviceMainSubDeviceKey),
                ns_key(kAudioAggregateDeviceUIDKey),
                ns_key(kAudioAggregateDeviceTapListKey),
            ];
            let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
            let values: [&AnyObject; 7] = [
                &yes,
                &no,
                &yes,
                &agg_name,
                &output_uid,
                &agg_uid,
                &tap_list,
            ];
            let agg_desc: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(&key_refs, &values);

            let mut agg_id: AudioObjectID = 0;
            let status = unsafe {
                // NSDictionary is toll-free bridged to CFDictionary.
                let cf_desc = &*(Retained::as_ptr(&agg_desc) as *const CFDictionary);
                AudioHardwareCreateAggregateDevice(cf_desc, NonNull::from(&mut agg_id))
            };
            if status != 0 || agg_id == 0 {
                unsafe { AudioHardwareDestroyProcessTap(tap_id) };
                return Err(anyhow!(
                    "AudioHardwareCreateAggregateDevice failed with OSStatus {}",
                    status
                ));
            }

            Ok((Devices { tap_id, agg_id }, asbd))
        })();

        let (devices, asbd) = match setup {
            Ok(parts) => parts,
            Err(e) => {
                error!("CoreAudio: system-audio capture setup failed: {e:#}");
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        let rb = HeapRb::<f32>::new(RING_CAPACITY);
        let (producer, mut consumer) = rb.split();
        let should_terminate = Arc::new(AtomicBool::new(false));
        let mut ctx = Box::new(AudioContext {
            producer,
            scratch: Vec::with_capacity(PUMP_CHUNK * 4),
            consecutive_drops: AtomicU32::new(0),
            should_terminate: should_terminate.clone(),
        });

        // Register the IO proc and start the aggregate device.
        let started = (|| -> Result<_> {
            let mut proc_id: objc2_core_audio::AudioDeviceIOProcID = None;
            let status = unsafe {
                AudioDeviceCreateIOProcID(
                    devices.agg_id,
                    Some(io_proc),
                    &mut *ctx as *mut AudioContext as *mut c_void,
                    NonNull::from(&mut proc_id),
                )
            };
            if status != 0 || proc_id.is_none() {
                return Err(anyhow!(
                    "AudioDeviceCreateIOProcID failed with OSStatus {}",
                    status
                ));
            }
            let status = unsafe { AudioDeviceStart(devices.agg_id, proc_id) };
            if status != 0 {
                unsafe { AudioDeviceDestroyIOProcID(devices.agg_id, proc_id) };
                return Err(anyhow!("AudioDeviceStart failed with OSStatus {}", status));
            }
            Ok(proc_id)
        })();

        let proc_id = match started {
            Ok(p) => p,
            Err(e) => {
                error!("CoreAudio: failed to start aggregate device: {e:#}");
                unsafe {
                    AudioHardwareDestroyAggregateDevice(devices.agg_id);
                    AudioHardwareDestroyProcessTap(devices.tap_id);
                }
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        // Initial rate: prefer the aggregate device's nominal rate, falling
        // back to the tap format.
        let initial_rate =
            get_property(devices.agg_id, kAudioDevicePropertyNominalSampleRate, 0f64)
                .map(|r| r as u32)
                .unwrap_or(asbd.mSampleRate as u32);
        let current_rate = AtomicU32::new(initial_rate.max(1));
        info!(
            "CoreAudio: system-audio capture running at {} Hz",
            current_rate.load(Ordering::Acquire)
        );
        let _ = ready_tx.send(Ok(current_rate.load(Ordering::Acquire)));

        // Pump loop: drain the ring buffer into the pipeline channel and
        // re-poll the device rate periodically (it changes when the default
        // output device changes).
        let mut buf = vec![0.0f32; PUMP_CHUNK];
        let mut iterations: u64 = 0;
        loop {
            if stop.load(Ordering::Acquire) {
                break;
            }
            if should_terminate.load(Ordering::Acquire) {
                warn!("CoreAudio: capture terminating due to sustained buffer pressure");
                break;
            }

            iterations += 1;
            if iterations.is_multiple_of(100) {
                if let Ok(rate) =
                    get_property(devices.agg_id, kAudioDevicePropertyNominalSampleRate, 0f64)
                {
                    let rate = rate as u32;
                    if rate > 0 && rate != current_rate.load(Ordering::Acquire) {
                        info!("CoreAudio: sample rate changed to {} Hz", rate);
                        current_rate.store(rate, Ordering::Release);
                    }
                }
            }

            let popped = consumer.pop_slice(&mut buf);
            if popped > 0 {
                let chunk = AudioChunk {
                    samples: buf[..popped].to_vec(),
                    sample_rate: current_rate.load(Ordering::Acquire),
                };
                if out.send(chunk).is_err() {
                    // Pipeline receiver dropped — shut down.
                    break;
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        should_terminate.store(true, Ordering::Release);
        unsafe {
            AudioDeviceStop(devices.agg_id, proc_id);
            AudioDeviceDestroyIOProcID(devices.agg_id, proc_id);
            AudioHardwareDestroyAggregateDevice(devices.agg_id);
            AudioHardwareDestroyProcessTap(devices.tap_id);
        }
        drop(ctx);
        info!("CoreAudio: system-audio capture stopped");
    }

    /// Realtime IO proc: copy tap samples into the ring buffer (downmixing
    /// to mono if the tap delivers interleaved multi-channel audio).
    unsafe extern "C-unwind" fn io_proc(
        _device: AudioObjectID,
        _now: NonNull<AudioTimeStamp>,
        in_input_data: NonNull<AudioBufferList>,
        _in_input_time: NonNull<AudioTimeStamp>,
        _out_output_data: NonNull<AudioBufferList>,
        _in_output_time: NonNull<AudioTimeStamp>,
        in_client_data: *mut c_void,
    ) -> i32 {
        if in_client_data.is_null() {
            return 0;
        }
        let ctx = &mut *(in_client_data as *mut AudioContext);
        let abl = in_input_data.as_ref();
        if abl.mNumberBuffers < 1 {
            return 0;
        }

        let buffer = &abl.mBuffers[0];
        if buffer.mData.is_null() || buffer.mDataByteSize == 0 {
            return 0;
        }
        let sample_count = buffer.mDataByteSize as usize / std::mem::size_of::<f32>();
        let data = std::slice::from_raw_parts(buffer.mData as *const f32, sample_count);
        let channels = buffer.mNumberChannels.max(1) as usize;

        if channels == 1 {
            push_audio(ctx, data);
        } else {
            ctx.scratch.clear();
            for frame in data.chunks(channels) {
                ctx.scratch
                    .push(frame.iter().sum::<f32>() / frame.len() as f32);
            }
            let mono = std::mem::take(&mut ctx.scratch);
            push_audio(ctx, &mono);
            ctx.scratch = mono;
        }
        0
    }

    fn push_audio(ctx: &mut AudioContext, data: &[f32]) {
        let pushed = ctx.producer.push_slice(data);
        if pushed < data.len() {
            let consecutive = ctx.consecutive_drops.fetch_add(1, Ordering::AcqRel) + 1;
            if consecutive > 10 {
                ctx.should_terminate.store(true, Ordering::Release);
            }
        } else {
            ctx.consecutive_drops.store(0, Ordering::Release);
        }
    }
}
