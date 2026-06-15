//! Menu bar glyph rasterizer.
//!
//! Renders the LiveCap menu-bar glyph (36×36 viewBox: a live dot + two thick,
//! solid caption bars) into RGBA at build-free runtime, anti-aliased via signed
//! distance fields. The shapes are intentionally bold so the icon is easy to spot
//! among other menu-bar items at ~18px (#8). Two variants:
//!
//! - default: solid black, used as a macOS template image (system recolors);
//! - live: amber dot + mid-gray bars, used as a non-template image so the
//!   amber accent survives menu bar recoloring.

pub const SIZE: u32 = 36;

/// Single accent color (tokens.css `--accent-live` #E8B84B).
const AMBER: [u8; 3] = [0xE8, 0xB8, 0x4B];
/// Mid-gray reads on both light and dark menu bars in the non-template icon.
const GRAY: [u8; 3] = [0x80, 0x80, 0x80];
const BLACK: [u8; 3] = [0x00, 0x00, 0x00];

fn sdf_circle(px: f64, py: f64, cx: f64, cy: f64, r: f64) -> f64 {
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() - r
}

fn sdf_rounded_rect(px: f64, py: f64, x: f64, y: f64, w: f64, h: f64, r: f64) -> f64 {
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let dx = (px - cx).abs() - (w / 2.0 - r);
    let dy = (py - cy).abs() - (h / 2.0 - r);
    let ox = dx.max(0.0);
    let oy = dy.max(0.0);
    (ox * ox + oy * oy).sqrt() + dx.max(dy).min(0.0) - r
}

/// 1px anti-aliased coverage from a signed distance.
fn coverage(d: f64) -> f64 {
    (0.5 - d).clamp(0.0, 1.0)
}

/// Render the glyph as SIZE×SIZE RGBA (row-major, premultiplication-free).
pub fn menubar_icon(live: bool) -> Vec<u8> {
    let (dot_color, bar_color) = if live { (AMBER, GRAY) } else { (BLACK, BLACK) };
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            // Sample at the pixel center.
            let px = x as f64 + 0.5;
            let py = y as f64 + 0.5;

            // #8: bolder, more recognizable speech-bubble glyph that reads at
            // ~18px among other menu-bar icons. A larger live dot plus TWO thick,
            // solid caption bars (the prior dim bar was a thin 2px outline that
            // disappeared at menu-bar size). Both bars are filled for contrast; the
            // second is shorter so the shape still reads as "captions", not a block.
            let dot = coverage(sdf_circle(px, py, 6.0, 12.0, 4.0));
            let bar_top = coverage(sdf_rounded_rect(px, py, 12.0, 8.0, 21.0, 7.0, 3.5));
            let bar_bot = coverage(sdf_rounded_rect(px, py, 12.0, 19.0, 15.0, 7.0, 3.5));

            let bars = bar_top.max(bar_bot);
            let (color, alpha) = if dot >= bars { (dot_color, dot) } else { (bar_color, bars) };
            let i = ((y * SIZE + x) * 4) as usize;
            rgba[i] = color[0];
            rgba[i + 1] = color[1];
            rgba[i + 2] = color[2];
            rgba[i + 3] = (alpha * 255.0).round() as u8;
        }
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(rgba: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn buffer_has_expected_dimensions() {
        assert_eq!(menubar_icon(false).len(), (SIZE * SIZE * 4) as usize);
    }

    #[test]
    fn template_icon_is_black_with_opaque_shapes() {
        let rgba = menubar_icon(false);
        let dot = pixel(&rgba, 6, 12);
        assert_eq!(&dot[..3], &[0, 0, 0]);
        assert_eq!(dot[3], 255);
        // Top bar center is solid (#8: both bars are filled now).
        assert_eq!(pixel(&rgba, 20, 11)[3], 255);
        // The bottom bar is also a SOLID filled bar (was a thin outline before).
        assert_eq!(pixel(&rgba, 18, 22)[3], 255);
    }

    #[test]
    fn corners_are_transparent() {
        let rgba = menubar_icon(false);
        for (x, y) in [(0, 0), (SIZE - 1, 0), (0, SIZE - 1), (SIZE - 1, SIZE - 1)] {
            assert_eq!(pixel(&rgba, x, y)[3], 0);
        }
    }

    #[test]
    fn live_icon_has_amber_dot_and_gray_bars() {
        let rgba = menubar_icon(true);
        assert_eq!(&pixel(&rgba, 6, 12)[..3], &AMBER);
        assert_eq!(&pixel(&rgba, 20, 11)[..3], &GRAY);
    }
}
