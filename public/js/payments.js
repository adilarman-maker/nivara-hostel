async function loadPayments() {
  await loadBlockMeta();
  const filterSel = document.getElementById('paymentsBlockFilter');
  const settingsPanel = document.getElementById('paymentSettingsPanel');
  const subtitle = document.getElementById('paymentsSubtitle');

  if (me.role === 'super') {
    subtitle.textContent = 'Dues and collections across all blocks — filter by block if you like.';
    settingsPanel.style.display = 'block';
    document.getElementById('scannersPanel').style.display = 'block';
    if (filterSel.options.length === 0) {
      filterSel.style.display = 'inline-block';
      filterSel.innerHTML = `<option value="">All blocks</option>` +
        Object.entries(BLOCK_META).map(([code, b]) => `<option value="${code}">${escapeHtml(b.name)}</option>`).join('');
      // Changing the filter re-fetches individually (it's a targeted,
      // infrequent action) — the shared endpoint below is for the common
      // case of just opening the tab.
      filterSel.addEventListener('change', () => { loadDues(); loadMonthlyChart(); loadOccupancyChart(); });
    }
    loadPaymentConfig(); // always forces a fresh fetch — see its own comment
  } else {
    const blockName = BLOCK_META[me.blockCode]?.name || 'your block';
    subtitle.textContent = `Dues and collections for ${blockName} only.`;
  }

  // Everything else the tab needs, in ONE request — see the comment on
  // GET /payments/dashboard for why this is the fix that actually matters
  // for load time, not a minor tidy-up.
  try {
    const data = await api('/payments/dashboard');
    loadDues(data.dues);
    loadMonthlyChart(data.monthly);
    loadOccupancyChart(data.occupancy);
    loadPendingProofs(data.proofs);
    if (me.role === 'super' && data.scanners) loadScanners(data.scanners);
  } catch (e) { toast(e.message, 'err'); }
}

// Lighter refresh used by the polling timer — one request instead of four,
// and skips re-fetching settings/scanners (which don't change from someone
// confirming a payment) so an open "edit scanner" field etc. isn't
// disturbed every 8 seconds.
async function refreshPaymentsData() {
  try {
    const data = await api('/payments/dashboard');
    loadDues(data.dues);
    loadMonthlyChart(data.monthly);
    loadOccupancyChart(data.occupancy);
    loadPendingProofs(data.proofs);
  } catch (e) { /* silent — this is a background poll, not a user action */ }
}

