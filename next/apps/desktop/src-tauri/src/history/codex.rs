//! Codex sessions, read from the `threads` table of `~/.codex/state_<n>.sqlite`.
//!
//! Codex keeps one row per thread: its folder, title, first prompt, model and one token total.
//! Replies are not on disk (the rollout files are gone in paginated history), so a Codex row has
//! no last reply and no per-hour token split; it carries the total at the hour it last moved.
//! Subagent and guardian threads spend tokens for their parent and are not listed.

use super::{iso_from_ms, sqlite, store, Found, Resume};
use std::path::PathBuf;

/// The newest state database. Codex bumps the number when its schema changes.
fn database() -> Option<PathBuf> {
    let home = store("CODEX_HOME", ".codex")?;
    std::fs::read_dir(home)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version: u32 = name.strip_prefix("state_")?.strip_suffix(".sqlite")?.parse().ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

pub(super) fn sessions(days: u64) -> Result<Vec<Found>, String> {
    let Some(path) = database() else {
        return Ok(Vec::new());
    };
    let db = sqlite(&path)?;
    let mut query = db
        .prepare(
            "SELECT id, cwd, title, first_user_message, COALESCE(model, ''), tokens_used,
                    COALESCE(created_at_ms, created_at * 1000), COALESCE(updated_at_ms, updated_at * 1000),
                    source, has_user_event
             FROM threads WHERE COALESCE(updated_at_ms, updated_at * 1000) >= ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([super::cutoff_ms(days)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, cwd, title, first, model, tokens, created, updated, source, had_user) = row;
        let mut found = Found::new("codex", Resume::Exact);
        found.summary.id = id;
        found.summary.cwd = cwd;
        found.summary.title = title;
        let started = iso_from_ms(created);
        let ended = iso_from_ms(updated);
        found.saw(&started);
        found.saw(&ended);
        found.push_text(&started, true, &first);
        // Codex records the first prompt only; how many followed is not on disk.
        found.summary.prompts = 0;
        found.summary.headless = source == "exec";
        // `cli`, `vscode` and `exec` are threads a person started; JSON sources are subagents.
        found.listed = !source.starts_with('{') && (had_user != 0 || !first.trim().is_empty());
        if tokens > 0 {
            found.add_tokens(&model, &ended, [0, 0, 0, 0, tokens as u64]);
        }
        out.push(found);
    }
    Ok(out)
}
