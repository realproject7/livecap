//! Hardware-acceleration selection for the whisper context.
//!
//! Ported from Meetily `src/whisper_engine/acceleration.rs` (MIT), with the
//! runtime hardware-profile tiers dropped: LiveCap enables flash attention
//! whenever a GPU backend (Metal/CUDA) is compiled in.

/// Which acceleration backend whisper.cpp was compiled with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperCompiledBackend {
    Metal,
    Cuda,
    Vulkan,
    HipBlas,
    Cpu,
}

impl WhisperCompiledBackend {
    pub fn current() -> Self {
        if cfg!(feature = "cuda") {
            Self::Cuda
        } else if cfg!(feature = "vulkan") {
            Self::Vulkan
        } else if cfg!(feature = "hipblas") {
            Self::HipBlas
        } else if cfg!(target_os = "macos") {
            Self::Metal
        } else {
            Self::Cpu
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Metal => "Metal",
            Self::Cuda => "Cuda",
            Self::Vulkan => "Vulkan",
            Self::HipBlas => "HipBlas",
            Self::Cpu => "Cpu",
        }
    }
}

/// Resolved acceleration parameters for `WhisperContextParameters`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WhisperContextAcceleration {
    pub compiled_backend: WhisperCompiledBackend,
    pub use_gpu: bool,
    pub flash_attn: bool,
    pub gpu_device: i32,
}

impl WhisperContextAcceleration {
    pub fn status_label(self) -> &'static str {
        match (self.compiled_backend, self.flash_attn) {
            (WhisperCompiledBackend::Metal, true) => "Metal GPU with Flash Attention",
            (WhisperCompiledBackend::Metal, false) => "Metal GPU acceleration",
            (WhisperCompiledBackend::Cuda, true) => "CUDA GPU with Flash Attention",
            (WhisperCompiledBackend::Cuda, false) => "CUDA GPU acceleration",
            (WhisperCompiledBackend::Vulkan, _) => "Vulkan GPU acceleration",
            (WhisperCompiledBackend::HipBlas, _) => "HIP BLAS GPU acceleration",
            (WhisperCompiledBackend::Cpu, _) => "CPU processing only",
        }
    }
}

/// Decide acceleration parameters for the compiled backend.
pub fn whisper_context_acceleration() -> WhisperContextAcceleration {
    acceleration_for(WhisperCompiledBackend::current())
}

fn acceleration_for(compiled_backend: WhisperCompiledBackend) -> WhisperContextAcceleration {
    let use_gpu = !matches!(compiled_backend, WhisperCompiledBackend::Cpu);
    let flash_attn = matches!(
        compiled_backend,
        WhisperCompiledBackend::Metal | WhisperCompiledBackend::Cuda
    );

    WhisperContextAcceleration {
        compiled_backend,
        use_gpu,
        flash_attn: use_gpu && flash_attn,
        gpu_device: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metal_backend_enables_gpu_and_flash_attention() {
        let params = acceleration_for(WhisperCompiledBackend::Metal);
        assert!(params.use_gpu);
        assert!(params.flash_attn);
    }

    #[test]
    fn vulkan_backend_uses_gpu_without_flash_attention() {
        let params = acceleration_for(WhisperCompiledBackend::Vulkan);
        assert!(params.use_gpu);
        assert!(!params.flash_attn);
    }

    #[test]
    fn cpu_backend_disables_gpu_and_flash_attention() {
        let params = acceleration_for(WhisperCompiledBackend::Cpu);
        assert!(!params.use_gpu);
        assert!(!params.flash_attn);
    }
}