let _monthlyRentChart = null;
async function loadMonthlyChart(preloaded) {
  try {
    if (typeof Chart === 'undefined') {
      const canvas = document.getElementById('monthlyRentChart');
      if (canvas) {
        canvas.parentElement.innerHTML = `<p style="font-size:0.85rem; color:#8a9690; padding:20px 0;">Chart couldn't load (this can happen if a browser extension or network blocks the charting library) — the numbers above are still accurate.</p>`;
      }
      return;
    }
    const filterSel = document.getElementById('paymentsBlockFilter');
    const block = me.role === 'super' ? filterSel.value : '';
    const data = preloaded || await api('/payments/monthly-summary' + (block ? `?block=${block}` : ''));

    const labels = data.months.map((m) => {
      const [y, mo] = m.period.split('-');
      return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    });
    const dueData = data.months.map((m) => m.due - m.collected > 0 ? m.due - m.collected : 0);
    const collectedData = data.months.map((m) => m.collected);

    // "This month" stat card — the last entry is always the current month
    // (see db/database.js: getMonthlyRentSummary / currentPeriod).
    const thisMonth = data.months[data.months.length - 1];
    const thisMonthPercent = thisMonth.due > 0 ? Math.round((thisMonth.collected / thisMonth.due) * 100) : 0;
    const thisMonthRemaining = Math.max(0, thisMonth.due - thisMonth.collected);
    document.getElementById('statMonthPercent').textContent = thisMonthPercent + '%';
    document.getElementById('statMonthRemaining').textContent = '₹' + thisMonthRemaining.toLocaleString('en-IN');

    // If every month in the window has zero due AND zero collected, there's
    // no recurring rent data yet (e.g. tenants have only paid their one-time
    // advance so far, or it's before the 6th of the month — see
    // db/database.js: getDuesOverview — so no rent-due rows exist yet).
    // Rendering the chart anyway produces a confusing flat ₹0–₹1 axis with
    // no visible bars, which looks broken even though it's technically
    // correct. Show a clear empty state instead.
    const hasAnyData = data.months.some((m) => m.due > 0 || m.collected > 0);
    const chartWrap = document.getElementById('monthlyRentChart').parentElement;
    if (!hasAnyData) {
      if (_monthlyRentChart) { _monthlyRentChart.destroy(); _monthlyRentChart = null; }
      chartWrap.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; text-align:center; color:#8a9690;">
          <div style="font-size:1.6rem; margin-bottom:6px;">📊</div>
          <div style="font-weight:600; color:#2c3a30;">No rent collection data yet</div>
          <div style="font-size:0.82rem; max-width:320px; margin-top:4px;">
            Recurring rent dues are created automatically from the 6th of each month, for tenants
            with a monthly rent amount set. Nothing to chart until then — the advance payments
            you've already collected aren't included here on purpose (see the note above).
          </div>
        </div>`;
      return;
    }
    // Restore the canvas in case a previous call replaced it with the empty state above.
    if (!document.getElementById('monthlyRentChart')) {
      chartWrap.innerHTML = '<canvas id="monthlyRentChart"></canvas>';
    }

    const ctx = document.getElementById('monthlyRentChart').getContext('2d');
    if (_monthlyRentChart) _monthlyRentChart.destroy();
    _monthlyRentChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Collected', data: collectedData, backgroundColor: '#3B6B4A', borderRadius: 4 },
          { label: 'Still due', data: dueData, backgroundColor: '#C9A227', borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => '₹' + v.toLocaleString('en-IN') } },
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ₹${ctx.parsed.y.toLocaleString('en-IN')}` } },
        },
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}

