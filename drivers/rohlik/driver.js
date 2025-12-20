const Homey = require('homey');
const RohlikClient = require('../../lib/RohlikClient');

module.exports = class RohlikDriver extends Homey.Driver {

    async onInit() {
        this.log('RohlikDriver has been initialized');
    }

    async onPair(session) {
        this.log('onPair session started');
        let credentials = {};

        session.setHandler('login', async (data) => {
            this.log('Login request received', data);
            const client = new RohlikClient({
                username: data.username,
                password: data.password,
                country: data.country,
                logger: this.log.bind(this)
            });

            try {
                await client.login();
                this.log('Login success');
                // Store credentials for the next step
                credentials = {
                    username: data.username,
                    password: data.password,
                    country: data.country
                };
                return true; // Success
            } catch (err) {
                this.error('Login failed', err);
                throw new Error(err.message || 'Login failed');
            }
        });

        session.setHandler('list_devices', async () => {
            this.log('list_devices request received');

            if (!credentials.username) {
                this.error('No credentials found');
                throw new Error('Please log in first');
            }

            const device = {
                name: 'Rohlik Account',
                data: {
                    id: 'rohlik_' + credentials.username
                },
                settings: {
                    username: credentials.username,
                    password: credentials.password,
                    country: credentials.country
                }
            };

            this.log('Returning device:', device);
            return [device];
        });
    }
};
