const Homey = require('homey');

class RohlikApp extends Homey.App {
  async onInit() {
    this.log('RohlikApp has been initialized');
  }
}

module.exports = RohlikApp;
