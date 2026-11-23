
use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;
use std::time::Duration;

pub const NIGHT: u32 = 0x0A0D13;
pub const DECK: u32 = 0x0E121A;
pub const WALL: u32 = 0x11161F;
pub const RAISE: u32 = 0x171D29;
pub const LINE: u32 = 0x232B3A;
pub const LINE_2: u32 = 0x333D50;
pub const INK: u32 = 0xE6EAF1;
pub const WORK: u32 = 0x6FE7FF;
pub const THINK: u32 = 0x93B4FF;
pub const WAIT: u32 = 0xFFB23F;
pub const IDLE: u32 = 0x6B7689;
pub const FAIL: u32 = 0xFF5A6A;
pub const GOLD: u32 = 0xFFE27A;
pub const HULL: u32 = 0xDDE4EF;
pub const VOID: u32 = 0x05070B;

pub fn srgb(hex: u32) -> Color {
    Color::srgb_u8((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

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

pub fn seen(hex: u32, alpha: f32) -> f32 {
    let ch = |s: u32| ((hex >> s) & 0xFF) as f32 / 255.0;
    seen_rgb([ch(16), ch(8), ch(0)], alpha)
}

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

#[derive(Resource, Default, Clone, Copy)]
pub struct Frame {
    pub w: f32,
    pub h: f32,
}

impl Frame {
    pub fn at(&self, x: f32, y: f32, z: f32) -> Vec3 {
        Vec3::new(x, -y, z)
    }
}

pub fn line(frame: Frame, a: Vec2, b: Vec2, z: f32, width: f32) -> Transform {
    let (a, b) = (frame.at(a.x, a.y, z), frame.at(b.x, b.y, z));
    let d = b - a;
    Transform::from_translation((a + b) / 2.0)
        .with_rotation(Quat::from_rotation_z(d.y.atan2(d.x)))
        .with_scale(Vec3::new(d.truncate().length(), width, 1.0))
}

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

pub fn mesh(pos: Vec<[f32; 3]>, idx: Vec<u32>) -> Mesh {
    let count = pos.len();
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; count])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; count])
        .with_inserted_indices(Indices::U32(idx))
}

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

pub fn arc(rx: f32, ry: f32, width: f32, from: f32, to: f32) -> Mesh {
    let sides = (((to - from).abs() / std::f32::consts::TAU) * 48.0).ceil().max(2.0) as u32;
    let mut pos: Vec<[f32; 3]> = Vec::new();
    for i in 0..=sides {
        let t = from + (to - from) * i as f32 / sides as f32;
        pos.push([t.cos() * rx, t.sin() * ry, 0.0]);
        pos.push([t.cos() * (rx - width), t.sin() * (ry - width), 0.0]);
    }
    let mut idx = Vec::new();
    for i in 0..sides {
        idx.extend([2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 2, 2 * i + 3, 2 * i + 1]);
    }
    mesh(pos, idx)
}

pub fn parts(polys: &[(Vec<(f32, f32)>, f32)]) -> Mesh {
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut col: Vec<[f32; 4]> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    for (pts, g) in polys {
        let base = pos.len() as u32;
        for (x, y) in pts {
            pos.push([*x, *y, 0.0]);
            col.push([*g, *g, *g, 1.0]);
        }
        for i in 1..pts.len() as u32 - 1 {
            idx.extend([base, base + i, base + i + 1]);
        }
    }
    mesh(pos, idx).with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
}

pub fn lit_pair(pts: &[(f32, f32)], g: f32) -> [(Vec<(f32, f32)>, f32); 2] {
    [(pts.to_vec(), g), (pts.iter().map(|(x, y)| (*x, -*y)).collect(), g * 0.55)]
}

pub fn shaded_disc() -> Mesh {
    const RINGS: [f32; 4] = [0.45, 0.75, 0.93, 1.0];
    const SIDES: u32 = 48;
    let light = Vec2::new(-0.6, 0.7).normalize();
    let shade = |p: Vec2| {
        let lit = 0.5 + 0.5 * p.dot(light);
        let g = (0.05 + 0.95 * lit * lit) * (1.0 - 0.3 * p.length().powi(3));
        [g, g, g, 1.0]
    };
    let mut pos: Vec<[f32; 3]> = vec![[0.0, 0.0, 0.0]];
    let mut col: Vec<[f32; 4]> = vec![shade(Vec2::ZERO)];
    for r in RINGS {
        for i in 0..SIDES {
            let t = i as f32 / SIDES as f32 * std::f32::consts::TAU;
            let p = Vec2::new(t.cos(), t.sin()) * r;
            pos.push([p.x, p.y, 0.0]);
            col.push(shade(p));
        }
    }
    let mut idx = Vec::new();
    for i in 0..SIDES {
        idx.extend([0, 1 + i, 1 + (i + 1) % SIDES]);
    }
    for ring in 0..RINGS.len() as u32 - 1 {
        let (a, b) = (1 + ring * SIDES, 1 + (ring + 1) * SIDES);
        for i in 0..SIDES {
            let j = (i + 1) % SIDES;
            idx.extend([a + i, b + i, a + j, a + j, b + i, b + j]);
        }
    }
    mesh(pos, idx).with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
}

