#!/usr/bin/env node
// What the plugin's discovery sees, without SoundBase in the way.
//
//   npm run find
//
// This is the first thing to run when a radio does not appear in SoundBase: it
// uses exactly the same enumeration the plugin does, so an empty list here is a
// UHD or cabling problem rather than a plugin problem.

import { discoverDevices } from '../adapter.js';
import { BUILD_HINT, IMAGES_HINT, resolveEngineBinary } from '../driver/locate.js';

const pluginConfig = {};
const binPath = resolveEngineBinary(pluginConfig);
if (!binPath) {
  process.stderr.write(`no sweep engine binary: ${BUILD_HINT}\n`);
  process.exit(1);
}
process.stdout.write(`engine: ${binPath}\n`);

const devices = await discoverDevices(pluginConfig);
if (devices.length === 0) {
  // Without the firmware image UHD's find returns nothing for a B2xx — the
  // radio powers up (orange LED) but is never programmed.
  process.stdout.write(
    'no USRP found.\n' +
      '  · is it plugged in, and into a port that gives it enough power?\n' +
      '  · does `uhd_find_devices` see it?\n' +
      '  · are the FPGA images there? `uhd_config_info --images-dir` must name a folder with usrp_b200_fw.hex in it.\n' +
      `    If it is blank, ${IMAGES_HINT}\n`
  );
  process.exit(1);
}
for (const device of devices) {
  process.stdout.write(`${device.id}  ${device.name}\n`);
}
