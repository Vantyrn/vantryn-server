const axios = require('axios');

async function testSync() {
  const IP = '10.174.36.166';
  const URL = `http://${IP}:3000/api/auth/sync`;
  const MOCK_TOKEN = 'test-token-' + Date.now();

  console.log(`--- Testing Connectivity to ${URL} ---`);
  
  try {
    const response = await axios.post(URL, {}, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` }
    });
    
    console.log('--- RESPONSE RECEIVED ---');
    console.log(JSON.stringify(response.data, null, 2));
    
    if (response.data.success) {
      console.log('SUCCESS: API is reachable and sync worked!');
    } else {
      console.log('FAILURE: API responded but success was false.');
    }
  } catch (err) {
    console.error('CONNECTIVITY ERROR:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', err.response.data);
    }
  }
}

testSync();
