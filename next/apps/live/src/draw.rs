//! Shared drawing parts every module uses: colours, the page-to-world mapping, lines, dashes,
//! rounded boxes, curves and the frame-rate request. Modules read this file. Only a change to
//! the whole view edits it.

use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use std::time::Duration;

/// The concept page's tokens, as hex.
pub const NIGHT: u32 = 0x0A0D13;
pub const DECK: u32 = 0x0E121A;
pub const WALL: u32 = 0x11161F;
pub const RAISE: u32 = 0x171D29;
pub const LINE: u32 = 0x232B3A;
pub const LINE_2: u32 = 0x333D50;
pub const INK: u32 = 0xE6EAF1;
pub const INK_3: u32 = 0x717C90;
pub const WORK: u32 = 0x6FE7FF;
pub const THINK: u32 = 0x93B4FF;
pub const WAIT: u32 = 0xFFB23F;
pub const IDLE: u32 = 0x6B7689;
pub const FAIL: u32 = 0xFF5A6A;
pub const DONE: u32 = 0x4BE38F;

pub fn srgb(hex: u32) -> Color {
    Color::srgb_u8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

/// A token at a canvas alpha. See `seen`.
pub fn srgba(hex: u32, alpha: f32) -> Color {
    srgb(hex).with_alpha(seen(hex, alpha))
}

fn to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// The alpha that makes Bevy's blend look like the concept's canvas. Bevy blends in linear
/// light and the canvas blends sRGB values, so the same alpha looks far brighter here: a 12%
/// amber thread showed at nearly 40%. This solves for the alpha whose linear blend over the
/// night stage lands where the canvas blend lands, on the colour's strongest channel.
pub fn seen(hex: u32, alpha: f32) -> f32 {
    let ch = |s: u32| ((hex >> s) & 0xFF) as f32 / 255.0;
    seen_rgb([ch(16), ch(8), ch(0)], alpha)
}

/// `color` at a canvas alpha, for paints that animate their alpha each frame.
pub fn fade(color: Color, alpha: f32) -> Color {
    let c = color.to_srgba();
    color.with_alpha(seen_rgb([c.red, c.green, c.blue], alpha))
}

fn seen_rgb(rgb: [f32; 3], alpha: f32) -> f32 {
    let a = alpha.clamp(0.0, 1.0);
    let ch = |h: u32, s: u32| ((h >> s) & 0xFF) as f32 / 255.0;
    let mut best = (0.0f32, a);
    for (i, s) in [16, 8, 0].into_iter().enumerate() {
        let (c, b) = (rgb[i], ch(NIGHT, s));
        let span = to_linear(c) - to_linear(b);
        if span.abs() > best.0 {
            let want = to_linear(a * c + (1.0 - a) * b) - to_linear(b);
            best = (span.abs(), (want / span).clamp(0.0, 1.0));
        }
    }
    best.1
}

pub fn flat(mats: &mut Assets<ColorMaterial>, color: Color) -> Handle<ColorMaterial> {
    mats.add(ColorMaterial { color, alpha_mode: AlphaMode2d::Blend, ..default() })
}

/// The stage size of the last scene.
#[derive(Resource, Default, Clone, Copy)]
pub struct Frame {
    pub w: f32,
    pub h: f32,
}

impl Frame {
    /// The page measures from the top left in CSS pixels. Bevy's 2D camera centres on the
    /// origin with y up.
    pub fn at(&self, x: f32, y: f32, z: f32) -> Vec3 {
        Vec3::new(x - self.w / 2.0, self.h / 2.0 - y, z)
    }

    /// A unit square stretched over a box given from its top left.
    pub fn boxed(&self, x: f32, y: f32, w: f32, h: f32, z: f32) -> Transform {
        Transform::from_translation(self.at(x + w / 2.0, y + h / 2.0, z)).with_scale(Vec3::new(w, h, 1.0))
    }
}

/// A unit square laid along a line from `a` to `b`, in page pixels.
pub fn line(frame: Frame, a: Vec2, b: Vec2, z: f32, width: f32) -> Transform {
    let (a, b) = (frame.at(a.x, a.y, z), frame.at(b.x, b.y, z));
    let d = b - a;
    Transform::from_translation((a + b) / 2.0)
        .with_rotation(Quat::from_rotation_z(d.y.atan2(d.x)))
        .with_scale(Vec3::new(d.truncate().length(), width, 1.0))
}

/// The pieces of a dashed line, like canvas `setLineDash([dash, gap])`.
pub fn dashes(frame: Frame, a: Vec2, b: Vec2, z: f32, width: f32, dash: f32, gap: f32) -> Vec<Transform> {
    let len = a.distance(b);
    if len < 0.5 {
        return Vec::new();
    }
    let dir = (b - a) / len;
    let mut out = Vec::new();
    let mut t = 0.0;
    while t < len {
        let end = (t + dash).min(len);
        out.push(line(frame, a + dir * t, a + dir * end, z, width));
        t += dash + gap;
    }
    out
}

/// A point on a cubic bezier, `u` from 0 to 1.
pub fn bezier(p: [Vec2; 4], u: f32) -> Vec2 {
    let v = 1.0 - u;
    p[0] * (v * v * v) + p[1] * (3.0 * v * v * u) + p[2] * (3.0 * v * u * u) + p[3] * (u * u * u)
}

/// Ease in and out, as the concept's flights use.
pub fn ease(u: f32) -> f32 {
    if u < 0.5 {
        2.0 * u * u
    } else {
        1.0 - (-2.0 * u + 2.0).powi(2) / 2.0
    }
}

const CORNER_STEPS: usize = 8;

fn corner_points(w: f32, h: f32, r: f32) -> Vec<Vec2> {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let (hw, hh) = (w / 2.0, h / 2.0);
    let centres = [Vec2::new(hw - r, hh - r), Vec2::new(-hw + r, hh - r), Vec2::new(-hw + r, -hh + r), Vec2::new(hw - r, -hh + r)];
    let mut pts = Vec::with_capacity(4 * (CORNER_STEPS + 1));
    for (i, c) in centres.iter().enumerate() {
        let start = i as f32 * std::f32::consts::FRAC_PI_2;
        for s in 0..=CORNER_STEPS {
            let a = start + std::f32::consts::FRAC_PI_2 * s as f32 / CORNER_STEPS as f32;
            pts.push(*c + Vec2::new(a.cos(), a.sin()) * r);
        }
    }
    pts
}

/// A filled box with round corners, `w` by `h` pixels, centred on the origin.
pub fn rounded_rect(w: f32, h: f32, r: f32) -> Mesh {
    let pts = corner_points(w, h, r);
    let mut pos: Vec<[f32; 3]> = vec![[0.0, 0.0, 0.0]];
    pos.extend(pts.iter().map(|p| [p.x, p.y, 0.0]));
    let n = pts.len() as u32;
    let mut idx = Vec::with_capacity(n as usize * 3);
    for i in 0..n {
        idx.extend([0, 1 + i, 1 + (i + 1) % n]);
    }
    mesh(pos, idx)
}

/// Only the edge of a box with round corners: a band `width` wide, inside the box's outline.
pub fn rounded_edge(w: f32, h: f32, r: f32, width: f32) -> Mesh {
    let outer = corner_points(w, h, r);
    let inner = corner_points(w - width * 2.0, h - width * 2.0, (r - width).max(0.0));
    let mut pos: Vec<[f32; 3]> = outer.iter().map(|p| [p.x, p.y, 0.0]).collect();
    pos.extend(inner.iter().map(|p| [p.x, p.y, 0.0]));
    let n = outer.len() as u32;
    let mut idx = Vec::with_capacity(n as usize * 6);
    for i in 0..n {
        let j = (i + 1) % n;
        idx.extend([i, j, n + i, j, n + j, n + i]);
    }
    mesh(pos, idx)
}

fn mesh(pos: Vec<[f32; 3]>, idx: Vec<u32>) -> Mesh {
    let count = pos.len();
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; count])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; count])
        .with_inserted_indices(Indices::U32(idx))
}

