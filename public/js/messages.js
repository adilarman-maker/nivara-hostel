// ============================================================================
// Messages / Announcements board — shared between admin.html and tenant.html.
// Only admins (super or sub) can post; every admin and every tenant within a
// message's visibility scope can read it and vote on polls. Real-time here
// means fast polling (every 6s while the tab is visible), not a live socket
// connection — Vercel's serverless functions don't hold a persistent
// connection open, so polling is the practical choice without adding new
// infrastructure. It feels close to instant in practice at hostel scale.
//
// Usage: call initMessagesBoard('someContainerId') once the page's own
// session guard has already run. Renders the whole feed (+ composer, if the
// viewer is an admin) into that container and starts polling.
// ============================================================================

let _msgLastTimestamp = null;
let _msgPollTimer = null;
let _msgStagedImage = null; // data URL staged before sending, or null
let _msgPollDraftOptions = ['', ''];
let _msgPollOptionsTargetId = 'msgPollOptionsList'; // which modal's list we're currently editing — create or edit
let _msgSending = false;   // guards against double-submission from a double-click, Enter+click, or a slow round-trip
let _msgFetching = false;  // guards against an initial-load and a poll cycle overlapping and both writing to the feed
let _msgRenderedIds = new Set(); // every message id currently in the DOM — belt-and-suspenders against ever rendering the same message twice, no matter how it got fetched twice
let _msgCurrentChannel = 'all'; // 'all' | 'admins' | a specific block code — which chat-list tab is active
let _msgMessagesById = new Map(); // cache of the currently-rendered messages, so actions (edit/forward/copy) don't need a fresh fetch

function _msgViewer() {
  const s = getSession();
  return s ? s.user : null;
}

async function initMessagesBoard(containerId) {
  const viewer = _msgViewer();
  const container = document.getElementById(containerId);
  if (!viewer || !container) return;
  const isAdmin = viewer.type === 'admin';
  _msgCurrentChannel = 'all';

  container.innerHTML = `
    <div class="msg-board">
      ${isAdmin ? `<div class="msg-channel-tabs" id="msgChannelTabs"></div>` : ''}
      <div class="msg-feed" id="msgFeed"><div class="skeleton" style="height:60px; margin:16px;"></div></div>
      ${isAdmin ? _msgComposerHtml(viewer) : `<div class="msg-viewonly-note">📢 Announcements from your hostel admins appear here.</div>`}
    </div>
  `;

  if (isAdmin) {
    await _msgLoadBlockOptions(viewer);
    await _msgRenderChannelTabs(viewer);
    _msgWireComposer(viewer);
  }

  await _msgLoadInitial();
  _msgStartPolling();

  document.removeEventListener('visibilitychange', _msgVisibilityHandler);
  document.addEventListener('visibilitychange', _msgVisibilityHandler);
}

async function _msgRenderChannelTabs(viewer) {
  await loadBlockMeta();
  const tabsHolder = document.getElementById('msgChannelTabs');
  if (!tabsHolder) return;
  const blockTabs = Object.entries(BLOCK_META).map(([code, b]) =>
    `<button type="button" class="msg-tab" data-channel="${code}">${escapeHtml(b.name)}</button>`
  ).join('');
  tabsHolder.innerHTML = `
    <button type="button" class="msg-tab active" data-channel="all">All</button>
    ${blockTabs}
    <button type="button" class="msg-tab msg-tab-admin" data-channel="admins">🔒 Admin team</button>
  `;
  tabsHolder.querySelectorAll('.msg-tab').forEach((btn) => {
    btn.addEventListener('click', () => _msgSwitchChannel(btn.dataset.channel));
  });
}

