import { SoundBasePlugin, runPlugin } from '@soundbase/plugin-shell';
import * as adapter from './adapter.js';

// The shell bootstrap. Byte-identical across every plugin: it wires whichever
// module factories adapter.js exports and nothing else, so a plugin that only
// serves spectrum analyzers, or only monitored devices, uses this same file.
class Plugin extends SoundBasePlugin {
  // The one thing this plugin has to say about itself as a whole: a Lab
  // install carries the engine's source and no binary, because the engine has
  // to be compiled against the UHD on this machine. So the plugin builds it,
  // and reports progress as its own status — where the user is already
  // looking. Never throws; never blocks the host. See driver/engine-build.js.
  async init(pluginConfig) {
    await this.reportEngine(pluginConfig);
  }

  async configUpdated(pluginConfig) {
    await this.reportEngine(pluginConfig);
  }

  async reportEngine(pluginConfig) {
    const { reconcileEngine } = await import('./driver/engine-build.js');
    const decided = reconcileEngine(pluginConfig, (status, message) =>
      this.updateStatus(status, message)
    );
    if (decided === 'building') this.log('info', 'building the sweep engine');
  }

  async discoverDevices() {
    return adapter.discoverDevices?.(this.config) ?? [];
  }
}

if (typeof adapter.createSpectrumAnalyzerAdapter === 'function') {
  Plugin.prototype.createSpectrumAnalyzerAdapter = function (device) {
    return adapter.createSpectrumAnalyzerAdapter(device, this.config);
  };
}

if (typeof adapter.createMonitoringAdapter === 'function') {
  Plugin.prototype.createMonitoringAdapter = function (device) {
    return adapter.createMonitoringAdapter(device, this.config);
  };
}

export default runPlugin(Plugin, {
  manifestPath: new URL('./soundbase-plugin.json', import.meta.url),
});
