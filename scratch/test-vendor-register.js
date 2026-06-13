const axios = require('axios');

async function testRegister() {
  try {
    const payload = {
      businessName: 'Mock Burger King',
      ownerName: 'Mock Owner',
      address: 'Test Address 123',
      category: 'Food',
      description: 'Test Desc',
      bankData: {
        holderName: 'Zaid',
        bankName: 'HDFC',
        accountNumber: '123456789',
        ifscCode: 'HDFC0001',
      }
    };

    // Note: We don't have a valid Firebase sessionToken here, but let's test if the server responds or rejects.
    // Actually we can create a mock token using Firebase Admin, or temporarily bypass the middleware for this test.
    console.log('Sending to backend...');
    const res = await axios.post('http://127.0.0.1:3000/api/vendor/register', payload, {
      headers: { Authorization: 'Bearer mock-session-token-123' }
    });
    console.log('Success:', res.data);
  } catch (e) {
    console.error('Error:', e.response ? e.response.data : e.message);
  }
}

testRegister();