function _msgSwitchChannel(channel) {
  _msgCurrentChannel = channel;
  document.querySelectorAll('.msg-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.channel === channel));
  _msgLastTimestamp = null;
  _msgRenderedIds = new Set();
  _msgMessagesById.clear();
  // If a scope selector exists (Super Admin), default it to match the tab
  // you're viewing — posting from within a block's tab naturally goes there.
  const scopeSel = document.getElementById('msgScopeSelect');
  if (scopeSel && channel !== 'all' && channel !== 'admins') scopeSel.value = channel;
  const adminOnlyCheck = document.getElementById('msgAdminOnlyCheck');
  if (adminOnlyCheck) adminOnlyCheck.checked = channel === 'admins';
  _msgLoadInitial();
}

function _msgVisibilityHandler() {
  if (document.hidden) _msgStopPolling();
  else _msgStartPolling();
}

function _msgComposerHtml(viewer) {
  const scopeControl = viewer.role === 'super'
    ? `<select id="msgScopeSelect" class="msg-scope-select"><option value="">📢 Send to all blocks</option></select>`
    : `<span class="msg-scope-note">📍 Sending to your block only</span>`;
  return `
    <div class="msg-composer" id="msgComposer">
      <div class="msg-composer-row">
        ${scopeControl}
        <label class="msg-admin-only-toggle">
          <input type="checkbox" id="msgAdminOnlyCheck" /> 🔒 Admin team only
        </label>
      </div>
      <div id="msgAttachPreview" class="msg-attach-preview" style="display:none;"></div>
      <div class="msg-composer-row main">
        <button type="button" class="msg-attach-btn" id="msgImageBtn" title="Send a photo (camera or gallery)">📷</button>
        <button type="button" class="msg-attach-btn" id="msgPollBtn" title="Create a poll">📊</button>
        <button type="button" class="msg-attach-btn" id="msgContactBtn" title="Share a contact card">👤</button>
        <input type="text" id="msgTextInput" class="msg-text-input" placeholder="Type an announcement…" maxlength="2000" />
        <button type="button" class="msg-send-btn" id="msgSendBtn">Send</button>
      </div>
      <input type="file" id="msgImageInput" accept="image/*" capture="environment" style="display:none;" />
    </div>
  `;
}

async function _msgLoadBlockOptions(viewer) {
  if (viewer.role !== 'super') return;
  try {
    await loadBlockMeta();
    const sel = document.getElementById('msgScopeSelect');
    Object.entries(BLOCK_META).forEach(([code, b]) => {
      sel.insertAdjacentHTML('beforeend', `<option value="${code}">📍 ${escapeHtml(b.name)} only</option>`);
    });
  } catch (_) {}
}

function _msgWireComposer(viewer) {
  const textInput = document.getElementById('msgTextInput');
  const sendBtn = document.getElementById('msgSendBtn');
  const imageBtn = document.getElementById('msgImageBtn');
  const imageInput = document.getElementById('msgImageInput');
  const pollBtn = document.getElementById('msgPollBtn');
  const contactBtn = document.getElementById('msgContactBtn');

  sendBtn.addEventListener('click', () => _msgSendCurrent());
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _msgSendCurrent(); });

  imageBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files[0];
    imageInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image file', 'err'); return; }
    try {
      _msgStagedImage = await _msgResizeImage(file);
      _msgShowAttachPreview();
    } catch (e) { toast('Could not read that image', 'err'); }
  });

  // Ctrl+V an image copied from anywhere (a screenshot, another app, a
  // browser image) directly into the text box — same staging flow as
  // picking a file, just triggered by a paste instead of the 📷 button.
  textInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    const imageItem = Array.from(items).find((it) => it.type.startsWith('image/'));
    if (!imageItem) return; // ordinary text paste — let the browser handle it normally
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    try {
      _msgStagedImage = await _msgResizeImage(file);
      _msgShowAttachPreview();
      toast('Image pasted — add a caption and send', 'ok');
    } catch (err) { toast('Could not read that pasted image', 'err'); }
  });

  pollBtn.addEventListener('click', () => _msgOpenPollComposer());
  contactBtn.addEventListener('click', () => _msgOpenContactComposer());
}

