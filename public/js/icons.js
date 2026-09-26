// A compact set of clean, consistent line icons — replaces the emoji icons
// (🏢💳📮💬 etc.) that looked inconsistent across devices/OSes and read as
// "unpolished" for a paid product. Zero external dependency: these are
// hand-built generic line-icon shapes (24x24, stroke-based), not pulled
// from any third-party icon font or library, so there's nothing to load
// or license.
//
// Usage: <span class="gicon" data-icon="home"></span> — replaced with the
// real inline SVG on page load by the script at the bottom of this file.
// Sizing/color are controlled entirely by CSS (.gicon svg{ width/height/
// stroke }), same as the emoji they replace.

const GICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/></svg>',
  building: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1"/></svg>',
  card: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18"/><path d="M7 15h4"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  userPlus: '<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="3.3"/><path d="M4 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M19 8v5M16.5 10.5h5"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.3 2.3 4.7-5"/></svg>',
  messageCircle: '<svg viewBox="0 0 24 24"><path d="M20 11.5a7.5 7.5 0 1 1-3.2-6.1L20 4l-1 3.6c.6 1.1 1 2.4 1 3.9Z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 12h4.5l1.5 3h6l1.5-3H21"/><path d="M5.5 5h13l2.5 7v6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-6l2.5-7Z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 6l2.5 2.5M13 9l2 2"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="12" height="16" rx="1.5"/><rect x="9" y="3" width="6" height="3" rx="1"/><path d="M9 11h6M9 14.5h6M9 18h4"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.3" r="3.6"/><path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5"/></svg>',
  scroll: '<svg viewBox="0 0 24 24"><path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4Z"/><path d="M6 4a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2"/><path d="M9 9h6M9 12.5h6M9 16h4"/></svg>',
  logOut: '<svg viewBox="0 0 24 24"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M15 8l4 4-4 4M19 12H9"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/><path d="M3 18v2M21 18v2M3 12V7M7 12V9.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 13 9.5V12"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3.5 19 6.5V11c0 4.8-3 7.8-7 9.5-4-1.7-7-4.7-7-9.5V6.5L12 3.5Z"/></svg>',
  chevronUp: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/></svg>',
};

function applyIcons(root) {
  (root || document).querySelectorAll('.gicon[data-icon]').forEach((el) => {
    const svg = GICONS[el.dataset.icon];
    if (svg && !el.dataset.filled) { el.innerHTML = svg; el.dataset.filled = '1'; }
  });
}
window.applyIcons = applyIcons;
document.addEventListener('DOMContentLoaded', () => applyIcons());
