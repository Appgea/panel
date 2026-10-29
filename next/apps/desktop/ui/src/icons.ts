/**
 * Panel's small, dependency-free icon set.
 *
 * These are interface words, not decoration: every path inherits currentColor, so module
 * identity and state remain CSS's job. Keeping the set here prevents emoji/platform font drift.
 */
export type IconName =
  | "home"
  | "inbox"
  | "terminal"
  | "play"
  | "dashboard"
  | "work"
  | "radio"
  | "git"
  | "spine"
  | "release"
  | "revenue"
  | "watermark"
  | "branch"
  | "agent"
  | "folder"
  | "image"
  | "arrow"
  | "moon"
  | "sun"
  | "panel-left"
  | "panel-right"
  | "stop"
  | "log"
  | "reload"
  | "rebuild"
  | "analytics"
  | "standards"
  | "code"
  | "gear"
  | "sliders"
  | "keyboard"
  | "plug"
  | "server"
  | "flag";

const paths: Record<IconName, string> = {
  // Six teeth rather than the usual eight: at 14px the extra pair closes the gaps into a blob.
  standards: '<path d="M4 5h11M4 12h11M4 19h7"/><path d="m16 17.5 2 2 4-4.5"/>',
  gear: '<path d="M10.3 3.2h3.4l.5 2.3 1.6.9 2.2-.8 1.7 2.9-1.8 1.6v1.8l1.8 1.6-1.7 2.9-2.2-.8-1.6.9-.5 2.3h-3.4l-.5-2.3-1.6-.9-2.2.8-1.7-2.9 1.8-1.6v-1.8L4.3 8.5 6 5.6l2.2.8 1.6-.9z" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.6"/>',
  home: '<path d="M3 10.6 12 3l9 7.6v9.1a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 19.7Z"/><path d="M9 21v-7h6v7"/>',
  inbox: '<path d="M4 5h16v14H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>',
  terminal: '<path d="m5 7 4 4-4 4"/><path d="M11 17h8"/><rect x="2.5" y="3" width="19" height="18" rx="3"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  work: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h4"/>',
  radio: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.8 4.8a10.2 10.2 0 0 0 0 14.4M19.2 4.8a10.2 10.2 0 0 1 0 14.4"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 9c3.5 0 3.7-3 8-3"/>',
  spine: '<path d="M12 3v18M8.5 5.2 12 7l3.5-1.8M8.5 9.2 12 11l3.5-1.8M8.5 13.2 12 15l3.5-1.8M8.5 17.2 12 19l3.5-1.8"/>',
  release: '<path d="M14 4c3.7.5 5.5 2.3 6 6l-6.5 6.5-6-6Z"/><path d="m9.5 12.5-3.3.7L3 16.4l4.6.5M11.5 14.5l-.7 3.3L7.6 21l-.5-4.6"/><circle cx="15.5" cy="8.5" r="1.5"/>',
  revenue: '<path d="M4 19V5M4 19h16"/><path d="m7 15 4-4 3 2 5-6"/><path d="M15 7h4v4"/>',
  watermark: '<path d="M12 3.5S6 10.1 6 15a6 6 0 0 0 12 0c0-4.9-6-11.5-6-11.5Z"/><path d="M9.2 15.5a3 3 0 0 0 3 3"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 11c4 0 4-4 6-4"/>',
  agent: '<path d="M12 3v3M8 3h8"/><rect x="4" y="7" width="16" height="13" rx="3"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 17h6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-4 3 2.5 3.5-3 4.5 4"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  moon: '<path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  "panel-left": '<path d="m14.5 6-6 6 6 6"/>',
  "panel-right": '<path d="m9.5 6 6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  log: '<path d="M5 4h14v16H5zM8.5 9h7M8.5 13h7M8.5 17h4"/>',
  reload: '<path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5"/>',
  rebuild: '<path d="M20 7a9 9 0 0 0-15.5-1L3 8M4 17a9 9 0 0 0 15.5 1l1.5-2M3 3v5h5M21 21v-5h-5"/>',
  code: '<path d="m9 7-5 5 5 5M15 7l5 5-5 5M14 4l-4 16"/>',
  // The four Settings sections. The dots are zero-length paths; round caps draw them.
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  analytics: '<path d="M4 20V4M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>',
};

export function icon(name: IconName, className = "ui-icon"): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