let _occupancyChart = null;
async function loadOccupancyChart(preloadedOcc) {
  try {
    const filterSel = document.getElementById('paymentsBlockFilter');
    const block = me.role === 'super' ? filterSel.value : '';
    // Reuses /admin/dashboard's occupancy calc when nothing is preloaded —
    // no need for a separate endpoint just for this chart.
    const occ = preloadedOcc || (await api('/admin/summary' + (block ? `?block=${block}` : ''))).occupancy;

    document.getElementById('statOccupiedPercent').textContent = occ.percentOccupied + '%';
    document.getElementById('statOccupiedBeds').textContent = occ.occupiedBeds;
    document.getElementById('statVacantBeds').textContent = occ.vacantBeds;
    document.getElementById('statTotalBeds').textContent = occ.totalBeds;
    const bookedEl = document.getElementById('statBookedBeds');
    if (bookedEl) bookedEl.textContent = occ.bookedBeds;

    if (typeof Chart === 'undefined') {
      const canvas = document.getElementById('occupancyChart');
      if (canvas) canvas.parentElement.innerHTML = `<p style="font-size:0.85rem; color:#8a9690; padding:20px 0; text-align:center;">Chart couldn't load — the numbers above are still accurate.</p>`;
      return;
    }

    // No rooms created yet in this scope — a 0/0 doughnut is meaningless
    // (and Chart.js would just draw an empty ring). Show a clear next step.
    // chartWrap is captured before any replacement so a later call (once
    // rooms exist) can correctly put the <canvas> back.
    const chartWrap = document.getElementById('occupancyChart').parentElement;
    if (occ.totalBeds === 0) {
      if (_occupancyChart) { _occupancyChart.destroy(); _occupancyChart = null; }
      chartWrap.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; text-align:center; color:#8a9690;">
          <div style="font-size:1.6rem; margin-bottom:6px;">🛏️</div>
          <div style="font-weight:600; color:#2c3a30;">No rooms set up yet</div>
          <div style="font-size:0.82rem; max-width:260px; margin-top:4px;">Create rooms from the Blocks &amp; Rooms screen to see occupancy here.</div>
        </div>`;
      return;
    }
    if (!document.getElementById('occupancyChart')) {
      chartWrap.innerHTML = '<canvas id="occupancyChart"></canvas>';
    }

    const ctx = document.getElementById('occupancyChart').getContext('2d');
    if (_occupancyChart) _occupancyChart.destroy();
    _occupancyChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [`Occupied (${occ.occupiedBeds})`, `Booked (${occ.bookedBeds})`, `Vacant (${occ.vacantBeds})`],
        datasets: [{ data: [occ.occupiedBeds, occ.bookedBeds, occ.vacantBeds], backgroundColor: ['#3B6B4A', '#C9A227', '#E4CE83'], borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}

// "Which month does this tenant actually owe?" — the due list already has
// a Period column, but this makes it unmissable with one click, and hands
// off to the full Tenant History modal (admin.js) for everything else.
window.showDueMonthDetail = function (tenantId, tenantName, period, remaining) {
  const monthLabel = new Date(period + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  toast(`${tenantName}: payment pending for ${monthLabel} (₹${Number(remaining).toLocaleString('en-IN')})`, 'err');
  if (typeof openTenantHistory === 'function') openTenantHistory(tenantId);
};

async function loadDues(preloaded) {
  try {
    const filterSel = document.getElementById('paymentsBlockFilter');
    const block = me.role === 'super' ? filterSel.value : '';
    const data = preloaded || await api('/payments/dues' + (block ? `?block=${block}` : ''));

    document.getElementById('statTotalDue').textContent = '₹' + data.totalDue.toLocaleString('en-IN');
    document.getElementById('statTotalCollected').textContent = '₹' + data.totalCollected.toLocaleString('en-IN');
    document.getElementById('statDueCount').textContent = data.dueCount;
    document.getElementById('statPercentDue').textContent = data.percentDue;
    document.getElementById('statPercentCollected').textContent = data.percentCollected;
    document.getElementById('statMonthAdvance').textContent = '₹' + data.collectedThisMonth.advance.toLocaleString('en-IN');
    document.getElementById('statMonthRent').textContent = '₹' + data.collectedThisMonth.rent.toLocaleString('en-IN');
    document.getElementById('statMonthGrandTotal').textContent = '₹' + data.collectedThisMonth.total.toLocaleString('en-IN');

    const tbody = document.getElementById('duesRows');
    document.getElementById('duesEmpty').style.display = data.dueList.length ? 'none' : 'block';
    tbody.innerHTML = data.dueList.map((d) => {
      const parsed = parseUidClient(d.tenantUid);
      const remainingText = d.status === 'partial'
        ? `<div style="font-size:0.74rem; color:#8A5A00;">₹${d.amountPaid.toLocaleString('en-IN')} paid — ₹${d.remaining.toLocaleString('en-IN')} left</div>`
        : '';
      return `
      <tr class="row-hover">
        <td><b style="cursor:pointer; text-decoration:underline dotted;" title="Click for this tenant's full payment history" onclick="showDueMonthDetail('${d.tenantId}','${escapeHtml(d.tenantName)}','${d.period}',${d.remaining})">${escapeHtml(d.tenantName)}</b><div style="font-size:0.76rem;color:#8a9690;">${d.tenantPhone}</div></td>
        <td class="mono">${d.tenantUid}</td>
        <td>${blockBadge(parsed.block)}</td>
        <td>${d.period}</td>
        <td><b>₹${Number(d.remaining).toLocaleString('en-IN')}</b>${remainingText}</td>
        <td>
          ${(me.role === 'super' || String(parsed.block) === String(me.blockCode)) ? `
          <div class="row-actions">
            <button class="icon-btn" onclick="openCashPaymentModal('${d.id}','${escapeHtml(d.tenantName)}',${d.remaining})">Record cash</button>
            <button class="icon-btn" onclick="markPaid('${d.id}')">Mark fully paid</button>
          </div>` : `<span style="color:#8a9690; font-size:0.78rem;">View only</span>`}
        </td>
      </tr>`;
    }).join('');
  } catch (e) { toast(e.message, 'err'); }
}

window.openCashPaymentModal = function (paymentId, tenantName, remaining) {
  // For when an admin personally collected cash, or money arrived directly
  // in the org's own account through some channel other than the tenant
  // submitting proof through the app — the admin is vouching that money
  // actually arrived, no screenshot needed since they saw it happen.
  const methodChoice = prompt(
    `How did ${tenantName} pay?\n\nType one of: cash / upi / bank / other`,
    'cash'
  );
  if (methodChoice === null) return;
  const methodKey = { cash: 'cash', upi: 'upi', bank: 'bank_transfer' }[methodChoice.trim().toLowerCase()] || 'other';

  const amount = prompt(`How much did ${tenantName} pay? (up to ₹${remaining.toLocaleString('en-IN')} remaining)`, remaining);
  if (amount === null) return;
  const num = Number(amount);
  if (isNaN(num) || num <= 0) { toast('Enter a valid amount', 'err'); return; }
  recordCashPayment(paymentId, num, methodKey);
};

async function recordCashPayment(paymentId, amount, method = 'cash') {
  try {
    const result = await api(`/payments/${paymentId}/cash`, { method: 'POST', body: { amount, method } });
    toast(result.payment.status === 'paid' ? 'Marked as fully paid' : `Recorded — ₹${result.payment.remaining.toLocaleString('en-IN')} still remaining`, 'ok');
    loadDues();
  } catch (e) { toast(e.message, 'err'); }
}

window.markPaid = async function (paymentId) {
  if (!confirm('Mark this payment as received (e.g. cash handed over in person)?')) return;
  try {
    await api(`/payments/${paymentId}/mark-paid`, { method: 'POST' });
    toast('Payment marked as paid', 'ok');
    loadDues();
  } catch (e) { toast(e.message, 'err'); }
};

async function loadPaymentConfig() {
  try {
    const c = await getPaymentConfigCached(true); // settings screen always shows the true current server state
    document.getElementById('cfgAdvance').value = c.advanceAmount || '';
    const tiers = c.rentByBedCount || {};
    document.getElementById('cfgRent1').value = tiers[1] || '';
    document.getElementById('cfgRent2').value = tiers[2] || '';
    document.getElementById('cfgRent3').value = tiers[3] || '';
    document.getElementById('cfgRent4').value = tiers[4] || '';
    document.getElementById('cfgRent5').value = tiers[5] || '';
  } catch (e) { toast(e.message, 'err'); }
}

const paymentConfigForm = document.getElementById('paymentConfigForm');
if (paymentConfigForm) {
  paymentConfigForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/payments/config', {
        method: 'PUT',
        body: {
          advanceAmount: document.getElementById('cfgAdvance').value,
          rentByBedCount: {
            1: document.getElementById('cfgRent1').value,
            2: document.getElementById('cfgRent2').value,
            3: document.getElementById('cfgRent3').value,
            4: document.getElementById('cfgRent4').value,
            5: document.getElementById('cfgRent5').value,
          },
        },
      });
      invalidatePaymentConfigCache(); // so the next Add Tenant modal picks up the new defaults
      toast('Payment settings saved', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---------- payment scanners (Super Admin manages) ----------

let _scanners = [];
let _scannerImageData = null;

async function loadScanners(preloaded) {
  try {
    _scanners = preloaded || (await api('/payments/scanners')).scanners;
    renderScanners();
  } catch (e) { toast(e.message, 'err'); }
}

function renderScanners() {
  const list = document.getElementById('scannersList');
  if (_scanners.length === 0) {
    list.innerHTML = `<p style="font-size:0.85rem; color:#8a9690;">No scanners set up yet — tenants won't see a way to pay until you add at least one.</p>`;
    return;
  }
  list.innerHTML = _scanners.map((s) => {
    const scopeLabel = s.scopeBlock ? (BLOCK_META[s.scopeBlock]?.name || `Block ${s.scopeBlock}`) : 'Whole hostel';
    return `
    <div class="row-hover" style="display:flex; align-items:center; gap:14px; padding:12px 0; border-bottom:1px solid var(--line);">
      ${s.qrImage ? `<img src="${s.qrImage}" style="width:52px; height:52px; object-fit:cover; border-radius:8px;" />` : `<div style="width:52px; height:52px; border-radius:8px; background:var(--sand-dim); display:flex; align-items:center; justify-content:center; font-size:1.2rem;">📷</div>`}
      <div style="flex:1;">
        <div style="font-weight:600;">${escapeHtml(s.accountName)} <span class="tag" style="margin-left:6px;">${scopeLabel}</span></div>
        <div style="font-size:0.8rem; color:#8a9690;">${escapeHtml(s.accountDetails || 'No account details added')}${s.contactPhone ? ' · ' + escapeHtml(s.contactPhone) : ''}</div>
      </div>
      <button class="icon-btn" onclick='openScannerModal(${JSON.stringify(s).replace(/&/g, "&amp;").replace(/'/g, "&#39;")})'>Edit</button>
    </div>`;
  }).join('');
}

window.openScannerModal = function (scanner) {
  clearError('scannerErr');
  _scannerImageData = scanner ? scanner.qrImage : null;
  document.getElementById('scannerForm').reset();
  document.getElementById('scanner_qrPreview').style.display = 'none';

  const scopeSel = document.getElementById('scanner_scope');
  scopeSel.innerHTML = `<option value="">Whole hostel (default, unless a block has its own)</option>` +
    Object.entries(BLOCK_META).map(([code, b]) => `<option value="${code}">${escapeHtml(b.name)}</option>`).join('');

  if (scanner) {
    document.getElementById('scannerModalTitle').textContent = 'Edit scanner';
    document.getElementById('scanner_id').value = scanner.id;
    scopeSel.value = scanner.scopeBlock || '';
    scopeSel.disabled = true; // scope can't be changed after creation — delete and re-add instead
    document.getElementById('scanner_accountName').value = scanner.accountName;
    document.getElementById('scanner_accountDetails').value = scanner.accountDetails || '';
    document.getElementById('scanner_phone').value = scanner.contactPhone || '';
    if (scanner.qrImage) {
      document.getElementById('scanner_qrPreview').src = scanner.qrImage;
      document.getElementById('scanner_qrPreview').style.display = 'block';
    }
    document.getElementById('scannerDeleteBtn').style.display = 'inline-block';
  } else {
    document.getElementById('scannerModalTitle').textContent = 'Add a scanner';
    document.getElementById('scanner_id').value = '';
    scopeSel.disabled = false;
    document.getElementById('scannerDeleteBtn').style.display = 'none';
  }
  document.getElementById('scannerModalBackdrop').classList.add('show');
};

function clearError(id) { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.textContent = ''; } }
function showFieldError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.style.display = 'block'; }