pub fn slab(a: f32, b: f32) -> Mesh {
    const STEPS: u32 = 10;
    let ys: Vec<f32> = (0..=STEPS).map(|i| a + (b - a) * i as f32 / STEPS as f32).collect();
    let x = |y: f32| (1.0 - y * y).max(0.0).sqrt();
    let mut pts: Vec<(f32, f32)> = ys.iter().map(|y| (x(*y), *y)).collect();
    pts.extend(ys.iter().rev().map(|y| (-x(*y), *y)));
    parts(&[(pts, 1.0)])
}

pub fn soft_disc() -> Mesh {
    const SIDES: u32 = 40;
    let mut pos: Vec<[f32; 3]> = vec![[0.0, 0.0, 0.0]];
    let mut col: Vec<[f32; 4]> = vec![[1.0, 1.0, 1.0, 1.0]];
    for (r, a) in [(0.5f32, 0.3f32), (1.0, 0.0)] {
        for i in 0..SIDES {
            let t = i as f32 / SIDES as f32 * std::f32::consts::TAU;
            pos.push([t.cos() * r, t.sin() * r, 0.0]);
            col.push([1.0, 1.0, 1.0, a]);
        }
    }
    let mut idx = Vec::new();
    for i in 0..SIDES {
        let j = (i + 1) % SIDES;
        idx.extend([0, 1 + i, 1 + j, 1 + i, 1 + SIDES + i, 1 + j, 1 + j, 1 + SIDES + i, 1 + SIDES + j]);
    }
    mesh(pos, idx).with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
}

pub fn circle_edge(width: f32) -> Mesh {
    ellipse_edge(1.0, 1.0, width)
}

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
pub enum Shape {
    Square,
    Circle,
    Glow,
    Rect(i32, i32, i32),
    Edge(i32, i32, i32, i32),
    Ellipse(i32, i32, i32),
    Ring(i32),
}

pub fn tenth(v: f32) -> i32 {
    (v * 10.0).round() as i32
}

#[derive(Resource, Default)]
pub struct Kit {
    shapes: std::collections::HashMap<Shape, Handle<Mesh>>,
    paints: std::collections::HashMap<(u32, u8), Handle<ColorMaterial>>,
    named: std::collections::HashMap<&'static str, Handle<Mesh>>,
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

    pub fn named(&mut self, meshes: &mut Assets<Mesh>, name: &'static str, make: impl FnOnce() -> Mesh) -> Handle<Mesh> {
        self.named.entry(name).or_insert_with(|| meshes.add(make())).clone()
    }

    pub fn paint(&mut self, mats: &mut Assets<ColorMaterial>, hex: u32, alpha: f32) -> Handle<ColorMaterial> {
        let a = (alpha.clamp(0.0, 1.0) * 100.0).round() as u8;
        self.paints.entry((hex, a)).or_insert_with(|| flat(mats, srgba(hex, a as f32 / 100.0))).clone()
    }
}

pub fn edge_shape(w: f32, h: f32, r: f32, width: f32) -> Shape {
    Shape::Edge(tenth(w), tenth(h), tenth(r), tenth(width))
}

pub fn rect_shape(w: f32, h: f32, r: f32) -> Shape {
    Shape::Rect(tenth(w), tenth(h), tenth(r))
}

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

pub fn phase(id: &str) -> f32 {
    let mut h: u32 = 2166136261;
    for b in id.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    (h % 1000) as f32 / 1000.0 * std::f32::consts::TAU
}

#[derive(Resource)]
pub struct Pace {
    pub want: Duration,
}

pub const STILL: Duration = Duration::from_millis(250);
pub const BLINKING: Duration = Duration::from_millis(100);
pub const MOVING: Duration = Duration::from_millis(33);

impl Pace {
    pub fn ask(&mut self, d: Duration) {
        if d < self.want {
            self.want = d;
        }
    }
}