// Resizes/compresses client-side before it ever reaches the server — keeps
// the database sane since images are stored as base64 rather than in a
// separate object-storage service (this app has none wired up yet).
function _msgResizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1000;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function _msgShowAttachPreview() {
  const holder = document.getElementById('msgAttachPreview');
  if (!_msgStagedImage) { holder.style.display = 'none'; holder.innerHTML = ''; return; }
  holder.style.display = 'flex';
  holder.innerHTML = `
    <img src="${_msgStagedImage}" />
    <span>Photo attached</span>
    <button type="button" onclick="_msgStagedImage=null; _msgShowAttachPreview();">✕</button>
  `;
}

async function _msgSendCurrent() {
  if (_msgSending) return; // already sending — ignore any extra click/Enter until this one finishes
  const textInput = document.getElementById('msgTextInput');
  const sendBtn = document.getElementById('msgSendBtn');
  const body = textInput.value.trim();
  if (!body && !_msgStagedImage) return;

  const scopeSel = document.getElementById('msgScopeSelect');
  const scopeBlock = scopeSel ? scopeSel.value || null : null;
  const adminOnlyCheck = document.getElementById('msgAdminOnlyCheck');
  const adminOnly = adminOnlyCheck ? adminOnlyCheck.checked : false;

  _msgSending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  try {
    if (_msgStagedImage) {
      await api('/messages', { method: 'POST', body: { type: 'image', imageData: _msgStagedImage, body, scopeBlock, adminOnly } });
      _msgStagedImage = null;
      _msgShowAttachPreview();
    } else {
      await api('/messages', { method: 'POST', body: { type: 'text', body, scopeBlock, adminOnly } });
    }
    textInput.value = '';
    await _msgLoadInitial(true); // jump straight to latest, including what we just sent
  } catch (e) { toast(e.message, 'err'); }
  finally {
    _msgSending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
}

// ---------------- Poll composer (built dynamically — no HTML edits needed) ----------------
function _msgOpenPollComposer() {
  _msgPollDraftOptions = ['', ''];
  _msgPollOptionsTargetId = 'msgPollOptionsList';
  _msgEnsureModal('msgPollModal', () => `
    <div class="modal">
      <h3>Create a poll</h3>
      <div class="field"><label>Question</label><input id="msgPollQuestion" placeholder="e.g. Water supply timing preference?" /></div>
      <div id="msgPollOptionsList"></div>
      <button type="button" class="icon-btn" onclick="_msgAddPollOption()" style="margin:8px 0 16px;">+ Add option</button>
      <div class="modal-foot">
        <button type="button" class="btn ghost" onclick="_msgCloseModal('msgPollModal')">Cancel</button>
        <button type="button" class="btn gold" onclick="_msgSubmitPoll()">Post poll</button>
      </div>
    </div>
  `);
  _msgRenderPollOptions();
  document.getElementById('msgPollModal').classList.add('show');
}
function _msgRenderPollOptions() {
  const list = document.getElementById(_msgPollOptionsTargetId);
  if (!list) return;
  list.innerHTML = _msgPollDraftOptions.map((val, i) => `
    <div class="field" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
      <input value="${escapeHtml(val)}" placeholder="Option ${i + 1}" oninput="_msgPollDraftOptions[${i}] = this.value" style="flex:1;" />
      ${_msgPollDraftOptions.length > 2 ? `<button type="button" class="icon-btn danger" onclick="_msgRemovePollOption(${i})">✕</button>` : ''}
    </div>
  `).join('');
}
window._msgAddPollOption = function () {
  if (_msgPollDraftOptions.length >= 8) { toast('Maximum 8 options', 'err'); return; }
  _msgPollDraftOptions.push('');
  _msgRenderPollOptions();
};
window._msgRemovePollOption = function (i) {
  _msgPollDraftOptions.splice(i, 1);
  _msgRenderPollOptions();
};
window._msgSubmitPoll = async function () {
  if (_msgSending) return;
  const question = document.getElementById('msgPollQuestion').value.trim();
  const options = _msgPollDraftOptions.map((o) => o.trim()).filter(Boolean);
  if (!question) { toast('Enter a question', 'err'); return; }
  if (options.length < 2) { toast('Enter at least 2 options', 'err'); return; }
  const scopeSel = document.getElementById('msgScopeSelect');
  const scopeBlock = scopeSel ? scopeSel.value || null : null;
  const adminOnlyCheck = document.getElementById('msgAdminOnlyCheck');
  const adminOnly = adminOnlyCheck ? adminOnlyCheck.checked : false;
  _msgSending = true;
  try {
    await api('/messages', { method: 'POST', body: { type: 'poll', pollQuestion: question, pollOptions: options, scopeBlock, adminOnly } });
    _msgCloseModal('msgPollModal');
    await _msgLoadInitial(true);
  } catch (e) { toast(e.message, 'err'); }
  finally { _msgSending = false; }
};

// ---------------- Contact card composer ----------------
function _msgOpenContactComposer() {
  _msgEnsureModal('msgContactModal', () => `
    <div class="modal">
      <h3>Share a contact</h3>
      <div class="field"><label>Name</label><input id="msgContactName" placeholder="e.g. Plumber - Ramesh" /></div>
      <div class="field"><label>Phone number</label><input id="msgContactPhone" class="mono" maxlength="10" placeholder="10-digit number" /></div>
      <div class="modal-foot">
        <button type="button" class="btn ghost" onclick="_msgCloseModal('msgContactModal')">Cancel</button>
        <button type="button" class="btn gold" onclick="_msgSubmitContact()">Post contact</button>
      </div>
    </div>
  `);
  document.getElementById('msgContactModal').classList.add('show');
}
window._msgSubmitContact = async function () {
  if (_msgSending) return;
  const contactName = document.getElementById('msgContactName').value.trim();
  const contactPhone = document.getElementById('msgContactPhone').value.trim();
  if (!contactName || !/^\d{10}$/.test(contactPhone)) { toast('Enter a name and a valid 10-digit number', 'err'); return; }
  const scopeSel = document.getElementById('msgScopeSelect');
  const scopeBlock = scopeSel ? scopeSel.value || null : null;
  const adminOnlyCheck = document.getElementById('msgAdminOnlyCheck');
  const adminOnly = adminOnlyCheck ? adminOnlyCheck.checked : false;
  _msgSending = true;
  try {
    await api('/messages', { method: 'POST', body: { type: 'contact', contactName, contactPhone, scopeBlock, adminOnly } });
    _msgCloseModal('msgContactModal');
    await _msgLoadInitial(true);
  } catch (e) { toast(e.message, 'err'); }
  finally { _msgSending = false; }
};

function _msgEnsureModal(id, htmlFn) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'modal-backdrop';
    document.body.appendChild(el);
  }
  el.innerHTML = htmlFn();
}
window._msgCloseModal = function (id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
};

