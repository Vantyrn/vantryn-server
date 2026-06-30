const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const CartService = require('./cartService');
const OrderService = require('./orderService');
const deliveryService = require('../src/modules/delivery/delivery.service');
const { computeDeliveryCost } = require('../lib/deliveryCost');

/**
 * UPI deep-link payment confirmation service.
 *
 * Raw UPI intent deep-links give NO trustworthy "payment succeeded" signal (Android
 * returns a spoofable/often-pending status; iOS returns nothing; there is no PSP
 * webhook). So the order is created ONLY when a payment is AUTHORITATIVELY confirmed
 * via confirm() — driven by Admin reconciliation today, by a PSP/bank webhook later
 * (same entry point, zero rework). The customer's claim is provisional and never
 * creates or confirms an order on its own.
 */

const TTL_MIN = parseInt(process.env.UPI_PAYMENT_TTL_MIN || '15', 10);
const AMOUNT_TOLERANCE = 1.0; // ₹ — over/under this vs. expected → DISPUTED, never auto-confirmed
const PAYEE_VPA = process.env.VANTRYN_UPI_VPA || '';
const PAYEE_NAME = process.env.VANTRYN_UPI_NAME || 'Vantryn';
const MCC = '5814'; // restaurants / food

// The central Vantryn payee VPA must be configured via VANTRYN_UPI_VPA — no fallback.
function resolvePayeeVpa() {
  return PAYEE_VPA;
}

// Merchant transaction reference: embedded in the UPI `tr` field AND the
// reconciliation key. Must be <= 35 chars, URL-safe. e.g. VTRN-LJ3K9F2A-7C1E9B
function generateTr() {
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `VTRN-${t}-${r}`; // ~21 chars
}

function num(v) { return Number(v || 0); }

// Build the canonical UPI URI; the client constructs per-app/per-platform variants
// (e.g. GPay on iOS needs the `tez://` scheme) from these pieces.
function buildUpiUri({ payeeVpa, payeeName, amount, tr, note }) {
  const params = new URLSearchParams({
    pa: payeeVpa,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: 'INR',
    tr,
    tn: note,
    mc: MCC,
  });
  return `upi://pay?${params.toString()}`;
}

async function unlockCart(cartId) {
  if (!cartId) return;
  await prisma.cart.update({ where: { id: cartId }, data: { checkedOutAt: null } }).catch(() => {});
}

