const crypto = require('crypto');
const db = require('../db/database');

// This is THE authoritative payment-confirmation path — it's what makes
// updates automatic, independent of whether the tenant's browser is even
// still open after they pay. Razorpay calls this endpoint directly from
// their own servers whenever a payment is captured.
//
// Mounted in server.js with express.raw() BEFORE express.json(), because
// signature verification needs the exact raw request bytes — parsing it to
// JSON first (even to re-stringify) can change byte-for-byte formatting
// and make a genuinely valid signature look invalid.
async function handleRazorpayWebhook(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.status(400).send('Missing signature');

    const config = await db.getPaymentConfig();
    if (!config.razorpayWebhookSecret) {
      console.error('Razorpay webhook received but no webhook secret is configured — rejecting.');
      return res.status(400).send('Webhook not configured');
    }

    // req.body is a raw Buffer here (see express.raw() in server.js)
    const rawBody = req.body;
    const expectedSignature = crypto
      .createHmac('sha256', config.razorpayWebhookSecret)
      .update(rawBody)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const isValid = signatureBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

    if (!isValid) {
      console.warn('Razorpay webhook signature mismatch — rejecting.');
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload && event.payload.payment && event.payload.payment.entity;
      if (!paymentEntity) return res.status(200).send('OK (no payment entity)');

      const orderId = paymentEntity.order_id;
      const gatewayPaymentId = paymentEntity.id;

      const payment = await db.findPaymentByGatewayOrderId(orderId);
      if (!payment) {
        console.warn(`Razorpay webhook: no local payment found for order ${orderId}`);
        return res.status(200).send('OK (unknown order)'); // 200 so Razorpay doesn't retry forever
      }

      const { alreadyPaid } = await db.markPaymentPaidViaGateway(payment.id, gatewayPaymentId);
      if (!alreadyPaid) {
        const tenant = await db.getTenantById(payment.tenantId);
        if (tenant) {
          await db.logAction(
            tenant.name,
            'RAZORPAY_WEBHOOK_CONFIRMED',
            `${tenant.name} (UID ${tenant.uid})'s ${payment.period} payment of ₹${payment.amount} confirmed paid via Razorpay webhook`
          );
        }
      }
    }

    // Always 200 on any recognized/valid webhook call, even for event types
    // we don't act on — Razorpay retries on non-2xx, which we don't want.
    res.status(200).send('OK');
  } catch (e) {
    console.error('Razorpay webhook error:', e);
    res.status(500).send('Server error');
  }
}

module.exports = handleRazorpayWebhook;