document.getElementById('scanner_qrFile')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  // See the matching comment in public/tenant.html's submitProof — the
  // server's limit is on the base64 STRING (~33% larger than the raw file),
  // so the client-side gate has to be set lower than the raw byte count of
  // the server's actual limit, or this check would be meaninglessly loose.
  if (file.size > 850000) { toast('Image too large — please use one under ~850KB', 'err'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    _scannerImageData = reader.result;
    const preview = document.getElementById('scanner_qrPreview');
    preview.src = reader.result;
    preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
});

document.getElementById('scannerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('scannerErr');
  const id = document.getElementById('scanner_id').value;
  const body = {
    scopeBlock: document.getElementById('scanner_scope').value || null,
    accountName: document.getElementById('scanner_accountName').value.trim(),
    accountDetails: document.getElementById('scanner_accountDetails').value.trim(),
    contactPhone: document.getElementById('scanner_phone').value.trim(),
    qrImage: _scannerImageData,
  };
  try {
    if (id) {
      await api(`/payments/scanners/${id}`, { method: 'PUT', body });
    } else {
      await api('/payments/scanners', { method: 'POST', body });
    }
    document.getElementById('scannerModalBackdrop').classList.remove('show');
    toast('Scanner saved', 'ok');
    loadScanners();
  } catch (err) { showFieldError('scannerErr', err.message); }
});

