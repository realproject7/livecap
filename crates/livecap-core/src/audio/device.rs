//! Audio device identification and cpal device/config resolution.
//!
//! Ported from Meetily `src/audio/devices/{configuration,discovery,microphone,speakers}.rs`
//! (MIT), trimmed to the parts LiveCap needs.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use std::fmt;

/// Whether a device records (input/microphone) or plays (output/speakers).
/// Output devices are used as anchors for system-audio capture.
#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
pub enum DeviceType {
    Input,
    Output,
}

/// A named audio device.
#[derive(Clone, Eq, PartialEq, Hash, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub device_type: DeviceType,
}

impl AudioDevice {
    pub fn new(name: String, device_type: DeviceType) -> Self {
        AudioDevice { name, device_type }
    }

    /// Parse `"Device Name (input)"` / `"Device Name (output)"`.
    pub fn from_name(name: &str) -> Result<Self> {
        if name.trim().is_empty() {
            return Err(anyhow!("Device name cannot be empty"));
        }

        let (name, device_type) = if name.to_lowercase().ends_with("(input)") {
            (
                name.trim_end_matches("(input)").trim().to_string(),
                DeviceType::Input,
            )
        } else if name.to_lowercase().ends_with("(output)") {
            (
                name.trim_end_matches("(output)").trim().to_string(),
                DeviceType::Output,
            )
        } else {
            return Err(anyhow!(
                "Device type (input/output) not specified in the name"
            ));
        };

        Ok(AudioDevice::new(name, device_type))
    }
}

impl fmt::Display for AudioDevice {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "{} ({})",
            self.name,
            match self.device_type {
                DeviceType::Input => "input",
                DeviceType::Output => "output",
            }
        )
    }
}

/// Get the default input (microphone) device for the system.
pub fn default_input_device() -> Result<AudioDevice> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("No default input device found"))?;
    Ok(AudioDevice::new(device.name()?, DeviceType::Input))
}

/// Get the default output (speaker/system audio) device for the system.
///
/// On macOS the Core Audio backend uses the cidre tap API for system capture,
/// not cpal, so the default host is sufficient here.
pub fn default_output_device() -> Result<AudioDevice> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow!("No default output device found"))?;
    Ok(AudioDevice::new(device.name()?, DeviceType::Output))
}

/// List all available audio devices on the system.
pub fn list_audio_devices() -> Result<Vec<AudioDevice>> {
    let host = cpal::default_host();
    let mut devices: Vec<AudioDevice> = Vec::new();

    for device in host.input_devices()? {
        if let Ok(name) = device.name() {
            devices.push(AudioDevice::new(name, DeviceType::Input));
        }
    }

    for device in host.output_devices()? {
        if let Ok(name) = device.name() {
            if !devices
                .iter()
                .any(|d| d.name == name && d.device_type == DeviceType::Output)
            {
                devices.push(AudioDevice::new(name, DeviceType::Output));
            }
        }
    }

    Ok(devices)
}

/// Resolve a named [`AudioDevice`] to a concrete cpal device + default config.
pub fn get_device_and_config(
    audio_device: &AudioDevice,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig)> {
    let host = cpal::default_host();

    match audio_device.device_type {
        DeviceType::Input => {
            for device in host.input_devices()? {
                if let Ok(name) = device.name() {
                    if name == audio_device.name {
                        let default_config = device
                            .default_input_config()
                            .map_err(|e| anyhow!("Failed to get default input config: {}", e))?;
                        return Ok((device, default_config));
                    }
                }
            }
        }
        DeviceType::Output => {
            for device in host.output_devices()? {
                if let Ok(name) = device.name() {
                    if name == audio_device.name {
                        let default_config = device
                            .default_output_config()
                            .map_err(|e| anyhow!("Failed to get output config: {}", e))?;
                        return Ok((device, default_config));
                    }
                }
            }
        }
    }

    Err(crate::error::CoreError::DeviceNotFound(audio_device.to_string()).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_input_and_output_suffixes() {
        let d = AudioDevice::from_name("MacBook Pro Microphone (input)").unwrap();
        assert_eq!(d.name, "MacBook Pro Microphone");
        assert_eq!(d.device_type, DeviceType::Input);

        let d = AudioDevice::from_name("External Headphones (output)").unwrap();
        assert_eq!(d.name, "External Headphones");
        assert_eq!(d.device_type, DeviceType::Output);
    }

    #[test]
    fn rejects_unqualified_names() {
        assert!(AudioDevice::from_name("Just A Device").is_err());
        assert!(AudioDevice::from_name("   ").is_err());
    }

    #[test]
    fn display_round_trips() {
        let d = AudioDevice::new("Some Mic".into(), DeviceType::Input);
        let parsed = AudioDevice::from_name(&d.to_string()).unwrap();
        assert_eq!(parsed, d);
    }
}
