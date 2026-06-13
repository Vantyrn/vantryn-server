const express = require('express');
const router = express.Router();
const sandboxPaymentService = require('../services/sandboxPaymentService');
const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const { prisma } = require('../lib/prisma');

// GET /sandbox/credentials - Get dummy credentials for testing
router.get('/credentials', (req, res) => {
  res.json({ success: true, ...sandboxPaymentService.getTestCredentials() });
});

// POST /sandbox/process - Process a sandbox payment
router.post('/process', firebaseAuth, requireCustomer, async (req, res) => {
  const { paymentIntentId, method, scenario } = req.body;
  
  try {
    const result = await sandboxPaymentService.processPayment(paymentIntentId, method, scenario);
    res.json({ success: true, result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