const upiPaymentService = {
  isConfigured() { return !!resolvePayeeVpa(); },

  /**
   * Create (or reuse) a PENDING payment request for the customer's cart and return
   * the deep-link pieces. Locks the cart so it can't be edited mid-payment.
   */
  async initiate({ customerId, guestId, vendorId, addressId, deliveryPreference, upiApp }) {
    const payeeVpa = resolvePayeeVpa();
    if (!payeeVpa) {
      const err = new Error('UPI_NOT_CONFIGURED: Set VANTRYN_UPI_VPA (the central payee VPA) on the backend.');
      err.status = 503;
      throw err;
    }
    if (!vendorId) { const e = new Error('vendorId is required'); e.status = 400; throw e; }
    // UPI orders require a logged-in customer: order creation needs a real customerId,
    // so guest UPI would fail silently downstream. Block it up front.
    if (!customerId) { const e = new Error('LOGIN_REQUIRED: Please log in to pay by UPI.'); e.status = 401; throw e; }

    const cart = await CartService.getCart({ customerId, guestId }, vendorId);
    if (!cart || !cart.items || cart.items.length === 0) {
      const e = new Error('CART_NOT_FOUND: No items to pay for.'); e.status = 404; throw e;
    }

    // SERVER-AUTHORITATIVE amount: never trust a client delivery fee (it can be tampered
    // to underpay). Recompute the fee server-side from the vendor + address + cart.
    const [vendor, address] = await Promise.all([
      prisma.vendor.findUnique({ where: { id: vendorId } }),
      addressId ? prisma.address.findUnique({ where: { id: addressId } }).catch(() => null) : Promise.resolve(null),
    ]);
    const deliveryFee = await computeDeliveryCost({ vendor, address, cartTotal: num(cart.total) });
    const amount = +(num(cart.total) + num(deliveryFee)).toFixed(2);
    if (amount <= 0) { const e = new Error('INVALID_AMOUNT'); e.status = 400; throw e; }

    // Idempotency: reuse a still-valid PENDING request for the same cart so a
    // double-tap / re-entry doesn't spawn duplicate locks/rows.
    const now = new Date();
    const existing = await prisma.upiPaymentRequest.findFirst({
      where: {
        vendorId,
        status: 'PENDING',
        expiresAt: { gt: now },
        ...(customerId ? { customerId } : { guestId }),
      },
      orderBy: { createdAt: 'desc' },
    });

    let reqRow;
    if (existing && Math.abs(num(existing.amount) - amount) <= AMOUNT_TOLERANCE) {
      reqRow = existing;
    } else {
      // Supersede any stale PENDING rows for this cart, then create a fresh one.
      if (existing) {
        await prisma.upiPaymentRequest.update({
          where: { id: existing.id }, data: { status: 'EXPIRED', failureReason: 'Superseded by new attempt' },
        }).catch(() => {});
      }
      reqRow = await prisma.upiPaymentRequest.create({
        data: {
          tr: generateTr(),
          customerId: customerId || null,
          guestId: customerId ? null : (guestId || null),
          vendorId,
          amount,
          payeeVpa,
          upiApp: upiApp || null,
          status: 'PENDING',
          deliveryPreference: deliveryPreference || 'standard',
          addressId: addressId || null,
          cartId: cart.id,
          expiresAt: new Date(Date.now() + TTL_MIN * 60 * 1000),
        },
      });
    }

    // Lock the cart for the duration of the attempt (no mid-payment edits).
    await prisma.cart.update({ where: { id: cart.id }, data: { checkedOutAt: now } }).catch(() => {});

    const note = `Vantryn order ${reqRow.tr.slice(-8)}`;
    return {
      tr: reqRow.tr,
      amount: num(reqRow.amount),
      itemTotal: num(cart.total),       // shown as the breakdown on the pay screen
      deliveryFee: num(deliveryFee),
      currency: 'INR',
      payeeVpa: reqRow.payeeVpa || payeeVpa,
      payeeName: PAYEE_NAME,
      note,
      mcc: MCC,
      upiUri: buildUpiUri({ payeeVpa: reqRow.payeeVpa || payeeVpa, payeeName: PAYEE_NAME, amount: num(reqRow.amount), tr: reqRow.tr, note }),
      expiresAt: reqRow.expiresAt,
      status: reqRow.status,
    };
  },

  /** Customer-reported outcome after returning from the UPI app. Provisional only. */
  async claim({ tr, customerId, guestId, clientStatus, utr }) {
    const reqRow = await prisma.upiPaymentRequest.findUnique({ where: { tr } });
    if (!reqRow) { const e = new Error('PAYMENT_NOT_FOUND'); e.status = 404; throw e; }
    // Ownership check.
    if ((customerId && reqRow.customerId !== customerId) || (!customerId && guestId && reqRow.guestId !== guestId)) {
      const e = new Error('FORBIDDEN'); e.status = 403; throw e;
    }
    if (reqRow.status !== 'PENDING') {
      return { status: reqRow.status, orderId: reqRow.orderId || null };
    }
    const claim = clientStatus === 'success' ? 'CLAIMED_SUCCESS'
      : clientStatus === 'failure' ? 'CLAIMED_FAILURE' : 'CLAIMED_PENDING';
    const updated = await prisma.upiPaymentRequest.update({
      where: { tr },
      data: { clientClaim: claim, claimedUtr: utr ? String(utr).trim().slice(0, 40) : reqRow.claimedUtr },
    });
    return { status: updated.status, orderId: updated.orderId || null };
  },

  /** Poll target for the customer screen. */
  async getStatus({ tr, customerId, guestId }) {
    const reqRow = await prisma.upiPaymentRequest.findUnique({ where: { tr } });
    if (!reqRow) { const e = new Error('PAYMENT_NOT_FOUND'); e.status = 404; throw e; }
    if ((customerId && reqRow.customerId !== customerId) || (!customerId && guestId && reqRow.guestId !== guestId)) {
      const e = new Error('FORBIDDEN'); e.status = 403; throw e;
    }
    return { tr, status: reqRow.status, orderId: reqRow.orderId || null, amount: num(reqRow.amount) };
  },

  /**
   * AUTHORITATIVE confirmation — the ONLY path that creates a paid order.
   * Idempotent on `tr`; a PENDING→CONFIRMING compare-and-set prevents double orders.
   * source: ADMIN_MANUAL | BANK_WEBHOOK | PSP_WEBHOOK.
   */
  async confirm(tr, { utr, amount, source = 'ADMIN_MANUAL', actor = 'admin' } = {}) {
    const reqRow = await prisma.upiPaymentRequest.findUnique({ where: { tr } });
    if (!reqRow) { const e = new Error('PAYMENT_NOT_FOUND'); e.status = 404; throw e; }

    // Idempotent: already confirmed → return the same order.
    if (reqRow.status === 'CONFIRMED' && reqRow.orderId) {
      return { idempotent: true, orderId: reqRow.orderId, status: 'CONFIRMED' };
    }
    if (['FAILED', 'EXPIRED'].includes(reqRow.status)) {
      const e = new Error(`PAYMENT_${reqRow.status}: cannot confirm a ${reqRow.status.toLowerCase()} payment.`);
      e.status = 409; throw e;
    }

    // Amount guard — over/underpayment is NEVER auto-confirmed.
    if (amount != null && Math.abs(num(amount) - num(reqRow.amount)) > AMOUNT_TOLERANCE) {
      await prisma.upiPaymentRequest.update({
        where: { tr },
        data: { status: 'DISPUTED', confirmedUtr: utr || null, confirmedAmount: num(amount), failureReason: `Amount mismatch: expected ₹${num(reqRow.amount)}, got ₹${num(amount)}`, confirmedBy: actor, confirmationSource: source },
      }).catch(() => {});
      const e = new Error(`AMOUNT_MISMATCH: expected ₹${num(reqRow.amount)}, received ₹${num(amount)} → marked DISPUTED.`);
      e.status = 409; throw e;
    }

    // Compare-and-set guard against concurrent confirms (double-order prevention).
    const cas = await prisma.upiPaymentRequest.updateMany({
      where: { tr, status: { in: ['PENDING', 'DISPUTED'] } },
      data: { status: 'CONFIRMING' },
    });
    if (cas.count === 0) {
      const fresh = await prisma.upiPaymentRequest.findUnique({ where: { tr } });
      if (fresh?.status === 'CONFIRMED' && fresh.orderId) return { idempotent: true, orderId: fresh.orderId, status: 'CONFIRMED' };
      const e = new Error(`PAYMENT_BUSY: payment is ${fresh?.status || 'unknown'}.`); e.status = 409; throw e;
    }

    try {
      // IDEMPOTENCY / crash-recovery: if an order already exists for this tr (e.g. a
      // previous confirm created the order but failed before marking CONFIRMED), reuse
      // it instead of creating a second one. paymentGatewayRef == tr for UPI orders.
      const existingOrder = await prisma.order.findFirst({ where: { paymentGatewayRef: tr }, select: { id: true, status: true } });
      if (existingOrder) {
        const u = await prisma.upiPaymentRequest.update({
          where: { tr },
          data: {
            status: 'CONFIRMED', orderId: existingOrder.id,
            confirmedUtr: utr ? String(utr).trim().slice(0, 40) : reqRow.confirmedUtr,
            confirmedAmount: amount != null ? num(amount) : num(reqRow.amount),
            confirmationSource: source, confirmedBy: actor, confirmedAt: new Date(),
          },
        });
        console.log(`[UPI] ${tr} re-linked to existing order ${existingOrder.id} (idempotent).`);
        return { idempotent: true, orderId: existingOrder.id, status: 'CONFIRMED', orderStatus: existingOrder.status };
      }

      const cart = await CartService.getCart({ customerId: reqRow.customerId, guestId: reqRow.guestId }, reqRow.vendorId);
      if (!cart || !cart.items || cart.items.length === 0) {
        await prisma.upiPaymentRequest.update({ where: { tr }, data: { status: 'DISPUTED', failureReason: 'Cart missing at confirmation' } });
        const e = new Error('CART_MISSING: cannot build the order — flagged DISPUTED for manual handling.'); e.status = 409; throw e;
      }

      // The cart is locked from edits during PENDING, so its total is the same one we
      // priced at initiate → derive the (server-computed) delivery fee back out exactly.
      const deliveryFee = Math.max(0, +(num(reqRow.amount) - num(cart.total)).toFixed(2));

      // Money is already collected → create the order even if the vendor just went offline.
      // Pin the delivery address to the one chosen at initiate (not the latest default).
      const order = await OrderService.createOrderFromCart(
        cart,
        reqRow.customerId,
        'Customer',
        reqRow.deliveryPreference || 'standard',
        'UPI',
        tr,
        deliveryFee,
        { skipVendorAvailabilityCheck: true, addressId: reqRow.addressId }
      );

      await prisma.paymentTransaction.create({
        data: {
          orderId: order.id,
          gateway: source === 'ADMIN_MANUAL' ? 'UPI_MANUAL' : 'UPI',
          txnId: tr,
          status: 'SUCCESS',
          amount: order.totalAmount,
          webhookPayload: { tr, utr: utr || null, source, confirmedBy: actor },
        },
      }).catch((e) => console.warn('[UPI] paymentTransaction log failed:', e.message));

      const updated = await prisma.upiPaymentRequest.update({
        where: { tr },
        data: {
          status: 'CONFIRMED',
          confirmedUtr: utr ? String(utr).trim().slice(0, 40) : null,
          confirmedAmount: amount != null ? num(amount) : num(reqRow.amount),
          confirmationSource: source,
          confirmedBy: actor,
          confirmedAt: new Date(),
          orderId: order.id,
        },
      });

      // Kick off delivery (mirrors /payments/verify). Never blocks confirmation —
      // a delivery hiccup must not undo a paid, vendor-notified order.
      if (order.status !== 'CANCELLED') {
        deliveryService.initiateDelivery(order.id).catch((e) =>
          console.error('[UPI] Delivery initiation failed (order kept):', e.message));
      }

      console.log(`[UPI] Payment ${tr} CONFIRMED by ${actor} (${source}) → order ${order.id}`);
      return { idempotent: false, orderId: order.id, status: 'CONFIRMED', orderStatus: order.status };
    } catch (err) {
      // Roll the CAS back so the payment can be retried (don't strand it in CONFIRMING).
      await prisma.upiPaymentRequest.updateMany({
        where: { tr, status: 'CONFIRMING' }, data: { status: 'PENDING' },
      }).catch(() => {});
      throw err;
    }
  },

  /** Mark a payment failed/rejected (admin) and unlock the cart for retry. */
  async reject(tr, { reason = 'Rejected by admin', actor = 'admin' } = {}) {
    const reqRow = await prisma.upiPaymentRequest.findUnique({ where: { tr } });
    if (!reqRow) { const e = new Error('PAYMENT_NOT_FOUND'); e.status = 404; throw e; }
    if (reqRow.status === 'CONFIRMED') { const e = new Error('ALREADY_CONFIRMED'); e.status = 409; throw e; }
    await prisma.upiPaymentRequest.update({
      where: { tr },
      data: { status: 'FAILED', failureReason: reason, confirmedBy: actor },
    });
    await unlockCart(reqRow.cartId);
    return { status: 'FAILED' };
  },

  /**
   * Expire stale PENDING requests and unlock their carts. Deliberately does NOT touch
   * CONFIRMING rows — those are mid-confirmation; expiring one could orphan an order that
   * was just created. A stuck CONFIRMING stays visible to admin reconciliation instead.
   */
  async sweepExpired() {
    const now = new Date();
    const stale = await prisma.upiPaymentRequest.findMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      select: { id: true, tr: true, cartId: true },
      take: 200,
    });
    if (stale.length === 0) return 0;
    await prisma.upiPaymentRequest.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'EXPIRED', failureReason: 'Payment not confirmed in time' },
    });
    for (const s of stale) await unlockCart(s.cartId);
    console.log(`[UPI] Swept ${stale.length} expired payment request(s).`);
    return stale.length;
  },
};

module.exports = upiPaymentService;
