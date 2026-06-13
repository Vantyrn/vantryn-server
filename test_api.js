const axios = require('axios');

async function testToggle() {
  try {
    const url = 'http://localhost:3001/api/vendor/status/toggle';
    console.log('Testing Status Toggle API...');
    
    const response = await axios.put(url, 
      { isOnline: false },
      { headers: { Authorization: 'Bearer mock-session-token-123' } }
    );
    
    console.log('API Response:', response.data);
  } catch (err) {
    console.error('API ERROR:', err.response?.data || err.message);
  }
}

testToggle();
