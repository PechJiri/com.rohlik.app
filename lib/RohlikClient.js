const fetch = require('node-fetch');
const EventEmitter = require('events');

const COUNTRY_URLS = {
  CZ: 'https://www.rohlik.cz',
  DE: 'https://www.knuspr.de',
  AT: 'https://www.gurkerl.at',
  HU: 'https://www.kifli.hu',
  RO: 'https://www.sezamo.ro'
};

class RohlikClient extends EventEmitter {
  constructor({ username, password, country }) {
    super();
    this.username = username;
    this.password = password;
    this.baseUrl = COUNTRY_URLS[country?.toUpperCase()] || COUNTRY_URLS.CZ;

    this.sessionCookies = '';
    this.userId = null;
    this.addressId = null;
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // ms
  }

  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const delay = this.minRequestInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    this.lastRequestTime = Date.now();
  }

  async makeRequest(url, options = {}, isRetry = false) {
    await this.rateLimit();

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      ...(this.sessionCookies && { Cookie: this.sessionCookies }),
      ...(options.headers || {})
    };

    try {
      console.log(`[RohlikClient] Request: ${options.method || 'GET'} ${url}`);
      const response = await fetch(`${this.baseUrl}${url}`, {
        ...options,
        headers
      });

      // Update cookies if present
      const setCookieHeader = response.headers.get('set-cookie');
      if (setCookieHeader) {
        // Simple append strategy or overwrite. For now, overwrite if we get a new set.
        // In a more robust implementation, we might merge individual cookies.
        this.sessionCookies = setCookieHeader;
      }

      if (response.status === 401 || response.status === 403) {
        if (!isRetry) {
          console.log('[RohlikClient] Auth failed (401/403), attempting re-login...');
          await this.login();
          return this.makeRequest(url, options, true);
        } else {
          throw new Error('Unauthorized after retry');
        }
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const jsonData = await response.json();
      console.log(`[RohlikClient] Response from ${url}:`, JSON.stringify(jsonData, null, 2));

      // Emit events for specific endpoints
      if (url.includes('/api/v1/reusable-bags/user-info')) {
        const bagsData = jsonData.data || jsonData;
        if (bagsData && typeof bagsData.current === 'number') {
          this.emit('reusable_bags', bagsData.current);
        }
      }

      return jsonData;

    } catch (error) {
      console.log(`[RohlikClient] Request failed: ${url}`, error);
      throw error;
    }
  }

  async login() {
    const loginData = {
      email: this.username,
      password: this.password,
    };

    // Use specific endpoint or headers if needed so we don't loop infinitely in makeRequest
    // But here we can use makeRequest if we handle the recursion carefully (isRetry flag only applies to regular calls).
    // Actually, login shouldn't use makeRequest with checks, it should just go raw fetch or have special handling.
    // But for simplicity, we mock a "raw" call here to avoid circular dependency on makeRequest's 401 handler.

    await this.rateLimit();

    const response = await fetch(`${this.baseUrl}/services/frontend-service/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      body: JSON.stringify(loginData)
    });

    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      this.sessionCookies = setCookieHeader;
    }

    const data = await response.json();
    console.log(`[RohlikClient] Login response:`, JSON.stringify(data, null, 2));

    const isSuccess = response.status === 200 || response.status === 202;
    if (!isSuccess) {
      const errorMsg = data.messages?.[0]?.content || data.message || 'Login failed';
      throw new Error(`Login failed: ${errorMsg}`);
    }

    this.userId = data.data?.user?.id;
    this.addressId = data.data?.address?.id;

    if (!this.userId) {
      throw new Error('Login succeeded but no User ID returned.');
    }

    console.log(`[RohlikClient] Login successful. User ID: ${this.userId}`);
  }

  async searchProducts(query, limit = 20) {
    const searchParams = new URLSearchParams({
      search: query,
      offset: '0',
      limit: String(limit),
      companyId: '1', // This might need to be dynamic for other countries? Usually 1 works for Rohlik/Knuspr structure often shared.
      filterData: JSON.stringify({ filters: [] }),
      canCorrect: 'true'
    });

    const response = await this.makeRequest(`/services/frontend-service/search-metadata?${searchParams}`);
    let products = response.data?.productList || [];

    return products.slice(0, limit).map(p => ({
      id: String(p.productId),
      name: p.productName,
      price: p.price.full,
      currency: p.price.currency,
      brand: p.brand,
      image: p.images?.[0] // Assuming structure
    }));
  }

  async addToCart(productId, quantity = 1) {
    const payload = {
      productId: parseInt(productId, 10),
      quantity: quantity,
      source: 'true:Homey'
    };

    await this.makeRequest('/services/frontend-service/v2/cart', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return true;
  }

  async removeFromCart(orderFieldId) {
    // orderFieldId is the internal cart item ID, not product ID.
    await this.makeRequest(`/services/frontend-service/v2/cart?orderFieldId=${orderFieldId}`, {
      method: 'DELETE'
    });
    return true;
  }



  async getCartContent() {
    const response = await this.makeRequest('/services/frontend-service/v2/cart');
    const data = response.data || {};

    const items = Object.values(data.items || {}).map(item => ({
      id: String(item.productId),
      cart_item_id: String(item.orderFieldId), // Needed for removal
      name: item.productName,
      quantity: item.quantity,
      price: item.price,
      pricePerUnit: item.pricePerUnit
    }));

    return {
      totalPrice: data.totalPrice || 0,
      totalItems: items.length, // or sum of quantities? User asked for count. Usually count of "lines".
      items
    };
  }

  async getUpcomingOrders() {
    const response = await this.makeRequest('/api/v3/orders/upcoming');
    return response.data || [];
  }

  async getDeliverySlots() {
    if (!this.userId || !this.addressId) return null;
    const url = `/services/frontend-service/timeslots-api/0?userId=${this.userId}&addressId=${this.addressId}&reasonableDeliveryTime=true`;
    const response = await this.makeRequest(url);
    return response.data;
  }

  async logout() {
    await this.makeRequest('/services/frontend-service/logout', { method: 'POST' });
    this.sessionCookies = '';
  }

  async getShoppingList(shoppingListId) {
    const response = await this.makeRequest(`/api/v1/shopping-lists/id/${shoppingListId}`);
    const listData = response.data || response;
    return {
      name: listData?.name || 'Unknown List',
      products: listData?.products || []
    };
  }

  async getAccountData() {
    const result = {};

    const endpoints = {
      delivery: '/services/frontend-service/first-delivery?reasonableDeliveryTime=true',
      next_order: '/api/v3/orders/upcoming',
      announcements: '/services/frontend-service/announcements/top',
      bags: '/api/v1/reusable-bags/user-info',
      timeslot: '/services/frontend-service/v1/timeslot-reservation',
      last_order: '/api/v3/orders/delivered?offset=0&limit=1',
      premium_profile: '/services/frontend-service/premium/profile',
      delivery_announcements: '/services/frontend-service/announcements/delivery',
      delivered_orders: '/api/v3/orders/delivered?offset=0&limit=50'
    };

    for (const [endpoint, path] of Object.entries(endpoints)) {
      try {
        const response = await this.makeRequest(path);
        result[endpoint] = response.data || response;
      } catch (error) {
        console.log(`[RohlikClient] Error fetching ${endpoint}: ${error.message}`);
        result[endpoint] = null;
      }
    }

    if (this.userId && this.addressId) {
      try {
        const nextDeliveryPath = `/services/frontend-service/timeslots-api/0?userId=${this.userId}&addressId=${this.addressId}&reasonableDeliveryTime=true`;
        const response = await this.makeRequest(nextDeliveryPath);
        result.next_delivery_slot = response.data || response;
      } catch (error) {
        result.next_delivery_slot = null;
      }
    } else {
      result.next_delivery_slot = null;
    }

    try {
      result.cart = await this.getCartContent();
    } catch (error) {
      result.cart = null;
    }

    return result;
  }

  async getOrderHistory(limit = 50) {
    const response = await this.makeRequest(`/api/v3/orders/delivered?offset=0&limit=${limit}`);
    return response.data || response;
  }

  async getDeliveryInfo() {
    const response = await this.makeRequest('/services/frontend-service/first-delivery?reasonableDeliveryTime=true');
    return response.data || response;
  }

  async getPremiumInfo() {
    const response = await this.makeRequest('/services/frontend-service/premium/profile');
    return response.data || response;
  }

  async getAnnouncements() {
    const response = await this.makeRequest('/services/frontend-service/announcements/top');
    return response.data || response;
  }

  async getReusableBagsInfo() {
    const response = await this.makeRequest('/api/v1/reusable-bags/user-info');
    return response.data || response;
  }

  async getOrderDetail(orderId) {
    const response = await this.makeRequest(`/api/v3/orders/${orderId}`);
    return response.data || response;
  }

  async getDeliveryAnnouncements() {
    const response = await this.makeRequest('/services/frontend-service/announcements/delivery');
    return response.data || response;
  }

}


module.exports = RohlikClient;
