const crypto = require('crypto');

class SandboxPaymentService {
  constructor() {
    this.transactions = new Map();
  }

  generateTransactionId() {
    return `SBX_TXN_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  }

  createPaymentIntent(amount, customerId, vendorId) {
    const paymentIntentId = `pi_sandbox_${crypto.randomBytes(12).toString('hex')}`;
    const transactionId = this.generateTransactionId();
    
    const intent = {
      id: paymentIntentId,
      transactionId,
      amount,
      customerId,
      vendorId,
      status: 'pending',
      createdAt: new Date(),
    };

    this.transactions.set(paymentIntentId, intent);
    return intent;
  }

  getPaymentIntent(paymentIntentId) {
    return this.transactions.get(paymentIntentId);
  }

  async processPayment(paymentIntentId, method, scenario = 'success') {
    const intent = this.transactions.get(paymentIntentId);
    if (!intent) throw new Error('Payment intent not found');

    // Simulate delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    if (scenario === 'failure') {
      intent.status = 'failed';
      intent.error = 'MOCK_PAYMENT_FAILURE: Insufficient funds or invalid details.';
    } else if (scenario === 'timeout') {
      intent.status = 'timeout';
      intent.error = 'MOCK_PAYMENT_TIMEOUT: Gateway did not respond in time.';
    } else {
      intent.status = 'succeeded';
      intent.paymentMethod = method;
      intent.completedAt = new Date();
    }

    this.transactions.set(paymentIntentId, intent);
    return intent;
  }

  // Dummy card and credentials
  getTestCredentials() {
    return {
      cards: [
        { number: '4242 4242 4242 4242', expiry: '12/28', cvc: '123', label: 'Success Card' },
        { number: '4000 0000 0000 0002', expiry: '12/28', cvc: '123', label: 'Failure Card' },
      ],
      upi: [
        { id: 'success@sandbox', label: 'Success VPA' },
        { id: 'fail@sandbox', label: 'Failure VPA' },
      ]
    };
  }
}

module.exports = new SandboxPaymentService();