// ---------------- Feed loading, rendering, polling ----------------
async function _msgLoadInitial(scrollToBottom = true) {
  if (_msgFetching) return; // a poll cycle is already mid-flight — let it finish rather than racing it
  _msgFetching = true;
  try {
    const data = await api('/messages?limit=50&channel=' + encodeURIComponent(_msgCurrentChannel));
    const feed = document.getElementById('msgFeed');
    if (!feed) return;
    _msgRenderedIds = new Set(data.messages.map((m) => m.id));
    _msgMessagesById = new Map(data.messages.map((m) => [m.id, m]));
    feed.innerHTML = data.messages.length
      ? data.messages.map(_msgBubbleHtml).join('')
      : `<div class="msg-empty">No messages in this channel yet.</div>`;
    if (data.messages.length) _msgLastTimestamp = data.messages[data.messages.length - 1].createdAt;
    if (scrollToBottom) feed.scrollTop = feed.scrollHeight;
  } catch (e) { /* silent — polling will retry */ }
  finally { _msgFetching = false; }
}

async function _msgPollForNew() {
  if (_msgFetching) return; // an initial/full load is already mid-flight — skip this tick, next one will catch up
  if (!_msgLastTimestamp) return _msgLoadInitial();
  _msgFetching = true;
  try {
    const data = await api('/messages?after=' + encodeURIComponent(_msgLastTimestamp) + '&limit=50&channel=' + encodeURIComponent(_msgCurrentChannel));
    // Belt-and-suspenders: even if something upstream ever double-fetches,
    // a message whose id we've already rendered is silently skipped here
    // rather than appearing twice in the feed.
    const genuinelyNew = data.messages.filter((m) => !_msgRenderedIds.has(m.id));
    if (!genuinelyNew.length) {
      if (data.messages.length) _msgLastTimestamp = data.messages[data.messages.length - 1].createdAt;
      return;
    }
    const feed = document.getElementById('msgFeed');
    if (!feed) return;
    const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    const emptyNote = feed.querySelector('.msg-empty');
    if (emptyNote) emptyNote.remove();
    genuinelyNew.forEach((m) => { _msgRenderedIds.add(m.id); _msgMessagesById.set(m.id, m); });
    feed.insertAdjacentHTML('beforeend', genuinelyNew.map(_msgBubbleHtml).join(''));
    _msgLastTimestamp = data.messages[data.messages.length - 1].createdAt;
    if (wasNearBottom) feed.scrollTop = feed.scrollHeight;
  } catch (e) { /* silent */ }
  finally { _msgFetching = false; }
}

