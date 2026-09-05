import { SoundBasePlugin, runPlugin } from '@soundbase/plugin-shell';
import { createSpectrumAnalyzerAdapter, discoverDevices } from './adapter.js';

class Plugin extends SoundBasePlugin {
  // The one thing this plugin has to say about itself as a whole: a Lab
  // install carries the engine's source but not a binary, so until it is built
  // there are no devices and nothing to explain why. Surface that as the
  // plugin's own status, where the user is already looking. Never throws:
  // ticking "Simulate a radio" or setting "Engine binary" clears it.
  async init(pluginConfig) {
    await this.reportEngine(pluginConfig);
  }

  async configUpdated(pluginConfig) {
    await this.reportEngine(pluginConfig);
  }

  async reportEngine(pluginConfig) {
    const { engineStatus } = await import('./driver/locate.js');
    const { ok, message } = engineStatus(pluginConfig);
    this.updateStatus(ok ? 'ok' : 'bad-config', message);
  }

  async discoverDevices() {
    return discoverDevices(this.config);
  }

  createSpectrumAnalyzerAdapter(device) {
    return createSpectrumAnalyzerAdapter(device, this.config);
  }
}

export default runPlugin(Plugin, {
  manifestPath: new URL('./soundbase-plugin.json', import.meta.url),
});