/// The concept's glow sprite: a disc of radius 1 whose alpha falls 0.85, 0.42, 0.1, 0 at
/// radius 0, 0.18, 0.5 and 1. Its material gives the colour and the overall alpha.
/// Over a near-black stage a canvas alpha `a` shows like a linear alpha of about a^2.2 (see
/// `seen`), and that power splits over the stop and the material, so the stops carry it here.
pub fn glow_disc() -> Mesh {
    const STOPS: [(f32, f32); 4] = [(0.0, 0.85), (0.18, 0.42), (0.5, 0.1), (1.0, 0.0)];
    let stops = STOPS.map(|(r, a)| (r, a.powf(2.2)));
    const SIDES: u32 = 40;
    let mut pos: Vec<[f32; 3]> = vec![[0.0, 0.0, 0.0]];
    let mut col: Vec<[f32; 4]> = vec![[1.0, 1.0, 1.0, stops[0].1]];
    for &(r, a) in &stops[1..] {
        for i in 0..SIDES {
            let t = i as f32 / SIDES as f32 * std::f32::consts::TAU;
            pos.push([t.cos() * r, t.sin() * r, 0.0]);
            col.push([1.0, 1.0, 1.0, a]);
        }
    }
    let mut idx = Vec::new();
    for i in 0..SIDES {
        idx.extend([0, 1 + i, 1 + (i + 1) % SIDES]);
    }
    for ring in 0..2u32 {
        let (a, b) = (1 + ring * SIDES, 1 + (ring + 1) * SIDES);
        for i in 0..SIDES {
            let j = (i + 1) % SIDES;
            idx.extend([a + i, b + i, a + j, a + j, b + i, b + j]);
        }
    }
    mesh(pos, idx).with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
}