function _msgStartPolling() {
  _msgStopPolling();
  _msgPollTimer = setInterval(_msgPollForNew, 6000);
}
function _msgStopPolling() {
  if (_msgPollTimer) clearInterval(_msgPollTimer);
  _msgPollTimer = null;
}

function _msgTimeLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function _msgBubbleHtml(m) {
  const viewer = _msgViewer();
  const isMine = viewer.type === 'admin' && m.senderId === viewer.id;
  const canEditDelete = viewer.type === 'admin' && (viewer.role === 'super' || isMine);
  const scopeLabel = m.scopeBlock ? (BLOCK_META[m.scopeBlock]?.name || `Block ${m.scopeBlock}`) : null;
  const senderLabel = `${escapeHtml(m.senderName)}${m.senderRole === 'super' ? ' · Super Admin' : ''}`;
  const editedTag = m.editedAt ? ' <span class="msg-edited-tag">(edited)</span>' : '';

  let contentHtml = '';
  if (m.type === 'text') {
    contentHtml = `<div class="msg-text">${escapeHtml(m.body)}${editedTag}</div>`;
  } else if (m.type === 'image') {
    contentHtml = `
      <img class="msg-image" src="${m.imageData}" onclick="_msgOpenLightbox('${m.id}')" />
      ${m.body ? `<div class="msg-text" style="margin-top:6px;">${escapeHtml(m.body)}${editedTag}</div>` : ''}
    `;
  } else if (m.type === 'contact') {
    const vcf = `data:text/vcard;charset=utf-8,BEGIN:VCARD%0AVERSION:3.0%0AFN:${encodeURIComponent(m.contactName)}%0ATEL:${m.contactPhone}%0AEND:VCARD`;
    contentHtml = `
      <div class="msg-contact-card">
        <div class="avatar">👤</div>
        <div class="details"><div class="name">${escapeHtml(m.contactName)}${editedTag}</div><div class="phone mono">${m.contactPhone}</div></div>
        <div class="actions">
          <a href="tel:${m.contactPhone}" class="icon-btn">Call</a>
          <a href="${vcf}" download="${escapeHtml(m.contactName)}.vcf" class="icon-btn">Save</a>
        </div>
      </div>`;
  } else if (m.type === 'poll') {
    const total = m.pollTotalVotes || 0;
    contentHtml = `
      <div class="msg-poll">
        <div class="poll-question">📊 ${escapeHtml(m.pollQuestion)}${editedTag}</div>
        ${m.pollOptions.map((opt, i) => {
          const count = m.pollTally?.[i] || 0;
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const selected = m.myVote === i;
          return `
            <div class="poll-option ${selected ? 'selected' : ''}" onclick="_msgVote('${m.id}', ${i})">
              <div class="poll-fill" style="width:${pct}%;"></div>
              <span class="poll-label">${selected ? '✓ ' : ''}${escapeHtml(opt)}</span>
              <span class="poll-pct">${pct}% (${count})</span>
            </div>`;
        }).join('')}
        <div class="poll-total">${total} vote${total === 1 ? '' : 's'}</div>
      </div>`;
  }

  const menuId = 'msgMenu_' + m.id;
  const actions = [];
  actions.push(`<button onclick="_msgCopy('${m.id}')">📋 Copy</button>`);
  if (viewer.type === 'admin') actions.push(`<button onclick="_msgOpenForward('${m.id}')">➡️ Forward</button>`);
  actions.push(`<button onclick="_msgOpenInfo('${m.id}')">ℹ️ Info</button>`);
  if (canEditDelete) actions.push(`<button onclick="_msgOpenEdit('${m.id}')">✏️ Edit</button>`);
  if (canEditDelete) actions.push(`<button class="danger" onclick="_msgDelete('${m.id}')">🗑️ Delete</button>`);

  return `
    <div class="msg-bubble-row ${isMine ? 'mine' : ''}">
      <div class="msg-bubble">
        <div class="msg-meta">
          <span class="msg-sender">${senderLabel}</span>
          ${m.adminOnly ? `<span class="msg-scope-badge admin-only">🔒 Admin team</span>` : scopeLabel ? `<span class="msg-scope-badge">${escapeHtml(scopeLabel)}</span>` : `<span class="msg-scope-badge all">All blocks</span>`}
        </div>
        ${contentHtml}
        <div class="msg-time-row">
          <span class="msg-time">${_msgTimeLabel(m.createdAt)}</span>
          <div class="msg-actions-wrap">
            <button class="msg-actions-btn" onclick="_msgToggleMenu('${m.id}')">⋮</button>
            <div class="msg-actions-menu" id="${menuId}">${actions.join('')}</div>
          </div>
        </div>
      </div>
    </div>`;
}

