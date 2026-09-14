// ============================================================================
// Hostel Info page — a free-form, block-based document (food timetable,
// rules, do's/don'ts, address, owner contacts, etc.) that the Super Admin
// builds and everyone else in the hostel reads. See routes/info.js and
// db/database.js getInfoPage/setInfoPage — the whole document is one JSON
// array of blocks, stored under settings.key='infoPage'.
//
// Design: exactly one canonical registry (BLOCK_TYPES) drives both the
// read-only rendering AND the edit form for every block type, so adding a
// 21st type later means adding one entry here, not touching two places.
// ============================================================================

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escMultiline(s) { return esc(s).replace(/\n/g, '<br>'); }
function escAttr(s) { return esc(s); }
function newBlockId() { return 'b-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---- generic edit-field builders (every one tags its input with data-field
// so harvestFields() below can read it back without per-type code) ----
function f_text(field, label, val = '', placeholder = '') {
  return `<div class="field"><label>${esc(label)}</label><input data-field="${field}" value="${escAttr(val)}" placeholder="${escAttr(placeholder)}"></div>`;
}
function f_textarea(field, label, val = '', rows = 3, placeholder = '') {
  return `<div class="field"><label>${esc(label)}</label><textarea data-field="${field}" rows="${rows}" placeholder="${escAttr(placeholder)}">${esc(val)}</textarea></div>`;
}
function f_list(field, label, arr = [], hint = '') {
  return `<div class="field"><label>${esc(label)}</label><textarea data-field="${field}" data-list="true" rows="4">${esc((arr || []).join('\n'))}</textarea>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}
function f_commalist(field, label, arr = [], hint = '') {
  return `<div class="field"><label>${esc(label)}</label><input data-field="${field}" data-commalist="true" value="${escAttr((arr || []).join(', '))}">${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}
function f_table(field, label, rows = [], hint = '') {
  return `<div class="field"><label>${esc(label)}</label><textarea data-field="${field}" data-table="true" rows="4">${esc((rows || []).map((r) => r.join(' | ')).join('\n'))}</textarea>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}
function f_qa(field, label, items = [], hint = '') {
  return `<div class="field"><label>${esc(label)}</label><textarea data-field="${field}" data-qa="true" rows="4">${esc((items || []).map((i) => `${i.q} :: ${i.a}`).join('\n'))}</textarea>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}
function f_select(field, label, val, options) {
  return `<div class="field"><label>${esc(label)}</label><select data-field="${field}">${options.map((o) => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
}

function harvestFields(container) {
  const data = {};
  container.querySelectorAll('[data-field]').forEach((el) => {
    const field = el.dataset.field;
    if (el.dataset.list === 'true') {
      data[field] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    } else if (el.dataset.commalist === 'true') {
      data[field] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (el.dataset.table === 'true') {
      data[field] = el.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('|').map((c) => c.trim()));
    } else if (el.dataset.qa === 'true') {
      data[field] = el.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const parts = l.split('::');
        return { q: (parts[0] || '').trim(), a: parts.slice(1).join('::').trim() };
      });
    } else {
      data[field] = el.value;
    }
  });
  return data;
}

function youtubeEmbedUrl(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

// ============================================================================
// THE 20 BLOCK TYPES
// ============================================================================
const BLOCK_TYPES = {
  heading: {
    label: 'Heading', group: 'Text',
    defaultData: () => ({ text: 'New section' }),
    renderView: (d) => `<h2 class="ie-heading">${esc(d.text)}</h2>`,
    renderEdit: (d) => f_text('text', 'Heading text', d.text),
  },
  subheading: {
    label: 'Subheading', group: 'Text',
    defaultData: () => ({ text: 'New subheading' }),
    renderView: (d) => `<h3 class="ie-subheading">${esc(d.text)}</h3>`,
    renderEdit: (d) => f_text('text', 'Subheading text', d.text),
  },
  paragraph: {
    label: 'Paragraph', group: 'Text',
    defaultData: () => ({ text: '' }),
    renderView: (d) => `<p class="ie-paragraph">${escMultiline(d.text)}</p>`,
    renderEdit: (d) => f_textarea('text', 'Text', d.text, 4, 'Write a paragraph…'),
  },
  quote: {
    label: 'Quote', group: 'Text',
    defaultData: () => ({ text: '', attribution: '' }),
    renderView: (d) => `<blockquote class="ie-quote">${escMultiline(d.text)}${d.attribution ? `<cite>${esc(d.attribution)}</cite>` : ''}</blockquote>`,
    renderEdit: (d) => f_textarea('text', 'Quote', d.text, 3) + f_text('attribution', 'Attribution (optional)', d.attribution, 'e.g. Hostel Management'),
  },
  callout: {
    label: 'Callout', group: 'Text',
    defaultData: () => ({ tone: 'info', text: '' }),
    renderView: (d) => `<div class="ie-callout ie-callout-${d.tone || 'info'}">${escMultiline(d.text)}</div>`,
    renderEdit: (d) => f_select('tone', 'Tone', d.tone, [{ value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'success', label: 'Success' }]) + f_textarea('text', 'Message', d.text, 3),
  },
  bulletList: {
    label: 'Bulleted list', group: 'Lists & rules',
    defaultData: () => ({ items: [] }),
    renderView: (d) => `<ul class="ie-bullets">${(d.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`,
    renderEdit: (d) => f_list('items', 'List items', d.items, 'One item per line'),
  },
  rules: {
    label: 'Rules & regulations', group: 'Lists & rules',
    defaultData: () => ({ items: [] }),
    renderView: (d) => `<ol class="ie-rules">${(d.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ol>`,
    renderEdit: (d) => f_list('items', 'Rules', d.items, 'One rule per line'),
  },
  dosDonts: {
    label: "Do's and don'ts", group: 'Lists & rules',
    defaultData: () => ({ dos: [], donts: [] }),
    renderView: (d) => `<div class="ie-dosdonts">
      <div class="ie-do-col"><div class="ie-col-title">Do</div><ul>${(d.dos || []).map((i) => `<li>✓ ${esc(i)}</li>`).join('')}</ul></div>
      <div class="ie-dont-col"><div class="ie-col-title">Don't</div><ul>${(d.donts || []).map((i) => `<li>✕ ${esc(i)}</li>`).join('')}</ul></div>
    </div>`,
    renderEdit: (d) => f_list('dos', "Do's", d.dos, 'One per line') + f_list('donts', "Don'ts", d.donts, 'One per line'),
  },
  checklist: {
    label: 'Checklist', group: 'Lists & rules',
    defaultData: () => ({ items: [] }),
    renderView: (d) => `<ul class="ie-checklist">${(d.items || []).map((i) => `<li>☐ ${esc(i)}</li>`).join('')}</ul>`,
    renderEdit: (d) => f_list('items', 'Checklist items', d.items, 'One per line, e.g. "Bedsheet provided"'),
  },
  amenities: {
    label: 'Amenities', group: 'Lists & rules',
    defaultData: () => ({ items: [] }),
    renderView: (d) => `<div class="ie-amenities">${(d.items || []).map((i) => `<span class="ie-chip">${esc(i)}</span>`).join('')}</div>`,
    renderEdit: (d) => f_list('items', 'Amenities', d.items, 'One per line, e.g. "Wi-Fi", "Laundry", "Hot water"'),
  },
  foodTimetable: {
    label: 'Food timetable', group: 'Tables',
    defaultData: () => ({ rows: [] }),
    renderView: (d) => `<table class="ie-table"><thead><tr><th>Day</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th></tr></thead>
      <tbody>${(d.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
    renderEdit: (d) => f_table('rows', 'Food timetable', d.rows, 'One row per line: Day | Breakfast | Lunch | Dinner'),
  },
  schedule: {
    label: 'Schedule / table', group: 'Tables',
    defaultData: () => ({ headers: [], rows: [] }),
    renderView: (d) => `<table class="ie-table"><thead><tr>${(d.headers || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${(d.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
    renderEdit: (d) => f_commalist('headers', 'Column headers', d.headers, 'Comma-separated, e.g. Time, Activity') + f_table('rows', 'Rows', d.rows, 'One row per line, columns separated by |'),
  },
  faq: {
    label: 'Questions & answers', group: 'Tables',
    defaultData: () => ({ items: [] }),
    renderView: (d) => (d.items || []).map((i) => `<details class="ie-faq"><summary>${esc(i.q)}</summary><p>${escMultiline(i.a)}</p></details>`).join(''),
    renderEdit: (d) => f_qa('items', 'Questions & answers', d.items, 'One per line: Question :: Answer'),
  },
  hostelDetails: {
    label: 'Hostel details', group: 'Details & contacts',
    defaultData: () => ({ hostelName: '', type: 'Co-ed', establishedYear: '', totalCapacity: '', description: '' }),
    renderView: (d) => `<div class="ie-hostel-details">
      ${d.hostelName ? `<div class="ie-hd-name">${esc(d.hostelName)}</div>` : ''}
      <div class="ie-hd-facts">
        ${d.type ? `<span><strong>Type:</strong> ${esc(d.type)}</span>` : ''}
        ${d.establishedYear ? `<span><strong>Established:</strong> ${esc(d.establishedYear)}</span>` : ''}
        ${d.totalCapacity ? `<span><strong>Capacity:</strong> ${esc(d.totalCapacity)} beds</span>` : ''}
      </div>
      ${d.description ? `<p class="ie-hd-desc">${escMultiline(d.description)}</p>` : ''}
    </div>`,
    renderEdit: (d) => f_text('hostelName', 'Hostel name (optional override)', d.hostelName)
      + f_select('type', 'Type', d.type, [{ value: 'Boys', label: 'Boys' }, { value: 'Girls', label: 'Girls' }, { value: 'Co-ed', label: 'Co-ed' }, { value: 'Mixed', label: 'Mixed' }])
      + f_text('establishedYear', 'Established year (optional)', d.establishedYear, 'e.g. 2018')
      + f_text('totalCapacity', 'Total capacity (optional)', d.totalCapacity, 'e.g. 120')
      + f_textarea('description', 'About this hostel', d.description, 4, 'A short description tenants will read first…'),
  },
  addressCard: {
    label: 'Hostel address', group: 'Details & contacts',
    defaultData: () => ({ line1: '', line2: '', city: '', state: '', pincode: '', mapLink: '' }),
    renderView: (d) => `<div class="ie-address">
      <div class="ie-address-lines">${[d.line1, d.line2, [d.city, d.state].filter(Boolean).join(', '), d.pincode].filter(Boolean).map(esc).join('<br>')}</div>
      ${d.mapLink ? `<a href="${escAttr(d.mapLink)}" target="_blank" rel="noopener" class="ie-maplink">Open in Maps →</a>` : ''}
    </div>`,
    renderEdit: (d) => f_text('line1', 'Address line 1', d.line1) + f_text('line2', 'Address line 2', d.line2) + f_text('city', 'City', d.city) + f_text('state', 'State', d.state) + f_text('pincode', 'Pincode', d.pincode) + f_text('mapLink', 'Google Maps link (optional)', d.mapLink, 'https://maps.google.com/…'),
  },
  contactCard: {
    label: 'Owner / contact', group: 'Details & contacts',
    defaultData: () => ({ name: '', role: '', phone: '', note: '' }),
    renderView: (d) => `<div class="ie-contact">
      <div class="ie-contact-name">${esc(d.name)}</div>
      ${d.role ? `<div class="ie-contact-role">${esc(d.role)}</div>` : ''}
      ${d.phone ? `<a href="tel:${escAttr(d.phone)}" class="ie-contact-phone">${esc(d.phone)}</a>` : ''}
      ${d.note ? `<div class="ie-contact-note">${esc(d.note)}</div>` : ''}
    </div>`,
    renderEdit: (d) => f_text('name', 'Name', d.name, 'e.g. Priya Sharma') + f_text('role', 'Role', d.role, 'e.g. Owner, Sub-owner, Warden') + f_text('phone', 'Phone', d.phone) + f_text('note', 'Note (optional)', d.note),
  },
  image: {
    label: 'Image', group: 'Media & layout',
    defaultData: () => ({ imageData: '', caption: '' }),
    renderView: (d) => d.imageData ? `<figure class="ie-figure"><img src="${d.imageData}">${d.caption ? `<figcaption>${esc(d.caption)}</figcaption>` : ''}</figure>` : `<div class="ie-empty-hint">No image uploaded yet</div>`,
    renderEdit: (d) => `<div class="field"><label>Image</label><input type="file" accept="image/*" class="ie-image-input">${d.imageData ? `<img src="${d.imageData}" class="ie-image-preview">` : ''}</div>` + f_text('caption', 'Caption (optional)', d.caption),
  },
  video: {
    label: 'Video link', group: 'Media & layout',
    defaultData: () => ({ url: '', caption: '' }),
    renderView: (d) => {
      const embed = youtubeEmbedUrl(d.url);
      if (embed) return `<div class="ie-video"><iframe src="${escAttr(embed)}" allowfullscreen></iframe>${d.caption ? `<div class="ie-video-caption">${esc(d.caption)}</div>` : ''}</div>`;
      return d.url ? `<a href="${escAttr(d.url)}" target="_blank" rel="noopener" class="ie-maplink">Watch video →</a>` : `<div class="ie-empty-hint">No video link yet</div>`;
    },
    renderEdit: (d) => f_text('url', 'Video URL', d.url, 'YouTube link, or any video link') + f_text('caption', 'Caption (optional)', d.caption),
  },
  twoColumn: {
    label: 'Two columns', group: 'Media & layout',
    defaultData: () => ({ leftTitle: '', leftText: '', rightTitle: '', rightText: '' }),
    renderView: (d) => `<div class="ie-two-col">
      <div>${d.leftTitle ? `<div class="ie-col-title">${esc(d.leftTitle)}</div>` : ''}<div>${escMultiline(d.leftText)}</div></div>
      <div>${d.rightTitle ? `<div class="ie-col-title">${esc(d.rightTitle)}</div>` : ''}<div>${escMultiline(d.rightText)}</div></div>
    </div>`,
    renderEdit: (d) => f_text('leftTitle', 'Left title (optional)', d.leftTitle) + f_textarea('leftText', 'Left text', d.leftText, 3) + f_text('rightTitle', 'Right title (optional)', d.rightTitle) + f_textarea('rightText', 'Right text', d.rightText, 3),
  },
  divider: {
    label: 'Divider', group: 'Media & layout',
    defaultData: () => ({}),
    renderView: () => `<hr class="ie-divider">`,
    renderEdit: () => `<div class="hint">No settings — this just adds a visual break.</div>`,
  },
};

const BLOCK_GROUPS = ['Text', 'Lists & rules', 'Tables', 'Details & contacts', 'Media & layout'];

// ============================================================================
// APP STATE + RENDERING
// ============================================================================
let blocks = [];
let lastSaved = '[]';
let editMode = false;
let isSuperAdmin = false;
let dragFromIndex = null;

function isDirty() { return JSON.stringify(blocks) !== lastSaved; }

async function loadInfoPage() {
  const data = await api('/info');
  blocks = (data.blocks || []).map((b) => ({ ...b, id: b.id || newBlockId() }));
  lastSaved = JSON.stringify(blocks);
  render();
}

function render() {
  document.getElementById('editToggleWrap').style.display = isSuperAdmin ? 'flex' : 'none';
  document.getElementById('infoDoc').innerHTML = '';
  document.getElementById('palette').style.display = editMode ? 'block' : 'none';
  document.getElementById('editModeBanner').style.display = editMode ? 'flex' : 'none';
  document.body.classList.toggle('ie-editing', editMode);

  if (editMode) renderEditCanvas(); else renderViewCanvas();
}

function renderViewCanvas() {
  const doc = document.getElementById('infoDoc');
  if (blocks.length === 0) {
    doc.innerHTML = `<div class="ie-empty-hint ie-empty-big">
      ${isSuperAdmin ? "Nothing here yet — click Edit page to add the food timetable, rules, hostel address, and owner contacts." : "Nothing here yet."}
    </div>`;
    return;
  }
  doc.innerHTML = blocks.map((b) => BLOCK_TYPES[b.type] ? BLOCK_TYPES[b.type].renderView(b.data) : '').join('');
}

function renderEditCanvas() {
  const doc = document.getElementById('infoDoc');
  if (blocks.length === 0) {
    doc.innerHTML = `<div class="ie-empty-hint ie-empty-big">Add your first block from the panel on the left.</div>`;
  } else {
    doc.innerHTML = blocks.map((b, i) => {
      const def = BLOCK_TYPES[b.type];
      if (!def) return '';
      return `<div class="ie-block-wrap" draggable="true" data-index="${i}">
        <div class="ie-block-toolbar">
          <span class="ie-drag-handle" title="Drag to reorder">⠿</span>
          <span class="ie-block-type-label">${esc(def.label)}</span>
          <span class="ie-toolbar-spacer"></span>
          <button type="button" class="ie-tbtn" data-action="up" title="Move up">↑</button>
          <button type="button" class="ie-tbtn" data-action="down" title="Move down">↓</button>
          <button type="button" class="ie-tbtn ie-tbtn-danger" data-action="delete" title="Delete block">Delete</button>
        </div>
        <div class="ie-block-editform" data-index="${i}">${def.renderEdit(b.data)}</div>
      </div>`;
    }).join('');
  }
  wireEditCanvasEvents();
}

function wireEditCanvasEvents() {
  const doc = document.getElementById('infoDoc');

  doc.querySelectorAll('.ie-block-wrap').forEach((wrap) => {
    const index = Number(wrap.dataset.index);

    wrap.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'up' && index > 0) { [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]]; renderEditCanvas(); }
        if (action === 'down' && index < blocks.length - 1) { [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]]; renderEditCanvas(); }
        if (action === 'delete') { if (confirm('Delete this block?')) { blocks.splice(index, 1); renderEditCanvas(); } }
      });
    });

    // live-sync form fields -> in-memory block data, no full re-render needed
    const formEl = wrap.querySelector('.ie-block-editform');
    formEl.querySelectorAll('[data-field]').forEach((input) => {
      input.addEventListener('input', () => { blocks[index].data = harvestFields(formEl); });
    });

    // image upload (special-cased — not a plain [data-field] text value)
    const imgInput = wrap.querySelector('.ie-image-input');
    if (imgInput) {
      imgInput.addEventListener('change', () => {
        const file = imgInput.files[0];
        if (!file) return;
        if (file.size > 850000) { toast('Image too large — please use one under ~850KB', 'err'); return; }
        const reader = new FileReader();
        reader.onload = () => {
          blocks[index].data.imageData = reader.result;
          renderEditCanvas();
        };
        reader.readAsDataURL(file);
      });
    }

    // drag-and-drop reordering
    wrap.addEventListener('dragstart', () => { dragFromIndex = index; wrap.classList.add('dragging'); });
    wrap.addEventListener('dragend', () => { wrap.classList.remove('dragging'); });
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drag-over'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      wrap.classList.remove('drag-over');
      if (dragFromIndex === null || dragFromIndex === index) return;
      const [moved] = blocks.splice(dragFromIndex, 1);
      blocks.splice(index, 0, moved);
      dragFromIndex = null;
      renderEditCanvas();
    });
  });
}

function renderPalette() {
  const el = document.getElementById('palette');
  el.innerHTML = `<div class="ie-palette-title">Add a block</div>` + BLOCK_GROUPS.map((group) => `
    <div class="ie-palette-group">
      <div class="ie-palette-group-label">${esc(group)}</div>
      ${Object.entries(BLOCK_TYPES).filter(([, def]) => def.group === group).map(([type, def]) =>
        `<button type="button" class="ie-palette-btn" data-type="${type}">${esc(def.label)}</button>`
      ).join('')}
    </div>`).join('');

  el.querySelectorAll('.ie-palette-btn').forEach((btn) => btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    blocks.push({ id: newBlockId(), type, data: BLOCK_TYPES[type].defaultData() });
    renderEditCanvas();
    // scroll the new block into view
    const doc = document.getElementById('infoDoc');
    doc.lastElementChild && doc.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

async function saveInfoPage() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('/info', { method: 'PUT', body: { blocks } });
    lastSaved = JSON.stringify(blocks);
    toast('Saved');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

function exitEditMode() {
  if (isDirty() && !confirm('Discard unsaved changes?')) return;
  blocks = JSON.parse(lastSaved);
  editMode = false;
  render();
}

// ============================================================================
// BOOT
// ============================================================================
(async function initInfoPage() {
  const session = getSession();
  if (!session) { window.location.href = '/'; return; }
  isSuperAdmin = session.user.type === 'admin' && session.user.role === 'super';

  document.getElementById('backLink').href = session.user.type === 'admin' ? '/admin.html' : '/tenant.html';

  document.getElementById('editBtn').addEventListener('click', () => { editMode = true; render(); });
  document.getElementById('exitEditBtn').addEventListener('click', exitEditMode);
  document.getElementById('saveBtn').addEventListener('click', saveInfoPage);

  renderPalette();
  try {
    await loadInfoPage();
  } catch (e) {
    toast(e.message, 'err');
  }
})();
