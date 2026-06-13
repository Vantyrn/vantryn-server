const fetch = require('node-fetch'); // Assumes node-fetch is available, or use native fetch if Node >= 18

async function runTests() {
  const baseUrl = 'http://localhost:3000/api/vendor';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer mock-session-token-123'
  };

  console.log('--- Testing PUT /status ---');
  let res = await fetch(`${baseUrl}/status`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ status: 'online' })
  });
  let data = await res.json();
  console.log('Status updated:', data);

  console.log('\n--- Testing POST /products ---');
  res = await fetch(`${baseUrl}/products`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Test Burger',
      description: 'A delicious test burger',
      category: 'Fast Food',
      basePrice: 15.99,
      isRestricted: false,
      isActive: true
    })
  });
  data = await res.json();
  console.log('Product created:', data);

  if (data.product && data.product.id) {
    const productId = data.product.id;

    console.log('\n--- Testing GET /products ---');
    res = await fetch(`${baseUrl}/products`, {
      method: 'GET',
      headers
    });
    data = await res.json();
    console.log('Products fetched:', data.products?.length);

    console.log('\n--- Testing PUT /products/:id ---');
    res = await fetch(`${baseUrl}/products/${productId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        name: 'Test Burger Updated',
        basePrice: 19.99
      })
    });
    data = await res.json();
    console.log('Product updated:', data.product?.name);

    console.log('\n--- Testing DELETE /products/:id ---');
    res = await fetch(`${baseUrl}/products/${productId}`, {
      method: 'DELETE',
      headers
    });
    data = await res.json();
    console.log('Product deleted:', data);
  } else {
    console.log('\nSkip product tests because creation failed.');
  }
}

runTests().catch(console.error);
