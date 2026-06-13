const http = require('http');

console.log('--- Starting GovFlow AI 2.0 Integration Test ---');

const makeRequest = (method, path, headers, body) => {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'localhost',
      port: 3001,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    
    if (body) {
      options.headers['Content-Length'] = dataString.length;
    }

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            data: JSON.parse(responseBody)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            data: responseBody
          });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(dataString);
    }
    req.end();
  });
};

const runTests = async () => {
  try {
    // 1. Health check
    console.log('1. Checking Server Health...');
    const health = await makeRequest('GET', '/health');
    console.log(`Status: ${health.statusCode}, Response:`, health.data);
    
    if (health.statusCode !== 200) {
      console.error('Server is not running on port 3001. Start server.js first.');
      process.exit(1);
    }

    // 2. Try to login
    console.log('\n2. Testing Citizen Login...');
    const login = await makeRequest('POST', '/api/auth/login', {}, {
      email: 'raj@gmail.com',
      password: 'password123'
    });
    console.log(`Status: ${login.statusCode}, User: ${login.data?.user?.username || 'N/A'}`);
    
    if (login.statusCode !== 200 || !login.data.token) {
      console.error('Login failed! Run seed.js first.');
      process.exit(1);
    }

    const token = login.data.token;
    const authHeader = { 'Authorization': `Bearer ${token}` };

    // 3. Get User Profile
    console.log('\n3. Fetching User Profile...');
    const profile = await makeRequest('GET', '/api/auth/profile', authHeader);
    console.log(`Status: ${profile.statusCode}, Role: ${profile.data?.user?.role}`);

    // 4. Fetch Requests List
    console.log('\n4. Fetching citizen requests...');
    const list = await makeRequest('GET', '/api/requests', authHeader);
    console.log(`Status: ${list.statusCode}, Count: ${Array.isArray(list.data) ? list.data.length : 'N/A'}`);

    // 5. Test Chatbot API
    console.log('\n5. Testing Citizen Chatbot...');
    const chatbot = await makeRequest('POST', '/api/chatbot/query', authHeader, {
      message: 'Where is my file?'
    });
    console.log(`Status: ${chatbot.statusCode}, Response preview: "${chatbot.data?.reply?.substring(0, 80)}..."`);

    console.log('\n--- Integration Tests Completed Successfully! ---');
    process.exit(0);
  } catch (err) {
    console.error('Test run failed:', err.message);
    process.exit(1);
  }
};

// Delay start to allow server to bind ports if needed
setTimeout(runTests, 1000);
