//! This Mac at the base of the building, its testlock bays, and the owner's ring under it.
//! Copied from `drawBase` (line 913) and `drawRing` (line 1038) in the concept page, shapes only.
//! - The base is `--deck` with a `--line` edge. A hot Mac warms both toward amber.
//! - A held bay is cyan at 7% with a cyan edge at 35%.
//! - The ring is night with an amber edge at 85% while cards wait, and a breathing amber glow.
//!   With no cards it dims to an ink edge at 60% and no glow.

use crate::draw::{edge_shape, rect_shape, srgba, Frame, Kit, Pace, Shape, BLINKING, DECK, INK, LINE, NIGHT, WAIT, WALL, WORK};
use crate::{Current, Step};
use bevy::prelude::*;
use bevy::sprite_render::AlphaMode2d;

#[derive(Component)]
struct Drawn;

/// The ring's glow, which breathes.
#[derive(Component)]
struct Breath;

/// The breathing glow's own colour, so its alpha can change every frame.
#[derive(Resource)]
struct BreathPaint(Handle<ColorMaterial>);

pub(crate) fn plugin(app: &mut App) {
    app.add_systems(Startup, setup).add_systems(Update, (redraw.run_if(resource_changed::<Current>), breathe).chain().in_set(Step::Draw));
}

fn setup(mut commands: Commands, mut mats: ResMut<Assets<ColorMaterial>>) {
    commands.insert_resource(BreathPaint(mats.add(ColorMaterial { color: srgba(WAIT, 0.32), alpha_mode: AlphaMode2d::Blend, ..default() })));
}

#[allow(clippy::too_many_arguments)]
fn redraw(
    mut commands: Commands,
    mut kit: ResMut<Kit>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    breath: Res<BreathPaint>,
    current: Res<Current>,
    frame: Res<Frame>,
    old: Query<Entity, With<Drawn>>,
) {
    for e in &old {
        commands.entity(e).despawn();
    }
    let frame = *frame;
    let mut put = |mesh: Handle<Mesh>, mat: Handle<ColorMaterial>, t: Transform| commands.spawn((Drawn, Mesh2d(mesh), MeshMaterial2d(mat), t)).id();
    if let Some(b) = current.0.base {
        let at = Transform::from_translation(frame.at(b.x + b.w / 2.0, b.y + b.h / 2.0, 0.0));
        put(kit.shape(&mut meshes, rect_shape(b.w, b.h, 10.0)), kit.paint(&mut mats, DECK, 1.0), at);
        put(kit.shape(&mut meshes, edge_shape(b.w, b.h, 10.0, 1.0)), kit.paint(&mut mats, LINE, 1.0), at.with_translation(at.translation.with_z(0.02)));
        if b.hot {
            // Hot Mac: an amber wash over the fill and an amber edge.
            put(kit.shape(&mut meshes, rect_shape(b.w, b.h, 10.0)), kit.paint(&mut mats, WAIT, 0.08), at.with_translation(at.translation.with_z(0.01)));
            put(kit.shape(&mut meshes, edge_shape(b.w, b.h, 10.0, 1.0)), kit.paint(&mut mats, WAIT, 0.55), at.with_translation(at.translation.with_z(0.03)));
        }
    }
    for b in &current.0.bays {
        let at = Transform::from_translation(frame.at(b.x + b.w / 2.0, b.y + b.h / 2.0, 0.05));
        let (fill, edge) = if b.held { (kit.paint(&mut mats, WORK, 0.07), kit.paint(&mut mats, WORK, 0.35)) } else { (kit.paint(&mut mats, WALL, 1.0), kit.paint(&mut mats, LINE, 1.0)) };
        put(kit.shape(&mut meshes, rect_shape(b.w, b.h, 7.0)), fill, at);
        put(kit.shape(&mut meshes, edge_shape(b.w, b.h, 7.0, 1.0)), edge, at.with_translation(at.translation.with_z(0.06)));
    }
    if let Some(r) = current.0.ring {
        let at = |z: f32| Transform::from_translation(frame.at(r.x, r.y, z));
        put(kit.shape(&mut meshes, Shape::Circle), kit.paint(&mut mats, NIGHT, 1.0), at(0.6).with_scale(Vec3::splat(r.r)));
        // A 1.5 px stroke centred on the radius, as the canvas draws it.
        let outer = r.r + 0.75;
        let ring = kit.shape(&mut meshes, Shape::Ring((1.5 / outer * 1000.0).round() as i32));
        let edge = if r.waiting { kit.paint(&mut mats, WAIT, 0.85) } else { kit.paint(&mut mats, INK, 0.6) };
        put(ring, edge, at(0.62).with_scale(Vec3::splat(outer)));
        if r.waiting {
            let glow = kit.shape(&mut meshes, Shape::Glow);
            commands.spawn((Drawn, Breath, Mesh2d(glow), MeshMaterial2d(breath.0.clone()), at(0.55).with_scale(Vec3::splat(r.r * 2.4))));
        }
    }
}

/// The ring's glow breathes at sin 2t between 0.2 and 0.44. Still with reduced motion.
fn breathe(time: Res<Time>, current: Res<Current>, breath: Res<BreathPaint>, glows: Query<(), With<Breath>>, mut pace: ResMut<Pace>, mut mats: ResMut<Assets<ColorMaterial>>) {
    if glows.is_empty() {
        return;
    }
    let al = if current.0.reduced { 0.4 } else { 0.32 + 0.12 * (time.elapsed_secs() * 2.0).sin() };
    if !current.0.reduced {
        pace.ask(BLINKING);
    }
    if let Some(mut m) = mats.get_mut(&breath.0) {
        m.color = crate::draw::fade(m.color, al);
    }
}
