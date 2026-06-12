//! Menu bar glyph rasterizer.
//!
//! Renders design/icons/menubar-glyph.svg (36×36 viewBox: live dot + bright
//! caption bar + dim outlined caption bar) into RGBA at build-free runtime,
//! anti-aliased via signed distance fields. Two variants:
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

            // Shapes per design/icons/menubar-glyph.svg.
            let dot = coverage(sdf_circle(px, py, 5.0, 13.0, 3.0));
            let bright_bar = coverage(sdf_rounded_rect(px, py, 11.0, 10.0, 22.0, 6.0, 3.0));
            // Dim bar is a 2px stroke: |sdf| - stroke/2.
            let dim_sdf = sdf_rounded_rect(px, py, 11.0, 21.0, 22.0, 5.0, 2.5);
            let dim_bar = coverage(dim_sdf.abs() - 1.0);

            let bars = bright_bar.max(dim_bar);
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
        let dot = pixel(&rgba, 5, 13);
        assert_eq!(&dot[..3], &[0, 0, 0]);
        assert_eq!(dot[3], 255);
        // Bright bar center.
        assert_eq!(pixel(&rgba, 22, 13)[3], 255);
        // Dim bar is an outline: its center is hollow, its edge is drawn.
        assert_eq!(pixel(&rgba, 22, 23)[3], 0);
        assert!(pixel(&rgba, 22, 21)[3] > 0);
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
        assert_eq!(&pixel(&rgba, 5, 13)[..3], &AMBER);
        assert_eq!(&pixel(&rgba, 22, 13)[..3], &GRAY);
    }
}