window._msgToggleMenu = function (id) {
  const menu = document.getElementById('msgMenu_' + id);
  const wasOpen = menu.classList.contains('show');
  document.querySelectorAll('.msg-actions-menu.show').forEach((el) => el.classList.remove('show'));
  if (!wasOpen) menu.classList.add('show');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('.msg-actions-wrap')) {
    document.querySelectorAll('.msg-actions-menu.show').forEach((el) => el.classList.remove('show'));
  }
});

window._msgCopy = function (id) {
  const m = _msgMessagesById.get(id);
  if (!m) return;
  let text = '';
  if (m.type === 'text' || m.type === 'image') text = m.body || '';
  else if (m.type === 'poll') text = m.pollQuestion + '\n' + m.pollOptions.map((o, i) => `- ${o}`).join('\n');
  else if (m.type === 'contact') text = `${m.contactName}: ${m.contactPhone}`;
  if (!text) { toast('Nothing to copy', 'err'); return; }
  navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok')).catch(() => toast('Could not copy', 'err'));
};

// ---------------- Forward ----------------
window._msgOpenForward = function (id) {
  const m = _msgMessagesById.get(id);
  if (!m) return;
  const viewer = _msgViewer();
  const blockOptions = Object.entries(BLOCK_META).map(([code, b]) => `<option value="${code}">📍 ${escapeHtml(b.name)} only</option>`).join('');
  _msgEnsureModal('msgForwardModal', () => `
    <div class="modal">
      <h3>Forward message</h3>
      <div class="field">
        <label>Send to</label>
        <select id="msgForwardScope">
          ${viewer.role === 'super' ? `<option value="">📢 All blocks</option>${blockOptions}` : `<option value="${viewer.blockCode}">📍 Your block only</option>`}
        </select>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn ghost" onclick="_msgCloseModal('msgForwardModal')">Cancel</button>
        <button type="button" class="btn gold" onclick="_msgSubmitForward('${id}')">Forward</button>
      </div>
    </div>
  `);
  document.getElementById('msgForwardModal').classList.add('show');
};
window._msgSubmitForward = async function (id) {
  if (_msgSending) return;
  const m = _msgMessagesById.get(id);
  if (!m) return;
  const scopeBlock = document.getElementById('msgForwardScope').value || null;
  const body = { type: m.type, scopeBlock };
  if (m.type === 'text' || m.type === 'image') body.body = m.body;
  if (m.type === 'image') body.imageData = m.imageData;
  if (m.type === 'poll') { body.pollQuestion = m.pollQuestion; body.pollOptions = m.pollOptions; }
  if (m.type === 'contact') { body.contactName = m.contactName; body.contactPhone = m.contactPhone; }
  _msgSending = true;
  try {
    await api('/messages', { method: 'POST', body });
    _msgCloseModal('msgForwardModal');
    toast('Forwarded', 'ok');
    await _msgLoadInitial(true);
  } catch (e) { toast(e.message, 'err'); }
  finally { _msgSending = false; }
};

