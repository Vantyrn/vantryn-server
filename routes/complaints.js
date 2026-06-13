const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const { prisma } = require('../lib/prisma');

/**
 * MODULE 9 — CUSTOMER COMPLAINTS
 */

// POST /api/customer/complaints — Submit a complaint
router.post('/', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { orderId, issueType, message } = req.body;

    if (!orderId || !issueType || !message) {
      return res.status(400).json({ error: 'Missing required fields: orderId, issueType, message' });
    }

    // 1. Verify order belongs to customer
    const order = await prisma.order.findUnique({
      where: { id: orderId, customerId: req.customer.id }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // 2. Create Support Request (Complaint)
    const complaint = await prisma.supportRequest.create({
      data: {
        customerId: req.customer.id,
        orderId: orderId,
        issueType,
        message,
        status: 'PENDING'
      }
    });

    // 3. (Optional) Flag order for admin attention
    await prisma.order.update({
      where: { id: orderId },
      data: { isFlaggedAdmin: true, flagReason: `Customer Complaint: ${issueType}` }
    });

    res.json({ success: true, complaint });

  } catch (error) {
    console.error('[COMPLAINTS] submission error:', error);
    res.status(500).json({ error: 'Failed to submit complaint' });
  }
});

// GET /api/customer/complaints — Get my complaints
router.get('/history', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const complaints = await prisma.supportRequest.findMany({
      where: { customerId: req.customer.id },
      include: {
        order: {
          select: {
            id: true,
            status: true,
            createdAt: true,
            vendor: { select: { businessName: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, complaints });
  } catch (error) {
    console.error('[COMPLAINTS] fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch complaints' });
  }
});

module.exports = router;
