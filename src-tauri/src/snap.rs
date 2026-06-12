//! Magnetic edge/corner snapping math (pure, unit-tested).
//!
//! All values are physical pixels. Snapping works per axis: each axis snaps
//! independently to the near edge, far edge, or center of the work area when
//! within `threshold`, which yields edge, corner, and centered docking
//! positions (Strip's bottom-center default is bottom edge + x center).

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Snap one axis. `pos`/`len` are the window's origin and length on the axis,
/// `area_pos`/`area_len` the work area's. Returns the snapped origin.
fn snap_axis(
    pos: f64,
    len: f64,
    area_pos: f64,
    area_len: f64,
    threshold: f64,
    margin: f64,
) -> f64 {
    let near = area_pos + margin;
    let far = area_pos + area_len - len - margin;
    let center = area_pos + (area_len - len) / 2.0;
    let mut best = pos;
    let mut best_dist = threshold;
    for candidate in [near, far, center] {
        let dist = (pos - candidate).abs();
        if dist <= best_dist {
            best = candidate;
            best_dist = dist;
        }
    }
    best
}

/// Snap a window rect inside a work area. `threshold` is the magnetic capture
/// distance; `margin` the gap kept between window and screen edge once
/// snapped. Both in physical px.
pub fn snap_position(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    area: Rect,
    threshold: f64,
    margin: f64,
) -> (f64, f64) {
    (
        snap_axis(x, w, area.x, area.w, threshold, margin),
        snap_axis(y, h, area.y, area.h, threshold, margin),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1440.0,
        h: 900.0,
    };

    #[test]
    fn snaps_to_left_edge_within_threshold() {
        let (x, y) = snap_position(20.0, 400.0, 520.0, 640.0, AREA, 16.0, 12.0);
        assert_eq!(x, 12.0); // margin off the left edge
        assert_eq!(y, 400.0); // y untouched (far from any target)
    }

    #[test]
    fn snaps_to_bottom_right_corner() {
        // Right target: 1440 - 420 - 12 = 1008; bottom: 900 - 44 - 12 = 844.
        let (x, y) = snap_position(1000.0, 850.0, 420.0, 44.0, AREA, 16.0, 12.0);
        assert_eq!((x, y), (1008.0, 844.0));
    }

    #[test]
    fn snaps_strip_to_bottom_center() {
        // Center x for 720-wide strip: (1440 - 720) / 2 = 360.
        let (x, y) = snap_position(355.0, 800.0, 720.0, 88.0, AREA, 16.0, 12.0);
        assert_eq!((x, y), (360.0, 800.0));
        let (x2, y2) = snap_position(355.0, 795.0, 720.0, 88.0, AREA, 16.0, 12.0);
        assert_eq!((x2, y2), (360.0, 800.0)); // bottom: 900 - 88 - 12
    }

    #[test]
    fn no_snap_outside_threshold() {
        let (x, y) = snap_position(200.0, 300.0, 520.0, 640.0, AREA, 16.0, 12.0);
        assert_eq!((x, y), (200.0, 300.0));
    }

    #[test]
    fn nearest_target_wins() {
        // x = 14 is within threshold of the left target (12) only.
        let (x, _) = snap_position(14.0, 300.0, 520.0, 640.0, AREA, 16.0, 12.0);
        assert_eq!(x, 12.0);
    }

    #[test]
    fn respects_offset_work_area() {
        // Secondary display offset to the right of the primary.
        let area = Rect {
            x: 1440.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        };
        let (x, y) = snap_position(1450.0, 5.0, 420.0, 44.0, area, 16.0, 12.0);
        assert_eq!((x, y), (1452.0, 12.0)); // top-left of the second display
    }
}