// ---------------- Edit ----------------
window._msgOpenEdit = function (id) {
  const m = _msgMessagesById.get(id);
  if (!m) return;
  let fieldsHtml = '';
  if (m.type === 'text' || m.type === 'image') {
    fieldsHtml = `<div class="field"><label>${m.type === 'image' ? 'Caption' : 'Message'}</label><textarea id="msgEditBody" rows="3">${escapeHtml(m.body)}</textarea></div>`;
  } else if (m.type === 'poll') {
    fieldsHtml = `
      <div class="field"><label>Question</label><input id="msgEditPollQuestion" value="${escapeHtml(m.pollQuestion)}" /></div>
      <div id="msgEditPollOptionsList"></div>
      <button type="button" class="icon-btn" onclick="_msgAddPollOption()" style="margin:8px 0 16px;">+ Add option</button>`;
  } else if (m.type === 'contact') {
    fieldsHtml = `
      <div class="field"><label>Name</label><input id="msgEditContactName" value="${escapeHtml(m.contactName)}" /></div>
      <div class="field"><label>Phone</label><input id="msgEditContactPhone" class="mono" maxlength="10" value="${escapeHtml(m.contactPhone)}" /></div>`;
  }
  _msgEnsureModal('msgEditModal', () => `
    <div class="modal">
      <h3>Edit message</h3>
      ${fieldsHtml}
      <div class="modal-foot">
        <button type="button" class="btn ghost" onclick="_msgCloseModal('msgEditModal')">Cancel</button>
        <button type="button" class="btn gold" onclick="_msgSubmitEdit('${id}')">Save</button>
      </div>
    </div>
  `);
  if (m.type === 'poll') {
    _msgPollDraftOptions = [...m.pollOptions];
    _msgPollOptionsTargetId = 'msgEditPollOptionsList';
    _msgRenderPollOptions();
  }
  document.getElementById('msgEditModal').classList.add('show');
};
window._msgSubmitEdit = async function (id) {
  if (_msgSending) return;
  const m = _msgMessagesById.get(id);
  if (!m) return;
  const body = {};
  if (m.type === 'text' || m.type === 'image') {
    body.body = document.getElementById('msgEditBody').value.trim();
    if (m.type === 'text' && !body.body) { toast('Message text cannot be empty', 'err'); return; }
  } else if (m.type === 'poll') {
    body.pollQuestion = document.getElementById('msgEditPollQuestion').value.trim();
    body.pollOptions = _msgPollDraftOptions.map((o) => o.trim()).filter(Boolean);
    if (body.pollOptions.length < 2) { toast('Enter at least 2 options', 'err'); return; }
  } else if (m.type === 'contact') {
    body.contactName = document.getElementById('msgEditContactName').value.trim();
    body.contactPhone = document.getElementById('msgEditContactPhone').value.trim();
    if (!/^\d{10}$/.test(body.contactPhone)) { toast('Enter a valid 10-digit number', 'err'); return; }
  }
  _msgSending = true;
  try {
    await api(`/messages/${id}`, { method: 'PUT', body });
    _msgCloseModal('msgEditModal');
    toast('Message updated', 'ok');
    await _msgLoadInitial(false);
  } catch (e) { toast(e.message, 'err'); }
  finally { _msgSending = false; }
};

