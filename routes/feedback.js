const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const { prisma } = require('../lib/prisma');

/**
 * MODULE 8 — FEEDBACK
 */

// POST /orders/:id/feedback — submit after delivery only
router.post('/:id', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { id: orderId } = req.params;
    const { rating, comment } = req.body;

    // 1. Validate Rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5 stars' });
    }

    // 2. Validate Comment length
    if (comment && comment.length > 150) {
      return res.status(400).json({ error: 'Comment must be max 150 characters' });
    }

    // 3. Find Order and verify eligibility
    const order = await prisma.order.findUnique({
      where: { id: orderId, customerId: req.customer.id }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status?.toLowerCase() !== 'delivered') {
      return res.status(400).json({ error: 'Feedback can only be submitted for delivered orders' });
    }

    // 4. One feedback per order check
    const existingFeedback = await prisma.feedback.findUnique({
      where: { orderId }
    });

    if (existingFeedback) {
      return res.status(409).json({ error: 'Feedback already submitted for this order' });
    }

    // 5. Create Feedback and update Vendor Rating Summary in transaction
    const { feedback } = await prisma.$transaction(async (tx) => {
      const fb = await tx.feedback.create({
        data: {
          orderId,
          customerId: req.customer.id,
          rating: parseInt(rating),
          comment
        }
      });

      // Update Vendor Rating Summary
      const oldSummary = await tx.vendorRatingsSummary.findUnique({
        where: { vendorId: order.vendorId }
      });

      if (!oldSummary) {
        await tx.vendorRatingsSummary.create({
          data: {
            vendorId: order.vendorId,
            avgRating: parseInt(rating),
            totalReviews: 1
          }
        });
      } else {
        const newCount = oldSummary.totalReviews + 1;
        const newAvg = (Number(oldSummary.avgRating) * oldSummary.totalReviews + parseInt(rating)) / newCount;
        
        await tx.vendorRatingsSummary.update({
          where: { vendorId: order.vendorId },
          data: {
            avgRating: newAvg,
            totalReviews: newCount
          }
        });
      }

      return { feedback: fb };
    });

    res.json({ success: true, feedback });

  } catch (error) {
    console.error('[FEEDBACK] submission error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

module.exports = router;
