const Homey = require('homey');
const RohlikClient = require('../../lib/RohlikClient');

module.exports = class RohlikDevice extends Homey.Device {

    async onInit() {
        this.log('RohlikDevice has been initialized');

        const settings = this.getSettings();

        // Initialize client with listeners
        this.initClient(settings);

        await this.connect();

        // Register Flow Actions
        const addItemCard = this.homey.flow.getActionCard('add_item');
        addItemCard.registerRunListener(async (args, state) => {
            return this.onFlowActionAddItem(args, state);
        });
        addItemCard.registerArgumentAutocompleteListener('product', async (query, args) => {
            return this.onFlowActionAddItemAutocomplete(query, args);
        });

        const removeItemCard = this.homey.flow.getActionCard('remove_item');
        removeItemCard.registerRunListener(async (args, state) => {
            return this.onFlowActionRemoveItem(args, state);
        });
        removeItemCard.registerArgumentAutocompleteListener('product_in_cart', async (query, args) => {
            return this.onFlowActionRemoveItemAutocomplete(query, args);
        });

        // Register get_product_id action
        const getProductIdCard = this.homey.flow.getActionCard('get_product_id');
        getProductIdCard.registerRunListener(async (args, state) => {
            return this.onFlowActionGetProductId(args, state);
        });
        getProductIdCard.registerArgumentAutocompleteListener('product', async (query, args) => {
            return this.onFlowActionAddItemAutocomplete(query, args);
        });

        // Register get_cart_content action
        const getCartContentCard = this.homey.flow.getActionCard('get_cart_content');
        getCartContentCard.registerRunListener(async (args, state) => {
            return this.onFlowActionGetCartContent(args, state);
        });

        // Register add_item_by_id action (text input for tags)
        const addItemByIdCard = this.homey.flow.getActionCard('add_item_by_id');
        addItemByIdCard.registerRunListener(async (args, state) => {
            return this.onFlowActionAddItemById(args, state);
        });

        // Register remove_item_by_id action (text input for tags)
        const removeItemByIdCard = this.homey.flow.getActionCard('remove_item_by_id');
        removeItemByIdCard.registerRunListener(async (args, state) => {
            return this.onFlowActionRemoveItemById(args, state);
        });

        // Register test_api_method action (for debugging)
        const testApiMethodCard = this.homey.flow.getActionCard('test_api_method');
        testApiMethodCard.registerRunListener(async (args, state) => {
            return this.onFlowActionTestApiMethod(args, state);
        });

        // Initialize polling intervals from settings (or defaults)
        this.startPolling();
    }

    initClient(settings) {
        // cleanup old client listeners if needed - though allowing GC to handle usually fine if we drop reference
        // but explicit removeAllListeners if we kept it would be good. 
        if (this.client) {
            this.client.removeAllListeners();
        }

        this.client = new RohlikClient({
            username: settings.username,
            password: settings.password,
            country: settings.country || 'CZ'
        });

        this.client.on('reusable_bags', async (count) => {
            this.log('Event: Reusable bags count updated:', count);
            await this.setCapabilityValue('measure_reusable_bags', count).catch(this.error);
        });
    }

    async connect() {
        try {
            await this.client.login();
            this.setAvailable();
            this.log('Logged in successfully');
            this.updateData();
        } catch (err) {
            this.error('Login failed', err);
            this.setUnavailable(err.message);
        }
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        this.log('Settings changed:', changedKeys);

        // Check if login-related settings changed
        const loginSettingsChanged = changedKeys.some(key =>
            ['username', 'password', 'region'].includes(key)
        );

        // Check if polling intervals changed
        const pollingChanged = changedKeys.some(key =>
            ['polling_interval_general', 'polling_interval_slots'].includes(key)
        );

        if (pollingChanged) {
            this.log('Polling intervals changed, restarting timers...');
            this.startPolling();
        }

        if (loginSettingsChanged) {
            this.log('Login credentials or region changed, performing re-login...');

            // Logout from old session if possible
            try {
                await this.client.logout();
            } catch (err) {
                this.log('Logout failed (may not have been logged in):', err.message);
            }

            // Create new client with updated settings
            this.initClient({
                username: newSettings.username,
                password: newSettings.password,
                country: newSettings.region || 'cz' // map region to country if needed, or stick to convention
            });

            // Attempt to login with new credentials
            await this.connect();
        }

        // Handle debug logging toggle
        if (changedKeys.includes('enable_logging')) {
            this.log('Debug logging is now:', newSettings.enable_logging ? 'enabled' : 'disabled');
        }
    }

    startPolling() {
        const settings = this.getSettings();

        // Clear existing intervals
        if (this.pollingIntervalGeneral) clearInterval(this.pollingIntervalGeneral);
        if (this.pollingIntervalSlots) clearInterval(this.pollingIntervalSlots);

        // General Data Interval (Cart, Orders, etc.) - Default 1 min
        const generalMinutes = settings.polling_interval_general || 1;
        this.log(`Starting General Polling: ${generalMinutes} min`);
        this.pollingIntervalGeneral = setInterval(() => this.updateGeneralData(), generalMinutes * 60000);

        // Slots Data Interval - Default 15 min
        const slotsMinutes = settings.polling_interval_slots || 15;
        this.log(`Starting Slots Polling: ${slotsMinutes} min`);
        this.pollingIntervalSlots = setInterval(() => this.updateSlotsData(), slotsMinutes * 60000);

        // Initial fetch
        this.updateData();
    }

    async updateData() {
        // Trigger both updates immediately (e.g. onInit or reconnect)
        await Promise.all([
            this.updateGeneralData(),
            this.updateSlotsData()
        ]);
    }

    async updateGeneralData() {
        if (!this.client.userId) return;

        try {
            // 1. Cart
            const cart = await this.client.getCartContent();
            await this.setCapabilityValue('measure_cart_total', cart.totalPrice);
            await this.setCapabilityValue('measure_cart_items', cart.totalItems);

            // 2. Upcoming Orders
            const upcoming = await this.client.getUpcomingOrders();
            let hasUpcomingOrder = false;

            if (upcoming && upcoming.length > 0) {
                const nextOrder = upcoming[0];
                const now = new Date();
                let diffMins = 0;

                // If deliveryUnixTime exists (from previous observation/code)
                if (nextOrder.deliveryUnixTime) {
                    const deliveryTime = new Date(nextOrder.deliveryUnixTime * 1000);
                    const diffMs = deliveryTime - now;
                    diffMins = Math.floor(diffMs / 60000);
                } else if (nextOrder.deliveryTime) {
                    // If it comes as ISO string
                    const deliveryTime = new Date(nextOrder.deliveryTime);
                    const diffMs = deliveryTime - now;
                    diffMins = Math.floor(diffMs / 60000);
                }

                // await this.setCapabilityValue('measure_next_delivery_eta', diffMins > 0 ? diffMins : 0);
                hasUpcomingOrder = true;

                // Trigger courier approaching
                if (nextOrder.state === 'Delivering' || (diffMins > 0 && diffMins < 15)) {
                    if (!this.lastCourierWarning || (now - this.lastCourierWarning > 30 * 60 * 1000)) {
                        this.homey.flow.getTriggerCard('courier_approaching')
                            .trigger(this, { eta: diffMins })
                            .catch(this.error);
                        this.lastCourierWarning = now;
                    }
                }
            } else {
                // await this.setCapabilityValue('measure_next_delivery_eta', 0);
            }

            // 3. Delivery Status Announcement Logic
            // Fetch annoucements to determine status
            try {
                const deliveryAnnouncements = await this.client.getDeliveryAnnouncements();

                let shipmentState = 'no_upcoming_order'; // Default

                if (deliveryAnnouncements && deliveryAnnouncements.announcements && deliveryAnnouncements.announcements.length > 0) {
                    // Check the first announcement (assuming top one is relevant or only one exists for delivery context)
                    const announcement = deliveryAnnouncements.announcements[0];

                    if (announcement.icon === 'iconDeliveryCar') {
                        shipmentState = 'delivery';
                    } else if (announcement.icon === 'iconProducts') {
                        shipmentState = 'preparing_bags';
                    }
                    // If existing, we can assume some valid state for an order, 
                    // but user specifically mentioned "No active order in response" -> empty response or no announcements.
                }

                await this.setCapabilityValue('string_next_delivery_status', shipmentState);

            } catch (statusErr) {
                this.error('Failed to update delivery status:', statusErr);
                // Fallback if call fails but we knew about order? 
                // Maybe keep old value or set unknown. 
                // For now, let's reset to no_upcoming if completely failed might be safer or do nothing.
            }

            // 4. Reusable Bags Logic
            try {
                const bagsInfo = await this.client.getReusableBagsInfo();
                if (bagsInfo && typeof bagsInfo.current === 'number') {
                    await this.setCapabilityValue('measure_reusable_bags', bagsInfo.current);
                }
            } catch (bagsErr) {
                this.error('Failed to update reusable bags:', bagsErr);
            }

        } catch (err) {
            this.error('Update General Data failed', err);
        }
    }

    async updateSlotsData() {
        if (!this.client.userId) return;

        try {
            const deliverySlots = await this.client.getDeliverySlots();

            // Handle Express Delivery Slots
            if (deliverySlots && deliverySlots.expressSlot) {
                const express = deliverySlots.expressSlot;
                const capacity = express.timeSlotCapacityDTO;

                if (capacity) {
                    const isAvailable = capacity.totalFreeCapacityPercent > 0;
                    await this.setCapabilityValue('alarm_slots_available', isAvailable);
                    await this.setCapabilityValue('delivery_express', capacity.capacityMessage || 'Unknown');
                }
            } else {
                await this.setCapabilityValue('alarm_slots_available', false);
                await this.setCapabilityValue('delivery_express', 'Nedostupné');
            }

            // Handle Preselected Slots (Common & Eco)
            if (deliverySlots && deliverySlots.preselectedSlots && Array.isArray(deliverySlots.preselectedSlots)) {
                // Common Delivery (FIRST)
                const firstSlot = deliverySlots.preselectedSlots.find(s => s.type === 'FIRST');
                if (firstSlot && firstSlot.subtitle) {
                    const commonText = firstSlot.subtitle.replace(/^\(|\)$/g, '');
                    await this.setCapabilityValue('delivery_common', commonText);
                } else {
                    await this.setCapabilityValue('delivery_common', 'Nedostupné');
                }

                // Eco Delivery (ECO)
                const ecoSlot = deliverySlots.preselectedSlots.find(s => s.type === 'ECO');
                if (ecoSlot && ecoSlot.subtitle) {
                    const ecoText = ecoSlot.subtitle.replace(/^\(|\)$/g, '');
                    await this.setCapabilityValue('delivery_eco', ecoText);
                } else {
                    await this.setCapabilityValue('delivery_eco', 'Nedostupné');
                }
            } else {
                await this.setCapabilityValue('delivery_common', 'Nedostupné');
                await this.setCapabilityValue('delivery_eco', 'Nedostupné');
            }

        } catch (err) {
            this.error('Update Slots Data failed', err);
        }
    }

    // --- Flow Actions ---

    async onFlowActionAddItemAutocomplete(query, args) {
        if (!query) return [];
        try {
            const results = await this.client.searchProducts(query);
            // format: { name, description, icon, id }
            return results.map(p => ({
                name: p.name,
                description: `${p.price} ${p.currency} (${p.brand})`,
                id: p.id,
                // icon: p.image // If remote URL supported? Yes.
            }));
        } catch (err) {
            this.error(err);
            return [];
        }
    }

    async onFlowActionAddItem(args, state) {
        // args.product is { id, name ... }
        if (!args.product || !args.product.id) throw new Error('No product selected');

        const quantity = args.pieces && args.pieces > 0 ? args.pieces : 1;
        await this.client.addToCart(args.product.id, quantity);

        // Update cart immediately
        await this.updateData();
    }

    async onFlowActionRemoveItemAutocomplete(query, args) {
        // List items in cart
        try {
            const cart = await this.client.getCartContent();
            const items = cart.items;

            // Filter by query
            const filtered = items.filter(i =>
                i.name.toLowerCase().includes(query.toLowerCase())
            );

            return filtered.map(i => ({
                name: i.name,
                description: `${i.quantity}x ${i.price} ${i.currency}`,
                id: i.cart_item_id // Use orderFieldId for removal
            }));
        } catch (err) {
            this.error(err);
            return [];
        }
    }

    async onFlowActionRemoveItem(args, state) {
        if (!args.product_in_cart || !args.product_in_cart.id) throw new Error('No item selected');

        // Full removal (API doesn't support partial removal)
        await this.client.removeFromCart(args.product_in_cart.id);

        await this.updateData();
    }

    async onFlowActionGetProductId(args, state) {
        if (!args.product || !args.product.id) throw new Error('No product selected');

        return {
            product_id: String(args.product.id)
        };
    }

    async onFlowActionGetCartContent(args, state) {
        const cart = await this.client.getCartContent();

        if (!cart.items || cart.items.length === 0) {
            return { cart_content: 'Košík je prázdný' };
        }

        const contentText = cart.items.map(item =>
            `${item.name}, ${item.quantity} ks, ${item.pricePerUnit || item.price} Kč`
        ).join('; ');

        return { cart_content: contentText };
    }

    async onFlowActionAddItemById(args, state) {
        if (!args.product_id) throw new Error('No product ID provided');

        const quantity = args.pieces && args.pieces > 0 ? args.pieces : 1;
        await this.client.addToCart(args.product_id, quantity);

        await this.updateData();
    }

    async onFlowActionRemoveItemById(args, state) {
        if (!args.product_id) throw new Error('No product ID provided');

        // Find cart item by product ID
        const cart = await this.client.getCartContent();
        const item = cart.items.find(i => i.id === args.product_id || i.id === String(args.product_id));

        if (!item) throw new Error('Product not found in cart');

        await this.client.removeFromCart(item.cart_item_id);
        await this.updateData();
    }

    async onFlowActionTestApiMethod(args, state) {
        const method = args.method;
        this.log(`Testing API method: ${method}`);

        if (typeof this.client[method] !== 'function') {
            throw new Error(`Method ${method} not found in RohlikClient`);
        }

        try {
            const result = await this.client[method]();
            this.log(`Method ${method} success. Result logged in RohlikClient.`);
            return true;
        } catch (err) {
            this.error(`Method ${method} failed:`, err);
            throw err;
        }
    }

};