// ---------------- Info ----------------
window._msgOpenInfo = async function (id) {
  const m = _msgMessagesById.get(id);
  if (!m) return;
  const scopeText = m.adminOnly ? '🔒 Admin team only' : (m.scopeBlock ? (BLOCK_META[m.scopeBlock]?.name || m.scopeBlock) + ' only' : 'All blocks');
  let extra = '';
  if (m.type === 'poll') {
    extra = `<div class="skeleton" style="height:60px;"></div>`;
  }
  _msgEnsureModal('msgInfoModal', () => `
    <div class="modal">
      <h3>Message info</h3>
      <div class="field"><label>From</label><div>${escapeHtml(m.senderName)}${m.senderRole === 'super' ? ' · Super Admin' : ''}</div></div>
      <div class="field"><label>Sent to</label><div>${escapeHtml(scopeText)}</div></div>
      <div class="field"><label>Sent</label><div>${new Date(m.createdAt).toLocaleString('en-IN')}</div></div>
      ${m.editedAt ? `<div class="field"><label>Edited</label><div>${new Date(m.editedAt).toLocaleString('en-IN')}</div></div>` : ''}
      <div id="msgInfoExtra">${extra}</div>
      <div class="modal-foot">
        <button type="button" class="btn ghost" onclick="_msgCloseModal('msgInfoModal')">Close</button>
      </div>
    </div>
  `);
  document.getElementById('msgInfoModal').classList.add('show');
  if (m.type === 'poll') {
    try {
      const data = await api(`/messages/${id}/votes`);
      const holder = document.getElementById('msgInfoExtra');
      if (!holder) return; // modal closed before this resolved
      if (!data.voters.length) { holder.innerHTML = `<div class="field"><label>Votes</label><div>No votes yet.</div></div>`; return; }
      holder.innerHTML = `<div class="field"><label>Votes (${data.voters.length})</label>${data.voters.map((v) =>
        `<div class="msg-info-voter">${escapeHtml(v.name)} — <b>${escapeHtml(m.pollOptions[v.optionIndex] || '?')}</b></div>`
      ).join('')}</div>`;
    } catch (e) { const holder = document.getElementById('msgInfoExtra'); if (holder) holder.innerHTML = ''; }
  }
};

window._msgVote = async function (messageId, optionIndex) {
  try {
    await api(`/messages/${messageId}/vote`, { method: 'POST', body: { optionIndex } });
    await _msgLoadInitial(false);
  } catch (e) { toast(e.message, 'err'); }
};

window._msgDelete = async function (id) {
  if (!confirm('Delete this message for everyone?')) return;
  try {
    await api(`/messages/${id}`, { method: 'DELETE' });
    await _msgLoadInitial(false);
  } catch (e) { toast(e.message, 'err'); }
};

window._msgOpenLightbox = function (messageId) {
  const feed = document.getElementById('msgFeed');
  const img = feed.querySelector(`img.msg-image[onclick*="${messageId}"]`);
  if (!img) return;
  _msgEnsureModal('msgLightbox', () => `<div class="msg-lightbox-inner"><img src="${img.src}" /></div>`);
  const el = document.getElementById('msgLightbox');
  el.classList.add('show');
  el.onclick = () => el.classList.remove('show');
};
