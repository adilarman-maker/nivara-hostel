async function loadPayments() {
  const filterSel = document.getElementById('paymentsBlockFilter');
  const settingsPanel = document.getElementById('paymentSettingsPanel');
  const subtitle = document.getElementById('paymentsSubtitle');

  if (me.role === 'super') {
    subtitle.textContent = 'Dues and collections across all blocks — filter by block if you like.';
    settingsPanel.style.display = 'block';
    document.getElementById('razorpaySettingsPanel').style.display = 'block';
    if (filterSel.options.length === 0) {
      filterSel.style.display = 'inline-block';
      filterSel.innerHTML = `<option value="">All blocks</option>` +
        Object.entries(BLOCK_META).map(([code, b]) => `<option value="${code}">${b.name}</option>`).join('');
      filterSel.addEventListener('change', loadDues);
    }
    loadPaymentConfig();
    loadRazorpaySettings();
  } else {
    subtitle.textContent = `Dues and collections for ${BLOCK_META[me.blockCode].name} only.`;
  }
  loadDues();
}

async function loadDues() {
  try {
    const filterSel = document.getElementById('paymentsBlockFilter');
    const block = me.role === 'super' ? filterSel.value : '';
    const data = await api('/payments/dues' + (block ? `?block=${block}` : ''));

    document.getElementById('statTotalDue').textContent = '₹' + data.totalDue.toLocaleString('en-IN');
    document.getElementById('statTotalCollected').textContent = '₹' + data.totalCollected.toLocaleString('en-IN');
    document.getElementById('statDueCount').textContent = data.dueCount;
    document.getElementById('statPercentDue').textContent = data.percentDue;
    document.getElementById('statPercentCollected').textContent = data.percentCollected;

    const tbody = document.getElementById('duesRows');
    document.getElementById('duesEmpty').style.display = data.dueList.length ? 'none' : 'block';
    tbody.innerHTML = data.dueList.map((d) => {
      const parsed = parseUidClient(d.tenantUid);
      return `
      <tr class="row-hover">
        <td><b>${escapeHtml(d.tenantName)}</b><div style="font-size:0.76rem;color:#8a9690;">${d.tenantPhone}</div></td>
        <td class="mono">${d.tenantUid}</td>
        <td>${blockBadge(parsed.block)}</td>
        <td>${d.period}</td>
        <td><b>₹${Number(d.amount).toLocaleString('en-IN')}</b></td>
        <td><button class="icon-btn" onclick="markPaid('${d.id}')">Mark ${d.type === 'advance' ? 'advance' : 'rent'} paid</button></td>
      </tr>`;
    }).join('');
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
    document.getElementById('cfgUpiId').value = c.upiId || '';
    document.getElementById('cfgPayeeName').value = c.payeeName || '';
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
          upiId: document.getElementById('cfgUpiId').value.trim(),
          payeeName: document.getElementById('cfgPayeeName').value.trim(),
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

async function loadRazorpaySettings() {
  document.getElementById('razorpayWebhookUrl').value = window.location.origin + '/api/payments/razorpay/webhook';
  try {
    const c = await getPaymentConfigCached(true);
    document.getElementById('cfgRzpKeyId').value = c.razorpayKeyId || '';
    document.getElementById('razorpayStatusLine').textContent = c.razorpayEnabled
      ? '✅ Configured — tenants can pay online automatically.'
      : 'Not set up yet — tenants will only see the UPI QR / manual options.';
  } catch (e) { toast(e.message, 'err'); }
}

window.copyWebhookUrl = function () {
  const input = document.getElementById('razorpayWebhookUrl');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => toast('Copied', 'ok')).catch(() => {});
};

const razorpayConfigForm = document.getElementById('razorpayConfigForm');
if (razorpayConfigForm) {
  razorpayConfigForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = { razorpayKeyId: document.getElementById('cfgRzpKeyId').value.trim() };
      const keySecret = document.getElementById('cfgRzpKeySecret').value.trim();
      const webhookSecret = document.getElementById('cfgRzpWebhookSecret').value.trim();
      if (keySecret) body.razorpayKeySecret = keySecret;
      if (webhookSecret) body.razorpayWebhookSecret = webhookSecret;

      await api('/payments/config', { method: 'PUT', body });
      invalidatePaymentConfigCache();
      document.getElementById('cfgRzpKeySecret').value = '';
      document.getElementById('cfgRzpWebhookSecret').value = '';
      toast('Razorpay settings saved', 'ok');
      loadRazorpaySettings();
    } catch (err) { toast(err.message, 'err'); }
  });
}
