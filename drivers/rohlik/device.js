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

        // Register refresh_data action
        const refreshDataCard = this.homey.flow.getActionCard('refresh_data');
        refreshDataCard.registerRunListener(async (args, state) => {
            this.log('Manual refresh triggered via Flow');
            return this.updateData();
        });

        // Register Conditions
        this.homey.flow.getConditionCard('delivery_status_is')
            .registerRunListener((args, state) => this.onFlowConditionDeliveryStatusIs(args, state));

        this.homey.flow.getConditionCard('delivery_eta_compare')
            .registerRunListener((args, state) => this.onFlowConditionDeliveryEtaCompare(args, state));

        this.homey.flow.getConditionCard('express_slots_available')
            .registerRunListener((args, state) => this.onFlowConditionExpressSlotsAvailable(args, state));


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
            await this.updateCapabilityValue('measure_reusable_bags', count).catch(this.error);
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

    onDeleted() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        if (this.deliveryPollingInterval) {
            clearInterval(this.deliveryPollingInterval);
        }
        this.log('RohlikDevice deleted, intervals cleared');
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        this.log('Settings changed:', changedKeys);

        // Check if login-related settings changed
        const loginSettingsChanged = changedKeys.some(key =>
            ['username', 'password', 'region'].includes(key)
        );

        // Check if polling intervals changed
        const pollingChanged = changedKeys.includes('polling_interval');

        if (pollingChanged) {
            this.log('Polling interval changed, restarting timer...');
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

        // Clear existing interval
        if (this.pollingInterval) clearInterval(this.pollingInterval);

        // Update Interval - Default 10 min
        const intervalMinutes = settings.polling_interval || 10;
        this.log(`Starting Polling: ${intervalMinutes} min`);
        this.pollingInterval = setInterval(() => this.updateData(), intervalMinutes * 60000);

        // Initial fetch
        this.updateData();
    }

    manageDeliveryPolling(status) {
        if (status === 'delivery') {
            if (!this.deliveryPollingInterval) {
                this.log('Starting fast delivery polling (1 min)');
                this.deliveryPollingInterval = setInterval(() => this.updateDeliveryStatusOnly(), 60 * 1000);
            }
        } else {
            if (this.deliveryPollingInterval) {
                this.log('Stopping fast delivery polling');
                clearInterval(this.deliveryPollingInterval);
                this.deliveryPollingInterval = null;
            }
        }
    }

    async updateDeliveryStatusOnly() {
        if (!this.client.userId) return;

        try {
            const deliveryAnnouncements = await this.client.getDeliveryAnnouncements();
            let shipmentState = 'no_upcoming_order';
            let eta = 0;

            if (deliveryAnnouncements && deliveryAnnouncements.announcements && deliveryAnnouncements.announcements.length > 0) {
                const announcement = deliveryAnnouncements.announcements[0];
                if (announcement.icon === 'iconDeliveryCar') {
                    shipmentState = 'delivery';
                    if (announcement.content) {
                        const match = announcement.content.match(/<span[^>]*>(\d+)<\/span>/);
                        if (match && match[1]) {
                            eta = parseInt(match[1], 10);
                        }
                    }
                } else if (announcement.icon === 'iconProducts') {
                    shipmentState = 'preparing_bags';
                }
            }

            await this.updateCapabilityValue('string_next_delivery_status', shipmentState);
            await this.updateCapabilityValue('measure_next_delivery_eta', eta);

            // Update polling state based on result
            this.manageDeliveryPolling(shipmentState);

        } catch (err) {
            this.error('Delivery status update failed:', err);
        }
    }

    async updateCapabilityValue(capabilityId, value) {
        const currentValue = this.getCapabilityValue(capabilityId);

        // strict check might fail for objects, but capabilities are usually primitives. 
        // For logic consistency:
        if (currentValue !== value) {
            await this.setCapabilityValue(capabilityId, value).catch(this.error);
        }
    }

    async updateData() {
        try {
            // Trigger both updates
            await Promise.all([
                this.updateGeneralData(),
                this.updateSlotsData()
            ]);

            this.setAvailable();
        } catch (err) {
            this.error('Update failed:', err);
            this.setUnavailable(err.message || 'Update failed');

            this.homey.flow.getTriggerCard('error_occurred')
                .trigger(this, { error: err.message || 'Unknown error' })
                .catch(this.error);
        }
    }

    async updateGeneralData() {
        if (!this.client.userId) return;

        // 1. Cart
        const cart = await this.client.getCartContent();
        await this.updateCapabilityValue('measure_cart_total', cart.totalPrice);
        await this.updateCapabilityValue('measure_cart_items', cart.totalItems);

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

            hasUpcomingOrder = true;


        }

        // 3. Delivery Status Announcement Logic
        const deliveryAnnouncements = await this.client.getDeliveryAnnouncements();

        let shipmentState = 'no_upcoming_order'; // Default
        let eta = 0;

        if (deliveryAnnouncements && deliveryAnnouncements.announcements && deliveryAnnouncements.announcements.length > 0) {
            // Check the first announcement
            const announcement = deliveryAnnouncements.announcements[0];

            if (announcement.icon === 'iconDeliveryCar') {
                shipmentState = 'delivery';
                if (announcement.content) {
                    const match = announcement.content.match(/<span[^>]*>(\d+)<\/span>/);
                    if (match && match[1]) {
                        eta = parseInt(match[1], 10);
                    }
                }
            } else if (announcement.icon === 'iconProducts') {
                shipmentState = 'preparing_bags';
            }
        }

        await this.updateCapabilityValue('string_next_delivery_status', shipmentState);
        await this.updateCapabilityValue('measure_next_delivery_eta', eta);

        // Manage fast polling based on status
        this.manageDeliveryPolling(shipmentState);

        // 4. Reusable Bags Logic
        const bagsInfo = await this.client.getReusableBagsInfo();
        if (bagsInfo && typeof bagsInfo.current === 'number') {
            await this.updateCapabilityValue('measure_reusable_bags', bagsInfo.current);
        }
    }

    async updateSlotsData() {
        if (!this.client.userId) return;

        const deliverySlots = await this.client.getDeliverySlots();

        // Handle Express Delivery Slots
        if (deliverySlots && deliverySlots.expressSlot) {
            const express = deliverySlots.expressSlot;
            const capacity = express.timeSlotCapacityDTO;

            if (capacity) {
                const isAvailable = capacity.totalFreeCapacityPercent > 0;
                await this.updateCapabilityValue('alarm_slots_available', isAvailable);
                await this.updateCapabilityValue('delivery_express', capacity.capacityMessage || 'Unknown');
            }
        } else {
            await this.updateCapabilityValue('alarm_slots_available', false);
            await this.updateCapabilityValue('delivery_express', 'Nedostupné');
        }

        // Handle Preselected Slots (Common & Eco)
        if (deliverySlots && deliverySlots.preselectedSlots && Array.isArray(deliverySlots.preselectedSlots)) {
            // Common Delivery (FIRST)
            const firstSlot = deliverySlots.preselectedSlots.find(s => s.type === 'FIRST');
            if (firstSlot && firstSlot.subtitle) {
                const commonText = firstSlot.subtitle.replace(/^\(|\)$/g, '');
                await this.updateCapabilityValue('delivery_common', commonText);
            } else {
                await this.updateCapabilityValue('delivery_common', 'Nedostupné');
            }

            // Eco Delivery (ECO)
            const ecoSlot = deliverySlots.preselectedSlots.find(s => s.type === 'ECO');
            if (ecoSlot && ecoSlot.subtitle) {
                const ecoText = ecoSlot.subtitle.replace(/^\(|\)$/g, '');
                await this.updateCapabilityValue('delivery_eco', ecoText);
            } else {
                await this.updateCapabilityValue('delivery_eco', 'Nedostupné');
            }
        } else {
            await this.updateCapabilityValue('delivery_common', 'Nedostupné');
            await this.updateCapabilityValue('delivery_eco', 'Nedostupné');
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

    async onFlowConditionDeliveryStatusIs(args, state) {
        const currentStatus = this.getCapabilityValue('string_next_delivery_status');
        const targetStatus = args.status.id || args.status;
        return currentStatus === targetStatus;
    }

    async onFlowConditionDeliveryEtaCompare(args, state) {
        const currentEta = this.getCapabilityValue('measure_next_delivery_eta') || 0;
        const targetEta = args.minutes;
        const operator = args.operator.id || args.operator;

        switch (operator) {
            case '<': return currentEta < targetEta;
            case '=': return currentEta === targetEta;
            case '>': return currentEta > targetEta;
            default: return false;
        }
    }

    async onFlowConditionExpressSlotsAvailable(args, state) {
        return this.getCapabilityValue('alarm_slots_available') === true;
    }

};