window.deleteScannerConfirm = async function () {
  const id = document.getElementById('scanner_id').value;
  if (!id || !confirm('Delete this scanner? Tenants using it will fall back to the whole-hostel scanner, if one exists.')) return;
  try {
    await api(`/payments/scanners/${id}`, { method: 'DELETE' });
    document.getElementById('scannerModalBackdrop').classList.remove('show');
    toast('Scanner deleted', 'ok');
    loadScanners();
  } catch (e) { toast(e.message, 'err'); }
};

// ---------- payment confirmations (proof review) ----------

async function loadPendingProofs(preloaded) {
  try {
    const proofs = preloaded || (await api('/payments/proofs/pending')).proofs;
    renderPendingProofs(proofs);
  } catch (e) { toast(e.message, 'err'); }
}

function renderPendingProofs(proofs) {
  const list = document.getElementById('proofsList');
  const empty = document.getElementById('proofsEmpty');
  const countTag = document.getElementById('proofsCountTag');

  if (proofs.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    countTag.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  countTag.style.display = 'inline-block';
  countTag.textContent = `${proofs.length} pending`;

  list.innerHTML = proofs.map((p) => {
    const parsed = parseUidClient(p.tenantUid);
    return `
    <div class="row-hover" style="display:flex; gap:16px; padding:16px 0; border-bottom:1px solid var(--line); flex-wrap:wrap;" data-proof-id="${p.id}">
      <img src="${p.screenshot}" style="width:80px; height:80px; object-fit:cover; border-radius:8px; cursor:pointer; border:1px solid var(--line);" onclick="viewProofScreenshot('${p.id}')" title="Click to view full size" />
      <div style="flex:1; min-width:220px;">
        <div style="font-weight:600;">${escapeHtml(p.tenantName)} ${blockBadge(parsed.block)} <span class="mono" style="font-size:0.78rem; color:#8a9690;">${p.tenantUid}</span></div>
        <div style="font-size:0.82rem; color:#8a9690; margin-top:2px;">${p.period}${p.paymentType === 'advance' ? ' <strong style="color:#8A5A00;">(Advance)</strong>' : ''} · Due ₹${Number(p.dueAmount).toLocaleString('en-IN')}</div>
        <div style="font-size:0.82rem; margin-top:4px;">
          ${p.utrReference ? `UTR/Ref: <span class="mono">${escapeHtml(p.utrReference)}</span> · ` : ''}
          ${p.paidDate ? `Paid on ${new Date(p.paidDate).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ` : ''}
          Submitted ${new Date(p.submittedAt).toLocaleString()}
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end; min-width:180px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:0.82rem; color:#8a9690;">₹</span>
          <input type="number" min="0" step="1" value="${p.claimedAmount}" id="proofAmount_${p.id}" style="width:100px; padding:6px 8px; font-size:0.85rem;" />
        </div>
        <div style="display:flex; gap:8px;">
          <button class="icon-btn" style="color:var(--coral); border-color:rgba(193,80,46,0.35);" onclick="rejectProof('${p.id}')">Reject</button>
          <button class="btn gold" style="width:auto; padding:8px 16px; font-size:0.85rem;" onclick="approveProof('${p.id}')">Confirm</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

window.viewProofScreenshot = function (id) {
  const img = document.querySelector(`[data-proof-id="${id}"] img`);
  if (!img) return;
  const w = window.open('', '_blank');
  w.document.write(`<title>Payment screenshot</title><body style="margin:0; background:#111; display:flex; align-items:center; justify-content:center; min-height:100vh;"><img src="${img.src}" style="max-width:100%; max-height:100vh;"></body>`);
};

window.approveProof = async function (id) {
  const amountInput = document.getElementById(`proofAmount_${id}`);
  const amount = Number(amountInput.value);
  if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount', 'err'); return; }
  if (!confirm(`Confirm this payment of ₹${amount.toLocaleString('en-IN')}? This updates the tenant's dues immediately.`)) return;
  try {
    await api(`/payments/proofs/${id}/approve`, { method: 'POST', body: { amount } });
    toast('Payment confirmed', 'ok');
    loadPendingProofs();
    loadDues();
    loadMonthlyChart();
  } catch (e) { toast(e.message, 'err'); }
};

window.rejectProof = async function (id) {
  const note = prompt('Reason for rejecting this submission (shown to the tenant):', 'Screenshot unclear — please resubmit');
  if (note === null) return;
  try {
    await api(`/payments/proofs/${id}/reject`, { method: 'POST', body: { note } });
    toast('Submission rejected', 'ok');
    loadPendingProofs();
  } catch (e) { toast(e.message, 'err'); }
};
