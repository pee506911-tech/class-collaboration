/**
 * Diagnostic script for users experiencing auth issues.
 * Run this in browser console: paste and run
 */
(function diagnoseAuth() {
    console.log('=== ClassCollaboration Auth Diagnostic ===\n');
    
    // Check localStorage
    const token = localStorage.getItem('token');
    console.log('1. localStorage token:', token ? `Present (${token.length} chars)` : 'MISSING');
    
    if (token) {
        // Decode JWT to check expiry
        try {
            const parts = token.split('.');
            const payload = JSON.parse(atob(parts[1]));
            const expDate = new Date(payload.exp * 1000);
            const now = new Date();
            const isExpired = expDate < now;
            
            console.log('2. Token details:');
            console.log('   - User ID:', payload.userId);
            console.log('   - Role:', payload.role);
            console.log('   - Expires:', expDate.toLocaleString());
            console.log('   - Status:', isExpired ? '❌ EXPIRED' : '✅ VALID');
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.log('2. Token decode failed:', message);
        }
    }
    
    // Check cookies
    const cookies = document.cookie.split(';').map(c => c.trim().split('=')[0]);
    console.log('\n3. Cookies present:', cookies.join(', ') || 'NONE');
    console.log('   Note: httpOnly cookies (auth token) are not visible to JS');
    
    // Test API endpoint
    console.log('\n4. Testing API authentication...');
    const apiBase = process.env?.NEXT_PUBLIC_API_URL || 'https://class-collaboration-production.up.railway.app/api';
    
    fetch(`${apiBase}/sessions`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    })
    .then(res => res.json())
    .then(data => {
        console.log('   API Response:', data);
        if (data.error === 'Missing authorization') {
            console.log('\n❌ DIAGNOSIS: No valid auth found. Please log in again.');
            console.log('   Solution: Clear localStorage and login fresh');
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/login';
        } else if (data.success) {
            console.log('\n✅ DIAGNOSIS: Auth is working!');
        }
    })
    .catch(err => {
        console.log('   API test failed:', err.message);
    });
    
    console.log('\n=== End Diagnostic ===');
})();