/// The outline of an ellipse with radii `rx` and `ry`, `width` pixels thick, inside the radii.
pub fn ellipse_edge(rx: f32, ry: f32, width: f32) -> Mesh {
    const SIDES: u32 = 48;
    let mut pos: Vec<[f32; 3]> = Vec::new();
    for i in 0..SIDES {
        let t = i as f32 / SIDES as f32 * std::f32::consts::TAU;
        pos.push([t.cos() * rx, t.sin() * ry, 0.0]);
        pos.push([t.cos() * (rx - width), t.sin() * (ry - width), 0.0]);
    }
    let mut idx = Vec::new();
    for i in 0..SIDES {
        let j = (i + 1) % SIDES;
        idx.extend([2 * i, 2 * j, 2 * i + 1, 2 * j, 2 * j + 1, 2 * i + 1]);
    }
    mesh(pos, idx)
}

/// A circle outline of radius 1 whose band is `width` of the radius. Scale it to the radius you
/// want, and pick `width` as pixels divided by that radius.
pub fn circle_edge(width: f32) -> Mesh {
    ellipse_edge(1.0, 1.0, width)
}

/// What a shape cache entry is. Sizes are kept to a tenth of a pixel.
#[derive(Hash, PartialEq, Eq, Clone, Copy)]
pub enum Shape {
    Square,
    Circle,
    Glow,
    /// A filled rounded box: width, height, corner radius.
    Rect(i32, i32, i32),
    /// A rounded box's edge: width, height, corner radius, line width.
    Edge(i32, i32, i32, i32),
    /// An ellipse outline: x radius, y radius, line width.
    Ellipse(i32, i32, i32),
    /// A circle outline of radius 1 with a band of this many thousandths.
    Ring(i32),
}

pub fn tenth(v: f32) -> i32 {
    (v * 10.0).round() as i32
}

/// Meshes and flat colours shared by every module, made once and kept. Colours are cached by
/// hex and alpha in hundredths, so a module never leaks a material per frame. A colour that
/// animates on its own needs its own material, which its module owns and removes.
#[derive(Resource, Default)]
pub struct Kit {
    shapes: std::collections::HashMap<Shape, Handle<Mesh>>,
    paints: std::collections::HashMap<(u32, u8), Handle<ColorMaterial>>,
}

impl Kit {
    pub fn shape(&mut self, meshes: &mut Assets<Mesh>, s: Shape) -> Handle<Mesh> {
        if let Some(h) = self.shapes.get(&s) {
            return h.clone();
        }
        let f = |v: i32| v as f32 / 10.0;
        let m = match s {
            Shape::Square => Rectangle::new(1.0, 1.0).into(),
            Shape::Circle => Circle::new(1.0).mesh().resolution(48).build(),
            Shape::Glow => glow_disc(),
            Shape::Rect(w, h, r) => rounded_rect(f(w), f(h), f(r)),
            Shape::Edge(w, h, r, lw) => rounded_edge(f(w), f(h), f(r), f(lw)),
            Shape::Ellipse(rx, ry, lw) => ellipse_edge(f(rx), f(ry), f(lw)),
            Shape::Ring(t) => circle_edge(t as f32 / 1000.0),
        };
        let h = meshes.add(m);
        self.shapes.insert(s, h.clone());
        h
    }

    pub fn paint(&mut self, mats: &mut Assets<ColorMaterial>, hex: u32, alpha: f32) -> Handle<ColorMaterial> {
        let a = (alpha.clamp(0.0, 1.0) * 100.0).round() as u8;
        self.paints.entry((hex, a)).or_insert_with(|| flat(mats, srgba(hex, a as f32 / 100.0))).clone()
    }
}

/// A rounded box's edge as a shape, sized in pixels.
pub fn edge_shape(w: f32, h: f32, r: f32, width: f32) -> Shape {
    Shape::Edge(tenth(w), tenth(h), tenth(r), tenth(width))
}

pub fn rect_shape(w: f32, h: f32, r: f32) -> Shape {
    Shape::Rect(tenth(w), tenth(h), tenth(r))
}

/// A small fast random number source for sparks. Not for anything that matters.
#[derive(Resource)]
pub struct Dice(pub u64);

impl Dice {
    pub fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + self.next() * (b - a)
    }
}

/// A stable phase from an id, so each dot blinks a little out of step with the others.
pub fn phase(id: &str) -> f32 {
    let mut h: u32 = 2166136261;
    for b in id.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    (h % 1000) as f32 / 1000.0 * std::f32::consts::TAU
}

/// Each module asks for the frame rate it needs this frame. The fastest ask wins.
#[derive(Resource)]
pub struct Pace {
    pub want: Duration,
}

/// A still world draws four frames a second, to pick up a new scene.
pub const STILL: Duration = Duration::from_millis(250);
/// A blink is slow, so ten frames a second draw it smoothly enough.
pub const BLINKING: Duration = Duration::from_millis(100);
/// Gliding dots, effects and circling helpers move: about 30 frames a second.
pub const MOVING: Duration = Duration::from_millis(33);

impl Pace {
    pub fn ask(&mut self, d: Duration) {
        if d < self.want {
            self.want = d;
        }
    }
}
